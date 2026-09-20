import { db } from "./db";

/**
 * Learner State Engine, FSRS-style (PROPOSAL.md §2: memory has dynamics, not
 * a boolean). Replaces the recency-weighted sigmoid aggregation with a
 * chronological walk maintaining:
 *
 *   stability S     — how durable this concept's memory is (days). Grows with
 *                     positive evidence — more when the memory was fading
 *                     (desirable difficulty, FSRS stabilization curve) — and
 *                     shrinks on lapses (negative evidence).
 *   retrievability R — power-law retention (FSRS-6 shape) applied to the
 *                     accumulated evidence mass between events and to "now".
 *   mastery         — Beta-style posterior pos/(pos+neg) with a symmetric
 *                     prior, so zero evidence → 0.5 and nothing pegs at 1.0.
 *   confidence      — saturating function of *decayed* evidence mass, so 200
 *                     stale events no longer read as certainty.
 *
 * Fixes vs. the previous aggregation (observed on the full-history backfill):
 * 52/146 concepts pegged at exactly mastery=1.00 conf=1.00; no within-known
 * discrimination; exponential decay with a fixed 270-day tau regardless of how
 * consolidated the concept was. Old negative evidence (e.g. 2018 remedial
 * searches) now fades to the 0.5 prior instead of permanently implying
 * ignorance.
 *
 * State is still always recomputable from the immutable events log, and the
 * public interface (computeState / getEvidence / refreshState / getState /
 * addEvidence) is unchanged; stability_days and retrievability are additive.
 */

// FSRS-6 power-law retention shape: R(dt) = (1 + FACTOR*dt/S)^(-DECAY_W).
const FACTOR = 19 / 81;
const DECAY_W = 0.5;
const S0 = 14; // initial stability (days) on first evidence
const S_MIN = 4;
const S_MAX = 1825;
const GROW = 0.9; // stability growth rate on positive evidence
const LAPSE = 0.4; // stability shrink rate on negative evidence
// Beta prior, evidence-conditional (tuned by scripts/tune-state.ts on 18,685
// forward-chained outcomes from gabe's ledger: log loss 0.428→0.367, calib
// RMSE 0.156→0.012 vs the symmetric prior; in-sample — revisit with more users).
// A concept the user has real history with has prior mean ≈ the observed 0.87
// base rate of next-directional-event-positive; a cold concept stays at 0.5 so
// unknown concepts are never presumed known (false-mastery guard).
const PRIOR_POS_MAX = 1.5;
const PRIOR_NEG_MIN = 0.2;
const CONF_TAU = 2.0; // evidence mass at which confidence ≈ 0.63

const SOURCE_WEIGHT: Record<string, number> = {
  persona_seed: 1.0,
  feedback: 1.2, // explicit user correction outweighs inferred behavior
  app_interaction: 0.9,
  google_search: 0.7,
  google_visit: 0.4,
  youtube_search: 0.6,
  youtube_watch: 0.35,
  claude_code: 0.95, // typed thoughts to an assistant: high-signal
  codex: 0.95,
  chat_app: 0.95, // typed into AnswerFit /chat (no transcript backing — never wiped by backfill)
  doc_edit: 0.9, // manual git-attributed doc edits (scripts/mine-doc-edits.ts)
  post_answer_search: 1.1, // assistant explained it, user searched it anyway
};

export interface EvidenceRow {
  id: number;
  ts: string;
  source: string;
  raw_text: string | null;
  dimension: string;
  direction: number;
  strength: number;
  interpretation: string | null;
  judge: string;
}

export interface ConceptStateRow {
  concept_id: string;
  mastery: number;
  confidence: number;
  evidence_count: number;
  last_positive: string | null;
  last_negative: string | null;
  stability_days: number;
  retrievability: number;
}

function retention(dtDays: number, stability: number): number {
  if (dtDays <= 0) return 1;
  return Math.pow(1 + (FACTOR * dtDays) / stability, -DECAY_W);
}

