/**
 * Mine real demo samples: find concept-dense, self-contained explanatory
 * assistant messages in the user's actual Claude Code / Codex transcripts,
 * have Fable pick the best three, write data/real-samples.json.
 */
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import "../lib/env";
import Anthropic from "@anthropic-ai/sdk";
import { matchConcepts } from "../lib/taxonomy";

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const OUT = path.join(process.cwd(), "data", "real-samples.json");

interface Candidate {
  ts: string;
  source: string;
  session: string;
  text: string;
  concepts: string[];
  score: number;
}

const EXPLAIN_MARKERS = /\b(because|this means|the (fix|problem|issue|reason|difference)|in other words|which is why|note that|the key (is|point|insight)|instead of|rather than|under the hood)\b/i;
const JUNKY = /(^\s*\{|\btool_use\b|<system|```json|\|\s*---\s*\||^\s*#\s|file_path|"type":)/m;

async function* assistantMessages(): AsyncGenerator<{ ts: string; source: string; session: string; text: string }> {
  // Claude Code
  const croot = path.join(os.homedir(), ".claude", "projects");
  for (const dir of fs.readdirSync(croot)) {
    const p = path.join(croot, dir);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) {
      if (!f.endsWith(".jsonl")) continue;
      const rl = readline.createInterface({ input: fs.createReadStream(path.join(p, f)), crlfDelay: Infinity });
      for await (const line of rl) {
        try {
          const r = JSON.parse(line);
          if (r.type !== "assistant" || r.isMeta || !r.message || !r.timestamp) continue;
          const c = r.message.content;
          const text = Array.isArray(c) ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") : "";
          if (text) yield { ts: r.timestamp, source: "claude_code", session: f.replace(".jsonl", ""), text };
        } catch {}
      }
    }
  }
  // Codex
  const xroot = path.join(os.homedir(), ".codex", "sessions");
  if (fs.existsSync(xroot)) {
    const files: string[] = [];
    (function walk(d: string) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (f.endsWith(".jsonl")) files.push(p);
      }
    })(xroot);
    for (const file of files) {
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        try {
          const r = JSON.parse(line);
          const pl = r.payload;
          if (r.type !== "response_item" || !pl || pl.type !== "message" || pl.role !== "assistant" || !r.timestamp) continue;
          const text = Array.isArray(pl.content)
            ? pl.content.filter((b: any) => b.type === "output_text").map((b: any) => b.text).join("\n")
            : "";
          if (text) yield { ts: r.timestamp, source: "codex", session: path.basename(file, ".jsonl"), text };
        } catch {}
      }
    }
  }
}

async function main() {
  const candidates: Candidate[] = [];
  let scanned = 0;
  for await (const m of assistantMessages()) {
    scanned++;
    const t = m.text.trim();
    if (t.length < 700 || t.length > 3000) continue;
    if (JUNKY.test(t)) continue;
    const concepts = matchConcepts(t).map((c) => c.id);
    if (concepts.length < 3) continue;
    const markers = (t.match(EXPLAIN_MARKERS) || []).length;
    if (markers === 0) continue;
    const codeRatio = ((t.match(/```/g) || []).length * 200) / t.length;
    candidates.push({
      ...m,
      text: t,
      concepts,
      score: concepts.length * 2 + markers - codeRatio * 3,
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 40);
  console.log(`Scanned ${scanned} assistant messages → ${candidates.length} candidates, sending top ${top.length} to Fable`);

  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `You pick demo material for a personalization app: the user pastes an AI assistant's answer and the app re-renders it per reader. From the numbered candidate excerpts (all real answers this user received from coding assistants), pick the THREE best demo samples.

Selection criteria, in order:
1. Self-contained: understandable without the surrounding conversation, no dangling references to files/output "above".
2. Concept-dense: explains or uses several distinct technical concepts a reader might or might not know.
3. Diverse: the three picks should cover different domains and suit different visualizations (graph topology / temporal-concurrency / multi-party interaction / code mechanics).
4. Prose-forward: mostly explanation, not a wall of code or a status report.

For each pick give the candidate index and a short title like "Why the rebase loops (from Claude Code)".`,
    messages: [
      {
        role: "user",
        content: top.map((c, i) => `--- CANDIDATE ${i} (${c.source}, ${c.ts.slice(0, 10)}, concepts: ${c.concepts.join(", ")}) ---\n${c.text}`).join("\n\n"),
      },
    ],
    tools: [
      {
        name: "pick_samples",
        description: "Return the three chosen samples.",
        input_schema: {
          type: "object",
          required: ["picks"],
          properties: {
            picks: {
              type: "array",
              items: {
                type: "object",
                required: ["index", "title"],
                properties: { index: { type: "integer" }, title: { type: "string" } },
              },
            },
          },
        } as any,
      },
    ],
    tool_choice: { type: "tool", name: "pick_samples" },
  });
  const tu = res.content.find((b) => b.type === "tool_use") as any;
  const picks: { index: number; title: string }[] = tu.input.picks.slice(0, 3);

  const samples = picks.map((p, i) => {
    const c = top[p.index];
    return {
      id: `real-${i + 1}`,
      title: p.title,
      text: c.text,
      source: c.source,
      session: c.session,
      ts: c.ts,
      concepts: c.concepts,
    };
  });
  fs.writeFileSync(OUT, JSON.stringify({ samples }, null, 2));
  for (const s of samples) console.log(`✔ ${s.title} [${s.source} ${s.ts.slice(0, 10)}] concepts: ${s.concepts.join(", ")}`);
  console.log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
