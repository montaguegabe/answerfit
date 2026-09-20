/** Recompute all concept_state rows from the immutable events log (all users). */
import "../lib/env";
import { db } from "../lib/db";
import { refreshState } from "../lib/mastery";

const d = db();
const pairs = d
  .prepare("SELECT DISTINCT user_id, concept_id FROM events")
  .all() as { user_id: string; concept_id: string }[];

const t0 = Date.now();
const byUser = new Map<string, number>();
for (const p of pairs) {
  refreshState(p.user_id, p.concept_id);
  byUser.set(p.user_id, (byUser.get(p.user_id) ?? 0) + 1);
}
for (const [u, n] of byUser) console.log(`${u}: ${n} concept states recomputed`);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
