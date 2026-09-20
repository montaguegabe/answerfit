import fs from "fs";
import path from "path";
import readline from "readline";
import Anthropic from "@anthropic-ai/sdk";
import { db, kvGet, kvSet } from "./db";
import { taxonomy, matchConcepts, registerConcepts, deriveAliases, type RegisterCandidate } from "./taxonomy";

/**
 * Standing concept discovery: the one-shot induce-taxonomy turned into an
 * incremental loop, so the vocabulary tracks what the user is actually
 * learning instead of aging from its induction date.
 *
 *  1. promoteOrphans(): every new.* concept ever minted by extraction joins
 *     the registry (idempotent).
 *  2. runDiscovery(): unmatched-but-technical recent messages (live-captured
 *     queue + fresh jsonl history since the cursor) → Fable proposes concepts
 *     → alias merge dedupes against the registry.
 */

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const CHUNK = 400;
const MAX_PER_RUN = 1200;

export function promoteOrphans(): { added: string[]; merged: Record<string, string> } {
  const minted = new Map<string, { name: string; viz: string; prereqs: string[] }>();
  const harvest = (concepts: any[]) => {
    for (const c of concepts) {
      if (c?.id?.startsWith("new.") && !minted.has(c.id)) {
        minted.set(c.id, { name: c.name, viz: c.viz_hint ?? c.viz ?? "prose", prereqs: c.prereqs ?? [] });
      }
    }
  };
  for (const r of db().prepare("SELECT value FROM model_cache WHERE kind='extract'").all() as { value: string }[]) {
    try { harvest(JSON.parse(r.value).concepts ?? []); } catch {}
  }
  for (const r of db().prepare("SELECT result FROM feed WHERE result IS NOT NULL").all() as { result: string }[]) {
    try { harvest((JSON.parse(r.result).blocks ?? []).map((b: any) => b.concept)); } catch {}
  }
  const candidates: RegisterCandidate[] = [...minted.entries()].map(([id, m]) => ({
    id,
    name: m.name,
    aliases: deriveAliases(id, m.name),
    category: "discovered",
    viz: (["prose", "code", "git_dag", "timeline", "sequence"].includes(m.viz) ? m.viz : "prose") as any,
    prereqs: m.prereqs,
    source: "promoted",
  }));
  return registerConcepts(candidates);
}

async function* jsonlSince(file: string, sinceTs: string): AsyncGenerator<{ ts: string; text: string; source: string }> {
  const p = path.join(process.cwd(), "data", file);
  if (!fs.existsSync(p)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      const ts = r.ts ?? r.timestamp;
      const text = r.user_text ?? (r.action === "Searched for" ? r.title : null);
      if (ts && text && ts > sinceTs) yield { ts, text, source: r.source ?? "google_search" };
    } catch {}
  }
}