export function computeState(
  evidence: EvidenceRow[],
  now: Date = new Date()
): Omit<ConceptStateRow, "concept_id"> {
  const chrono = [...evidence].sort((a, b) => a.ts.localeCompare(b.ts));

  let S = S0;
  let posMass = 0;
  let negMass = 0;
  let rawMass = 0; // undecayed: how much evidence has EVER existed (drives the prior)
  let prevT: number | null = null;
  let lastPos: string | null = null;
  let lastNeg: string | null = null;

  for (const e of chrono) {
    const t = new Date(e.ts).getTime();
    if (Number.isNaN(t)) continue;
    const dt = prevT === null ? 0 : Math.max(0, (t - prevT) / 86_400_000);
    const R = retention(dt, S);
    posMass *= R;
    negMass *= R;

    const w = (SOURCE_WEIGHT[e.source] ?? 0.5) * e.strength * Math.abs(e.direction);
    rawMass += w;
    if (e.direction > 0) {
      // Stabilization: spaced successes (low R) consolidate more than massed ones.
      S = Math.min(S_MAX, S * (1 + GROW * w * (1 - R)));
      posMass += w;
      if (!lastPos || e.ts > lastPos) lastPos = e.ts;
    } else if (e.direction < 0) {
      S = Math.max(S_MIN, S * (1 - Math.min(0.9, LAPSE * w)));
      negMass += w;
      if (!lastNeg || e.ts > lastNeg) lastNeg = e.ts;
    }
    prevT = t;
  }

  // Decay accumulated mass from the last evidence to now.
  const dtNow = prevT === null ? 0 : Math.max(0, (now.getTime() - prevT) / 86_400_000);
  const rNow = retention(dtNow, S);
  posMass *= rNow;
  negMass *= rNow;

  const g = 1 - Math.exp(-rawMass); // 0 (cold) → 1 (real history)
  const priorPos = 0.5 + (PRIOR_POS_MAX - 0.5) * g;
  const priorNeg = 0.5 - (0.5 - PRIOR_NEG_MIN) * g;
  const mastery = (posMass + priorPos) / (posMass + negMass + priorPos + priorNeg);
  const confidence = 1 - Math.exp(-(posMass + negMass) / CONF_TAU);
  return {
    mastery,
    confidence,
    evidence_count: evidence.length,
    last_positive: lastPos,
    last_negative: lastNeg,
    stability_days: Math.round(S * 10) / 10,
    retrievability: Math.round(rNow * 1000) / 1000,
  };
}

export function getEvidence(userId: string, conceptId: string, limit = 500): EvidenceRow[] {
  return db()
    .prepare(
      `SELECT id, ts, source, raw_text, dimension, direction, strength, interpretation, judge
       FROM events WHERE user_id = ? AND concept_id = ? ORDER BY ts DESC LIMIT ?`
    )
    .all(userId, conceptId, limit) as EvidenceRow[];
}

/** Recompute + persist derived state for one (user, concept). */
export function refreshState(userId: string, conceptId: string): ConceptStateRow {
  const state = computeState(getEvidence(userId, conceptId));
  db()
    .prepare(
      `INSERT OR REPLACE INTO concept_state
       (user_id, concept_id, mastery, confidence, evidence_count, last_positive, last_negative, stability_days, retrievability, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      conceptId,
      state.mastery,
      state.confidence,
      state.evidence_count,
      state.last_positive,
      state.last_negative,
      state.stability_days,
      state.retrievability,
      new Date().toISOString()
    );
  return { concept_id: conceptId, ...state };
}

export function getState(userId: string, conceptId: string): ConceptStateRow {
  const row = db()
    .prepare(
      `SELECT concept_id, mastery, confidence, evidence_count, last_positive, last_negative,
              COALESCE(stability_days, ${S0}) stability_days, COALESCE(retrievability, 1.0) retrievability
       FROM concept_state WHERE user_id = ? AND concept_id = ?`
    )
    .get(userId, conceptId) as ConceptStateRow | undefined;
  if (row) return row;
  // No cached row: derive on the fly (also covers concepts with zero evidence).
  return { concept_id: conceptId, ...computeState(getEvidence(userId, conceptId)) };
}

export function addEvidence(row: {
  userId: string;
  conceptId: string;
  ts: string;
  source: string;
  rawText?: string;
  dimension?: string;
  direction: number;
  strength: number;
  interpretation?: string;
  judge?: string;
}) {
  db()
    .prepare(
      `INSERT INTO events (user_id, concept_id, ts, source, raw_text, dimension, direction, strength, interpretation, judge)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.userId,
      row.conceptId,
      row.ts,
      row.source,
      row.rawText ?? null,
      row.dimension ?? "recognition",
      row.direction,
      row.strength,
      row.interpretation ?? null,
      row.judge ?? "heuristic"
    );
}
