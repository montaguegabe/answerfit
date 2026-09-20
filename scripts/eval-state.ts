/**
 * User-state accuracy eval (PROPOSAL §8.1): forward-chaining prediction of
 * held-out future behavior, comparing the FSRS-style state model against the
 * legacy recency-weighted sigmoid.
 *
 * Protocol: for each qualifying evidence event e_i (the outcome), predict from
 * all events strictly before it (chronological prefix, decayed to e_i's time).
 * The event's direction sign is the outcome label: positive (used correctly /
 * troubleshooting / advanced question) vs negative (confusion / remedial
 * seeking). Only clearly-directional events (|direction| >= 0.3) count as
 * outcomes; weak/incidental events still inform the prefix state.
 *
 * Caveat: outcome labels come from Jev's per-event interpretation, so this
 * measures agreement with future *labeled* behavior, not ground truth — but
 * prediction uses strictly past events, so there is no temporal leakage.
 *
 * Metrics per PROPOSAL §8.1: log loss, Brier, AUC, binned calibration RMSE,
 * and false-mastery vs false-ignorance reported separately.
 *
 * Usage: npm run eval-state [-- --user gabe]
 */
import "../lib/env";
import { db } from "../lib/db";
import { computeState, type EvidenceRow } from "../lib/mastery";

const userId = (() => {
  const i = process.argv.indexOf("--user");
  return i >= 0 ? process.argv[i + 1] : "gabe";
})();

const OUTCOME_MIN_DIRECTION = 0.3;
const MIN_PREFIX = 3; // need some history before predictions count
const BEHAVIORAL_SOURCES = new Set([
  "google_search",
  "google_visit",
  "youtube_search",
  "youtube_watch",
  "claude_code",
  "codex",
  "post_answer_search",
]);

// ---- legacy model (pre-FSRS lib/mastery.ts), reimplemented for comparison ----
const LEGACY_TAU = 270;
const SOURCE_WEIGHT: Record<string, number> = {
  persona_seed: 1.0, feedback: 1.2, app_interaction: 0.9, google_search: 0.7,
  google_visit: 0.4, youtube_search: 0.6, youtube_watch: 0.35, claude_code: 0.95,
  codex: 0.95, post_answer_search: 1.1,
};
function legacyMastery(evidence: EvidenceRow[], now: Date): number {
  let signed = 0;
  for (const e of evidence) {
    const ageDays = Math.max(0, (now.getTime() - new Date(e.ts).getTime()) / 86_400_000);
    const w = (SOURCE_WEIGHT[e.source] ?? 0.5) * e.strength * Math.exp(-ageDays / LEGACY_TAU);
    signed += Math.sign(e.direction) * Math.abs(e.direction) * w;
  }
  return 1 / (1 + Math.exp(-1.4 * signed));
}

// ---- metrics ----
interface Pred { p: number; y: 0 | 1 }
const clamp = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logLoss = (P: Pred[]) => P.reduce((s, { p, y }) => s - (y ? Math.log(clamp(p)) : Math.log(1 - clamp(p))), 0) / P.length;
const brier = (P: Pred[]) => P.reduce((s, { p, y }) => s + (p - y) ** 2, 0) / P.length;
function auc(P: Pred[]): number {
  const pos = P.filter((x) => x.y === 1).map((x) => x.p);
  const neg = P.filter((x) => x.y === 0).map((x) => x.p);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
function calibRmse(P: Pred[], bins = 10): { rmse: number; table: string[] } {
  const table: string[] = [];
  let sq = 0, used = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const inBin = P.filter((x) => x.p >= lo && (b === bins - 1 ? x.p <= hi : x.p < hi));
    if (inBin.length < 5) continue;
    const pAvg = inBin.reduce((s, x) => s + x.p, 0) / inBin.length;
    const yAvg = inBin.reduce((s, x) => s + x.y, 0) / inBin.length;
    sq += (pAvg - yAvg) ** 2 * inBin.length;
    used += inBin.length;
    table.push(`    [${lo.toFixed(1)},${hi.toFixed(1)}) n=${String(inBin.length).padStart(5)} predicted=${pAvg.toFixed(2)} observed=${yAvg.toFixed(2)}`);
  }
  return { rmse: Math.sqrt(sq / used), table };
}
function asymmetry(P: Pred[]) {
  const conf = P.filter((x) => x.p >= 0.8);
  const ign = P.filter((x) => x.p <= 0.2);
  return {
    false_mastery: conf.length ? conf.filter((x) => x.y === 0).length / conf.length : NaN,
    n_confident: conf.length,
    false_ignorance: ign.length ? ign.filter((x) => x.y === 1).length / ign.length : NaN,
    n_ignorant: ign.length,
  };
}

// ---- run ----
const rows = db()
  .prepare(
    `SELECT concept_id, id, ts, source, raw_text, dimension, direction, strength, interpretation, judge
     FROM events WHERE user_id = ? ORDER BY concept_id, ts`
  )
  .all(userId) as (EvidenceRow & { concept_id: string })[];

const byConcept = new Map<string, EvidenceRow[]>();
for (const r of rows) {
  if (!byConcept.has(r.concept_id)) byConcept.set(r.concept_id, []);
  byConcept.get(r.concept_id)!.push(r);
}

const predsNew: Pred[] = [];
const predsOld: Pred[] = [];
const predsBase: Pred[] = [];
let outcomes = 0;
const t0 = Date.now();
for (const [, evs] of byConcept) {
  for (let i = MIN_PREFIX; i < evs.length; i++) {
    const e = evs[i];
    if (!BEHAVIORAL_SOURCES.has(e.source)) continue;
    if (Math.abs(e.direction) < OUTCOME_MIN_DIRECTION) continue;
    const y: 0 | 1 = e.direction > 0 ? 1 : 0;
    const prefix = evs.slice(0, i);
    const at = new Date(e.ts);
    predsNew.push({ p: computeState(prefix, at).mastery, y });
    predsOld.push({ p: legacyMastery(prefix, at), y });
    predsBase.push({ p: 0.5, y });
    outcomes++;
  }
}

const baseRate = predsNew.reduce((s, x) => s + x.y, 0) / predsNew.length;
console.log(`user=${userId}  concepts=${byConcept.size}  outcome events=${outcomes}  base rate P(y=1)=${baseRate.toFixed(3)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);

for (const [name, P] of [
  ["FSRS state (current)", predsNew],
  ["legacy sigmoid", predsOld],
  ["constant 0.5", predsBase],
] as const) {
  const { rmse, table } = calibRmse(P);
  const asym = asymmetry(P);
  console.log(`${name}`);
  console.log(`  log loss=${logLoss(P).toFixed(4)}  brier=${brier(P).toFixed(4)}  AUC=${auc(P).toFixed(4)}  calib RMSE=${rmse.toFixed(4)}`);
  console.log(`  false-mastery=${(asym.false_mastery * 100).toFixed(1)}% of ${asym.n_confident} confident-known preds · false-ignorance=${(asym.false_ignorance * 100).toFixed(1)}% of ${asym.n_ignorant} confident-unknown preds`);
  if (name !== "constant 0.5") for (const l of table) console.log(l);
  console.log();
}
