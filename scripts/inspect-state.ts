/** Spot-check tool (smaller-plan Day 1 checkpoint): what does this user know? */
import "../lib/env";
import { db } from "../lib/db";

const userId = process.argv[2] || "gabe";
const rows = db()
  .prepare(
    `SELECT cs.concept_id, c.name, cs.mastery, cs.confidence, cs.evidence_count
     FROM concept_state cs JOIN concepts c ON c.id = cs.concept_id
     WHERE cs.user_id = ? ORDER BY cs.mastery DESC`
  )
  .all(userId) as any[];

console.log(`Concept state for ${userId}:`);
for (const r of rows) {
  const bar = "█".repeat(Math.round(r.mastery * 20)).padEnd(20, "·");
  console.log(`  ${bar} ${r.mastery.toFixed(2)} conf=${r.confidence.toFixed(2)} n=${String(r.evidence_count).padStart(4)}  ${r.name}`);
}

const cid = process.argv[3];
if (cid) {
  console.log(`\nTop evidence for ${cid}:`);
  const ev = db()
    .prepare(`SELECT ts, source, raw_text, direction, strength, interpretation, judge FROM events WHERE user_id=? AND concept_id=? ORDER BY ts DESC LIMIT 15`)
    .all(userId, cid) as any[];
  for (const e of ev) {
    console.log(`  ${e.ts}  ${e.source.padEnd(14)} dir=${String(e.direction).padStart(5)} s=${e.strength.toFixed(2)} [${e.interpretation}/${e.judge}] ${e.raw_text?.slice(0, 70)}`);
  }
}
