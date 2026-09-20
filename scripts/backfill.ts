/**
 * Backfill the learner state from real history (smaller-plan Day 1).
 *
 * 1. Stream data/*.jsonl, drop notifications/nulls and obvious non-learning noise.
 * 2. Alias-match each event against the concept taxonomy.
 * 3. Interpret matched events (Jev by default; --heuristic-only to skip API).
 * 4. Write evidence rows + recompute concept_state for user "gabe".
 *
 * Usage: npm run backfill [-- --heuristic-only] [-- --limit N]
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import "../lib/env";
import { db } from "../lib/db";
import { matchConcepts, taxonomy } from "../lib/taxonomy";
import {
  interpretEvent,
  interpretChatEvent,
  CONFUSION,
  type RawHistoryEvent,
  type ChatEvent,
} from "../lib/interpret";
import { mapConcurrent } from "../lib/models/jev";
import { refreshState } from "../lib/mastery";

const USER_ID = "gabe";
const args = process.argv.slice(2);
const useJev = !args.includes("--heuristic-only");
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;

// Obvious non-learning noise (music, entertainment) — cheap keyword pre-filter.
const NOISE = /\b(song|lyrics|theme song|trailer|simpsons|episode|funny|meme|music video|movie|netflix|recipe|weather|sports|nfl|nba|mlb)\b/i;

const FILES: { file: string; source: RawHistoryEvent["source"] | "auto" }[] = [
  { file: "google-search-history.jsonl", source: "auto" },
  { file: "youtube-search-history.jsonl", source: "youtube_search" },
  { file: "youtube-watch-history.jsonl", source: "youtube_watch" },
];

interface Candidate {
  kind: "history" | "chat";
  ev?: RawHistoryEvent;
  chat?: ChatEvent;
  conceptIds: string[];
  conceptInUserText?: boolean; // chat only: false = attributed via preceding assistant message
}

async function collectCandidates(): Promise<{ candidates: Candidate[]; scanned: number; filtered: number }> {
  const candidates: Candidate[] = [];
  let scanned = 0;
  let filtered = 0;
  for (const { file, source } of FILES) {
    const p = path.join(process.cwd(), "data", file);
    if (!fs.existsSync(p)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      scanned++;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!rec.title || !rec.timestamp) continue; // notifications / malformed
      if (!["Searched for", "Visited", "Watched"].includes(rec.action)) continue;
      if (NOISE.test(rec.title)) continue;
      const src: RawHistoryEvent["source"] =
        source !== "auto" ? source : rec.action === "Visited" ? "google_visit" : "google_search";
      const concepts = matchConcepts(rec.title);
      if (concepts.length === 0) continue;
      filtered++;
      candidates.push({
        kind: "history",
        ev: { action: rec.action, title: rec.title, timestamp: rec.timestamp, source: src },
        conceptIds: concepts.map((c) => c.id),
      });
      if (candidates.length >= limit) return { candidates, scanned, filtered };
    }
  }

  // Chat transcripts: concepts in the user's own words, or — for confusion
  // messages with no concept mention — attributed to the assistant's
  // preceding message (detailed-plan's attribution problem, simplified).
  const chatPath = path.join(process.cwd(), "data", "chat-history.jsonl");
  if (fs.existsSync(chatPath)) {
    const rl = readline.createInterface({ input: fs.createReadStream(chatPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      scanned++;
      let rec: ChatEvent;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      let concepts = matchConcepts(rec.user_text);
      let inUserText = true;
      if (concepts.length === 0 && CONFUSION.test(rec.user_text) && rec.prev_assistant_tail) {
        concepts = matchConcepts(rec.prev_assistant_tail).slice(0, 3);
        inUserText = false;
      }
      if (concepts.length === 0) continue;
      filtered++;
      candidates.push({
        kind: "chat",
        chat: rec,
        conceptIds: concepts.map((c) => c.id).slice(0, 3),
        conceptInUserText: inUserText,
      });
      if (candidates.length >= limit) break;
    }
  }
  return { candidates, scanned, filtered };
}

/**
 * "Explanation didn't land" join: a remedial search shortly after an AI
 * assistant mentioned the same concept is strong evidence the user did not
 * come away understanding it (detailed-plan's merge-storm example).
 */
const DIDNT_LAND_WINDOW_MS = 30 * 60 * 1000;

