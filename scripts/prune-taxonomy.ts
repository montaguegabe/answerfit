/**
 * Subsume/retire pass: let the data decide which hand-written seed concepts
 * survive. Fable proposes (a) near-duplicate merges and (b) retirement of
 * seed concepts with negligible real evidence. Guardrails in code:
 *  - only seed concepts can be retired (induced ones came from the data)
 *  - concepts matched by the real demo samples are protected
 *  - prereq references are rewritten, never left dangling
 */
import fs from "fs";
import path from "path";
import "../lib/env";
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { matchConcepts } from "../lib/taxonomy";

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const TAXONOMY_PATH = path.join(process.cwd(), "taxonomy", "concepts.json");

async function main() {
  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf-8"));
  const db = new Database(path.join(process.cwd(), "db", "answerfit.db"));
  const counts = new Map<string, number>(
    (db.prepare("SELECT concept_id, COUNT(*) n FROM events WHERE user_id='gabe' GROUP BY concept_id").all() as any[]).map(
      (r) => [r.concept_id, r.n]
    )
  );

  const protectedIds = new Set<string>();
  const rs = path.join(process.cwd(), "data", "real-samples.json");
  if (fs.existsSync(rs)) {
    for (const s of JSON.parse(fs.readFileSync(rs, "utf-8")).samples) {
      for (const c of matchConcepts(s.text)) protectedIds.add(c.id);
    }
  }

  const inventory = taxonomy.concepts.map((c: any) => ({
    id: c.id,
    name: c.name,
    origin: c.source === "induced" ? "induced" : "seed",
    evidence_rows: counts.get(c.id) ?? 0,
    protected: protectedIds.has(c.id),
  }));

  const client = new Anthropic();
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    system: `You prune a personal concept taxonomy so it reflects only what the user's real behavioral data supports. "seed" concepts were hand-written by a developer; "induced" concepts were derived from the user's actual history. evidence_rows counts real matched history events.

Propose:
1. merges: pairs where a seed and an induced concept (or two concepts) cover essentially the same idea — merge the weaker into the better-supported one.
2. retire: SEED concepts with negligible evidence (roughly < 5 rows) that are not marked protected and are not natural prerequisites of well-supported concepts. Be aggressive: a hand-invented concept the user's data never touches should go.

Never retire induced or protected concepts. Do not retire something merely because it is basic — retire it because the data does not support it.`,
    messages: [{ role: "user", content: JSON.stringify(inventory, null, 1) }],
    tools: [
      {
        name: "prune",
        description: "Return merges and retirements.",
        input_schema: {
          type: "object",
          required: ["merges", "retire"],
          properties: {
            merges: {
              type: "array",
              items: {
                type: "object",
                required: ["from", "into", "reason"],
                properties: { from: { type: "string" }, into: { type: "string" }, reason: { type: "string" } },
              },
            },
            retire: { type: "array", items: { type: "string" } },
          },
        } as any,
      },
    ],
    tool_choice: { type: "tool", name: "prune" },
  });
  const tu = res.content.find((b) => b.type === "tool_use") as any;
  const merges: { from: string; into: string; reason: string }[] = tu.input.merges ?? [];
  const retire: string[] = tu.input.retire ?? [];

  const byId = new Map(taxonomy.concepts.map((c: any) => [c.id, c]));
  const isSeed = (id: string) => byId.has(id) && (byId.get(id) as any).source !== "induced";
  const removed = new Map<string, string>(); // removed id -> replacement ("" = retired)

  // Resolve merge proposals cycle-safely: on A→B plus B→A (or longer chains),
  // the concept with more evidence survives; everything else maps to it.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const m of merges) {
    if (!byId.has(m.from) || !byId.has(m.into) || m.from === m.into || protectedIds.has(m.from)) continue;
    const a = find(m.from);
    const b = find(m.into);
    if (a === b) continue; // already same group (cycle) — skip
    // Union: root = better-supported (protected beats counts)
    const score = (id: string) => (protectedIds.has(id) ? 1e9 : counts.get(id) ?? 0);
    const [loser, winner] = score(a) >= score(b) ? [b, a] : [a, b];
    parent.set(loser, winner);
  }
  for (const id of [...byId.keys()]) {
    const root = find(id);
    if (root === id) continue;
    const from = byId.get(id) as any;
    const into = byId.get(root) as any;
    into.aliases.push(...from.aliases.filter((a: string) => !into.aliases.includes(a)));
    into.prereqs = [...new Set([...(into.prereqs ?? []), ...(from.prereqs ?? [])])].filter((p: string) => p !== root);
    removed.set(id, root);
    console.log(`merge  ${id} → ${root}`);
  }
  for (const id of retire) {
    if (!isSeed(id) || protectedIds.has(id) || removed.has(id)) continue;
    if ((counts.get(id) ?? 0) >= 8) continue; // data overrules the model
    removed.set(id, "");
    console.log(`retire ${id}  (${counts.get(id) ?? 0} evidence rows)`);
  }

  taxonomy.concepts = taxonomy.concepts.filter((c: any) => !removed.has(c.id));
  for (const c of taxonomy.concepts) {
    c.prereqs = (c.prereqs ?? [])
      .map((p: string) => (removed.has(p) ? removed.get(p) : p))
      .filter((p: string) => p && taxonomy.concepts.some((x: any) => x.id === p));
    c.prereqs = [...new Set(c.prereqs)].filter((p) => p !== c.id);
    if (c.contrasts) c.contrasts = c.contrasts.filter((x: string) => !removed.has(x) || removed.get(x));
  }
  fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2));
  console.log(`Taxonomy: ${taxonomy.concepts.length} concepts remain (${removed.size} merged/retired). Protected: ${[...protectedIds].length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
