/**
 * Parameter sweep for the FSRS-style state model (learned-dynamics-lite,
 * PROPOSAL §7 item 1): grid over prior asymmetry and negative-evidence weight,
 * scored on the same forward-chaining protocol as eval-state.ts.
 *
 * Rationale from eval-state findings: base rate P(next directional event is
 * positive)=0.866, so the symmetric 0.5 prior drags mid-range predictions low
 * (predicted 0.55 → observed 0.80); and remedial searches often *precede*
 * learning, so negative evidence may deserve less weight than positive.
 *
 * Note: this tunes and scores on the same user's history (in-sample). Fine for
 * picking sane defaults; honest generalization needs a second user's ledger.
 */
import "../lib/env";
import { db } from "../lib/db";
import type { EvidenceRow } from "../lib/mastery";

const FACTOR = 19 / 81, DECAY_W = 0.5, S0 = 14, S_MIN = 4, S_MAX = 1825, GROW = 0.9, LAPSE = 0.4;
const SOURCE_WEIGHT: Record<string, number> = {
  persona_seed: 1.0, feedback: 1.2, app_interaction: 0.9, google_search: 0.7,
  google_visit: 0.4, youtube_search: 0.6, youtube_watch: 0.35, claude_code: 0.95,
  codex: 0.95, post_answer_search: 1.1,
};
const retention = (dt: number, S: number) => (dt <= 0 ? 1 : Math.pow(1 + (FACTOR * dt) / S, -DECAY_W));

interface Params { priorPos: number; priorNeg: number; negW: number }

function masteryP(p: Params, evidence: EvidenceRow[], now: Date): number {
  const chrono = [...evidence].sort((a, b) => a.ts.localeCompare(b.ts));
  let S = S0, pos = 0, neg = 0, prevT: number | null = null;
  for (const e of chrono) {
    const t = new Date(e.ts).getTime();
    if (Number.isNaN(t)) continue;
    const dt = prevT === null ? 0 : Math.max(0, (t - prevT) / 86_400_000);
    const R = retention(dt, S);
    pos *= R; neg *= R;
    const w = (SOURCE_WEIGHT[e.source] ?? 0.5) * e.strength * Math.abs(e.direction);
    if (e.direction > 0) { S = Math.min(S_MAX, S * (1 + GROW * w * (1 - R))); pos += w; }
    else if (e.direction < 0) { S = Math.max(S_MIN, S * (1 - Math.min(0.9, LAPSE * w))); neg += w * p.negW; }
    prevT = t;
  }
  const dtNow = prevT === null ? 0 : Math.max(0, (now.getTime() - prevT) / 86_400_000);
  const rNow = retention(dtNow, S);
  pos *= rNow; neg *= rNow;
  return (pos + p.priorPos) / (pos + neg + p.priorPos + p.priorNeg);
}

// ---- outcomes (same protocol as eval-state.ts) ----
const BEHAVIORAL = new Set(["google_search","google_visit","youtube_search","youtube_watch","claude_code","codex","post_answer_search"]);
const rows = db().prepare(
  `SELECT concept_id, id, ts, source, raw_text, dimension, direction, strength, interpretation, judge
   FROM events WHERE user_id = 'gabe' ORDER BY concept_id, ts`
).all() as (EvidenceRow & { concept_id: string })[];
const byConcept = new Map<string, EvidenceRow[]>();
for (const r of rows) {
  if (!byConcept.has(r.concept_id)) byConcept.set(r.concept_id, []);
  byConcept.get(r.concept_id)!.push(r);
}
const cases: { prefix: EvidenceRow[]; at: Date; y: 0 | 1 }[] = [];
for (const [, evs] of byConcept) {
  for (let i = 3; i < evs.length; i++) {
    const e = evs[i];
    if (!BEHAVIORAL.has(e.source) || Math.abs(e.direction) < 0.3) continue;
    cases.push({ prefix: evs.slice(0, i), at: new Date(e.ts), y: e.direction > 0 ? 1 : 0 });
  }
}
console.log(`${cases.length} outcome cases`);

const clamp = (x: number) => Math.min(1 - 1e-6, Math.max(1e-6, x));
function score(p: Params) {
  let ll = 0, sq = 0;
  const bins: { p: number; y: number; n: number }[] = Array.from({ length: 10 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const c of cases) {
    const pr = masteryP(p, c.prefix, c.at);
    ll -= c.y ? Math.log(clamp(pr)) : Math.log(1 - clamp(pr));
    const b = Math.min(9, Math.floor(pr * 10));
    bins[b].p += pr; bins[b].y += c.y; bins[b].n++;
  }
  let csq = 0, cn = 0;
  for (const b of bins) if (b.n >= 5) { csq += (b.p / b.n - b.y / b.n) ** 2 * b.n; cn += b.n; }
  return { logLoss: ll / cases.length, calib: Math.sqrt(csq / cn) };
}

const results: { p: Params; logLoss: number; calib: number }[] = [];
for (const priorPos of [0.5, 1.0, 1.5])
  for (const priorNeg of [0.2, 0.35, 0.5])
    for (const negW of [0.6, 1.0, 1.4]) {
      const p = { priorPos, priorNeg, negW };
      results.push({ p, ...score(p) });
    }
results.sort((a, b) => a.logLoss - b.logLoss);
console.log("\ntop 8 by log loss (current prod = priorPos 0.5, priorNeg 0.5, negW 1.0):");
for (const r of results.slice(0, 8))
  console.log(`  priorPos=${r.p.priorPos} priorNeg=${r.p.priorNeg} negW=${r.p.negW}  logLoss=${r.logLoss.toFixed(4)} calibRMSE=${r.calib.toFixed(4)}`);
const prod = results.find((r) => r.p.priorPos === 0.5 && r.p.priorNeg === 0.5 && r.p.negW === 1.0)!;
console.log(`  [prod baseline]                          logLoss=${prod.logLoss.toFixed(4)} calibRMSE=${prod.calib.toFixed(4)}`);