function joinPostAnswerSearches(userId: string) {
  const mentionsPath = path.join(process.cwd(), "data", "assistant-mentions.jsonl");
  if (!fs.existsSync(mentionsPath)) return 0;
  const mentionsByConcept = new Map<string, number[]>();
  for (const line of fs.readFileSync(mentionsPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const t = new Date(m.ts).getTime();
      for (const cid of m.concepts) {
        if (!mentionsByConcept.has(cid)) mentionsByConcept.set(cid, []);
        mentionsByConcept.get(cid)!.push(t);
      }
    } catch {}
  }
  for (const arr of mentionsByConcept.values()) arr.sort((a, b) => a - b);

  const remedial = db()
    .prepare(
      `SELECT concept_id, ts, raw_text FROM events
       WHERE user_id = ? AND source IN ('google_search','youtube_search')
         AND interpretation = 'seeking_basic_understanding'`
    )
    .all(userId) as { concept_id: string; ts: string; raw_text: string }[];

  let joined = 0;
  for (const r of remedial) {
    const mentions = mentionsByConcept.get(r.concept_id);
    if (!mentions) continue;
    const t = new Date(r.ts).getTime();
    const hit = mentions.some((mt) => mt <= t && t - mt <= DIDNT_LAND_WINDOW_MS);
    if (!hit) continue;
    db()
      .prepare(
        `INSERT INTO events (user_id, concept_id, ts, source, raw_text, dimension, direction, strength, interpretation, judge)
         VALUES (?, ?, ?, 'post_answer_search', ?, 'explain', -1, 0.9, 'explanation_did_not_land', 'heuristic')`
      )
      .run(userId, r.concept_id, r.ts, `Searched "${r.raw_text}" within 30min of an assistant explaining this`);
    joined++;
  }
  return joined;
}

async function main() {
  const d = db();
  d.prepare("INSERT OR REPLACE INTO users (id, name, kind, description) VALUES (?, ?, ?, ?)").run(
    USER_ID,
    "Gabe (real history)",
    "real",
    "Learner state backfilled from real Google/YouTube history"
  );
  for (const c of taxonomy()) {
    d.prepare(
      "INSERT OR REPLACE INTO concepts (id, name, category, viz, prereqs, contrasts, source) VALUES (?, ?, ?, ?, ?, ?, 'seed')"
    ).run(c.id, c.name, c.category, c.viz, JSON.stringify(c.prereqs), JSON.stringify(c.contrasts ?? []));
  }

  console.log("Scanning history files…");
  const { candidates, scanned, filtered } = await collectCandidates();
  console.log(`Scanned ${scanned} events → ${filtered} concept-matched candidates (mode: ${useJev ? "jev" : "heuristic-only"})`);

  // Idempotency: wipe previously backfilled evidence for this user (keep feedback).
  d.prepare("DELETE FROM events WHERE user_id = ? AND source != 'feedback'").run(USER_ID);

  const insert = d.prepare(
    `INSERT INTO events (user_id, concept_id, ts, source, raw_text, dimension, direction, strength, interpretation, judge)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let done = 0;
  const t0 = Date.now();
  await mapConcurrent(candidates, useJev ? 24 : 512, async (cand) => {
    for (const cid of cand.conceptIds) {
      const conceptName = taxonomy().find((c) => c.id === cid)!.name;
      if (cand.kind === "history") {
        const ev = cand.ev!;
        const interp = await interpretEvent(ev, conceptName, useJev);
        insert.run(USER_ID, cid, ev.timestamp, ev.source, ev.title, interp.dimension, interp.direction, interp.strength, interp.interpretation, interp.judge);
      } else {
        const chat = cand.chat!;
        const interp = await interpretChatEvent(chat, conceptName, cand.conceptInUserText!, useJev);
        insert.run(USER_ID, cid, chat.ts, chat.source, chat.user_text.slice(0, 200), interp.dimension, interp.direction, interp.strength, interp.interpretation, interp.judge);
      }
    }
    done++;
    if (done % 250 === 0) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`  ${done}/${candidates.length} interpreted (${rate.toFixed(1)}/s)`);
    }
  });

  const joined = joinPostAnswerSearches(USER_ID);
  console.log(`"Explanation didn't land" joins: ${joined}`);

  console.log("Recomputing concept states…");
  const conceptIds = new Set(candidates.flatMap((c) => c.conceptIds));
  for (const cid of conceptIds) {
    const s = refreshState(USER_ID, cid);
    console.log(
      `  ${cid.padEnd(30)} mastery=${s.mastery.toFixed(2)} conf=${s.confidence.toFixed(2)} n=${s.evidence_count}`
    );
  }
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