const PROPOSE_SCHEMA = {
  type: "object",
  required: ["new_concepts"],
  properties: {
    new_concepts: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "aliases", "category", "viz", "prereqs"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          category: { type: "string" },
          viz: { enum: ["prose", "code", "git_dag", "timeline", "sequence"] },
          prereqs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export interface DiscoveryReport {
  scanned: number;
  proposed: number;
  added: string[];
  merged: number;
}

export async function runDiscovery(): Promise<DiscoveryReport> {
  if (kvGet("discovery_running") === "1") return { scanned: 0, proposed: 0, added: [], merged: 0 };
  kvSet("discovery_running", "1");
  try {
    promoteOrphans();

    // First run: only the recent past — deep history was induction's job.
    const cursor = kvGet("discovery_cursor") ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const inputs: { text: string; source: string }[] = [];
    const seen = new Set<string>();
    let maxTs = cursor;

    const NOISE = /\b(song|lyrics|theme song|trailer|simpsons|episode|funny|meme|music video|movie|netflix|recipe|weather|sports|nfl|nba|mlb)\b/i;
    const consider = (ts: string, text: string, source: string) => {
      if (ts > maxTs) maxTs = ts;
      const t = text.trim();
      if (t.length < 12 || t.length > 400 || NOISE.test(t)) return;
      if (matchConcepts(t).length > 0) return; // already homed
      const key = t.toLowerCase().slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      inputs.push({ text: t, source });
    };

    for (const row of db()
      .prepare("SELECT id, ts, text, source FROM unmatched_messages WHERE processed = 0 ORDER BY id LIMIT ?")
      .all(MAX_PER_RUN) as any[]) {
      consider(row.ts, row.text, row.source);
    }
    for await (const m of jsonlSince("chat-history.jsonl", cursor)) consider(m.ts, m.text, m.source);
    for await (const m of jsonlSince("google-search-history.jsonl", cursor)) consider(m.ts, m.text, m.source);

    const sample = inputs.slice(0, MAX_PER_RUN);
    let proposed = 0;
    const allAdded: string[] = [];
    let mergedCount = 0;

    if (sample.length >= 20) {
      const client = new Anthropic();
      for (let i = 0; i < sample.length; i += CHUNK) {
        const lines = sample.slice(i, i + CHUNK).map((s) => `${s.source === "google_search" ? "SEARCH" : "CHAT"}: ${s.text.replace(/\s+/g, " ").slice(0, 200)}`);
        const existingSummary = taxonomy().map((c) => `${c.id}: ${c.name}`).join("\n");
        const res = await client.messages.create({
          model: MODEL,
          max_tokens: 8192,
          system: `You maintain a personal concept taxonomy for a learner model. These recent search queries and AI-chat messages matched NO existing concept. Propose durable technical/learnable concepts they evidence, so future events can accumulate on them.

Rules:
- Mid-granularity; prefer concepts several events touch. Skip entertainment, shopping, navigation queries, personal matters, one-off trivia.
- id: "<category>.<snake_slug>" reusing existing category prefixes where they fit.
- aliases: phrases someone would literally type (lowercase, >=4 chars, 1-4 words, specific — never generic single words like "code", "error", "model").
- viz: best teaching representation. prereqs: existing ids only.
- Up to 25 concepts per pass; quality over coverage. Propose NOTHING for noise.

EXISTING CONCEPTS (do not re-create):
${existingSummary}`,
          messages: [{ role: "user", content: lines.join("\n") }],
          tools: [{ name: "propose_concepts", description: "Return proposed concepts.", input_schema: PROPOSE_SCHEMA as any }],
          tool_choice: { type: "tool", name: "propose_concepts" },
        });
        const tu = res.content.find((b) => b.type === "tool_use") as any;
        const rawProps = tu?.input?.new_concepts ?? [];
        const proposals = (Array.isArray(rawProps) ? rawProps : Object.values(rawProps)) as any[];
        proposed += proposals.length;
        const { added, merged } = registerConcepts(
          proposals.map((p) => ({
            id: p.id,
            name: p.name,
            aliases: p.aliases ?? [],
            category: p.category ?? "discovered",
            viz: p.viz ?? "prose",
            prereqs: p.prereqs ?? [],
            source: "discovered" as const,
          }))
        );
        allAdded.push(...added);
        mergedCount += Object.keys(merged).length;
      }
    }

    db().prepare("UPDATE unmatched_messages SET processed = 1 WHERE processed = 0").run();
    kvSet("discovery_cursor", maxTs);
    kvSet("discovery_last_run", new Date().toISOString());
    return { scanned: sample.length, proposed, added: allAdded, merged: mergedCount };
  } finally {
    kvSet("discovery_running", "0");
  }
}

/** Cheap trigger check for the capture path: enough backlog + not too recent. */
export function maybeTriggerDiscovery() {
  const backlog = (db().prepare("SELECT COUNT(*) n FROM unmatched_messages WHERE processed = 0").get() as any).n;
  if (backlog < 150) return;
  const last = kvGet("discovery_last_run");
  if (last && Date.now() - new Date(last).getTime() < 60 * 60 * 1000) return;
  void runDiscovery()
    .then((r) => console.log(`[discovery] scanned=${r.scanned} proposed=${r.proposed} added=${r.added.length} merged=${r.merged}`))
    .catch((e) => console.error("[discovery]", e));
}
