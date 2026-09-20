/**
 * Taxonomy induction (smaller-plan Day 1 step 2, done properly): batched
 * Fable passes over a sample of real searches + chat messages induce new
 * concepts and alias extensions, merged into taxonomy/concepts.json.
 * The hand-written entries survive as the seed; demo-critical ids are never
 * removed or renamed.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import "../lib/env";
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const TAXONOMY_PATH = path.join(process.cwd(), "taxonomy", "concepts.json");
const NOISE = /\b(song|lyrics|theme song|trailer|simpsons|episode|funny|meme|music video|movie|netflix|recipe|weather|sports|nfl|nba|mlb)\b/i;
const CHUNKS = 3;
const CHUNK_SIZE = 1000;

// Deterministic shuffle so re-runs sample identically.
function seededShuffle<T>(arr: T[], seed = 42): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function readJsonl(file: string): Promise<any[]> {
  const out: any[] = [];
  if (!fs.existsSync(file)) return out;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

async function collectSample(): Promise<string[]> {
  const g = (await readJsonl("data/google-search-history.jsonl"))
    .filter((r) => r.action === "Searched for" && r.title && !NOISE.test(r.title))
    .map((r) => `SEARCH: ${r.title}`);
  const y = (await readJsonl("data/youtube-search-history.jsonl"))
    .filter((r) => r.action === "Searched for" && r.title && !NOISE.test(r.title))
    .map((r) => `SEARCH: ${r.title}`);
  const c = (await readJsonl("data/chat-history.jsonl")).map(
    (r) => `CHAT: ${r.user_text.slice(0, 200).replace(/\s+/g, " ")}`
  );
  const dedupe = (xs: string[]) => [...new Set(xs)];
  const sample = [
    ...seededShuffle(dedupe(g)).slice(0, 1400),
    ...seededShuffle(dedupe(y)).slice(0, 300),
    ...seededShuffle(dedupe(c)).slice(0, 1300),
  ];
  return seededShuffle(sample);
}

interface InducedConcept {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  viz: string;
  prereqs: string[];
}

const SCHEMA = {
  type: "object",
  required: ["new_concepts", "alias_additions"],
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
    alias_additions: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "aliases"],
        properties: { id: { type: "string" }, aliases: { type: "array", items: { type: "string" } } },
      },
    },
  },
};

const GENERIC_ALIAS_BLOCKLIST = new Set([
  "code", "data", "error", "errors", "test", "tests", "app", "apps", "file", "files", "server",
  "python", "javascript", "js", "api", "bug", "issue", "install", "update", "mac", "google",
  "search", "video", "youtube", "claude", "chatgpt", "openai", "ai", "model", "agent", "build",
]);

async function main() {
  const taxonomy = JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf-8"));
  const client = new Anthropic();
  const sample = await collectSample();
  console.log(`Sampled ${sample.length} deduped events (searches + chat)`);

  for (let chunk = 0; chunk < CHUNKS; chunk++) {
    const lines = sample.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE);
    if (lines.length === 0) break;
    const existingIds = taxonomy.concepts.map((c: any) => c.id);
    const existingSummary = taxonomy.concepts.map((c: any) => `${c.id}: ${c.name}`).join("\n");

    console.log(`Chunk ${chunk + 1}/${CHUNKS}: ${lines.length} events → Fable…`);
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16384,
      system: `You induce a concept taxonomy for a personal learner model from a user's real search queries and AI-chat messages. The taxonomy powers two things: (a) matching history events to concepts via alias phrases, (b) deciding at read-time whether a technical concept in an AI answer needs explaining to this user.

Produce NEW learning-relevant technical concepts evidenced by the sample, plus alias additions to EXISTING concepts. Rules:
- Mid-granularity: "kubernetes networking" not "computers"; not one concept per query either. Prefer concepts several events touch.
- id: "<category>.<snake_slug>". Reuse existing category prefixes when they fit; invent new categories when needed.
- aliases: phrases someone would literally type in a search or chat (lowercase, >=4 chars, 1-4 words). NEVER generic single words like "code", "error", "app", "python", "model" — an alias must be specific enough that matching it implies the concept.
- viz: best teaching representation (git_dag=graph topology, timeline=temporal ordering/concurrency, sequence=multi-party interactions, code=API/syntax, prose=otherwise).
- prereqs: ids from existing+new concepts only.
- Skip: entertainment, shopping, navigation-to-site queries, personal/private matters (health, finance, relationships, travel logistics), and one-off trivia. Only durable technical/learnable concepts.
- Up to 40 new concepts per pass. Quality over coverage.

EXISTING CONCEPTS (do not re-create; extend aliases instead):
${existingSummary}`,
      messages: [{ role: "user", content: `Sample of the user's history:\n\n${lines.join("\n")}` }],
      tools: [{ name: "report_taxonomy", description: "Return induced taxonomy changes.", input_schema: SCHEMA as any }],
      tool_choice: { type: "tool", name: "report_taxonomy" },
    });
    const tu = res.content.find((b) => b.type === "tool_use") as any;
    const { new_concepts, alias_additions } = tu.input as { new_concepts: InducedConcept[]; alias_additions: { id: string; aliases: string[] }[] };

    const allAliases = new Set(
      taxonomy.concepts.flatMap((c: any) => c.aliases.map((a: string) => a.toLowerCase()))
    );
    const cleanAliases = (aliases: string[] | undefined) =>
      (aliases ?? [])
        .map((a) => a.toLowerCase().trim())
        .filter((a) => a.length >= 4 && !GENERIC_ALIAS_BLOCKLIST.has(a) && !allAliases.has(a))
        .filter((a) => (allAliases.add(a), true));

    let added = 0, aliased = 0;
    for (const nc of new_concepts) {
      if (existingIds.includes(nc.id)) continue;
      const aliases = cleanAliases(nc.aliases);
      if (aliases.length === 0) continue;
      taxonomy.concepts.push({
        id: nc.id,
        name: nc.name,
        aliases,
        category: nc.category,
        viz: ["prose", "code", "git_dag", "timeline", "sequence"].includes(nc.viz) ? nc.viz : "prose",
        prereqs: (nc.prereqs ?? []).filter((p) => existingIds.includes(p) || new_concepts.some((x) => x.id === p)),
        source: "induced",
      });
      added++;
    }
    for (const aa of alias_additions) {
      const c = taxonomy.concepts.find((x: any) => x.id === aa.id);
      if (!c) continue;
      const extra = cleanAliases(aa.aliases);
      if (extra.length) { c.aliases.push(...extra); aliased++; }
    }
    console.log(`  +${added} concepts, ${aliased} concepts got new aliases (total now ${taxonomy.concepts.length})`);
  }

  fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2));
  console.log(`Wrote ${TAXONOMY_PATH} with ${taxonomy.concepts.length} concepts.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
