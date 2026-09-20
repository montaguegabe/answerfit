import { db } from "./db";

/**
 * Learner State Engine: mastery is a recency-weighted aggregation over the
 * immutable evidence log (smaller-plan Day 1 step 4 — hand-tuned decay, no
 * learned KT). State is always recomputable from events.
 */

const DECAY_TAU_DAYS = 270; // evidence half-relevance horizon (hand-tuned)
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
}

export function computeState(
  evidence: EvidenceRow[],
  now: Date = new Date()
): Omit<ConceptStateRow, "concept_id"> {
  let signed = 0;
  let weightSum = 0;
  let lastPos: string | null = null;
  let lastNeg: string | null = null;
  for (const e of evidence) {
    const ageDays = Math.max(0, (now.getTime() - new Date(e.ts).getTime()) / 86_400_000);
    const decay = Math.exp(-ageDays / DECAY_TAU_DAYS);
    const w = (SOURCE_WEIGHT[e.source] ?? 0.5) * e.strength * decay;
    signed += Math.sign(e.direction) * Math.abs(e.direction) * w;
    weightSum += w;
    if (e.direction > 0 && (!lastPos || e.ts > lastPos)) lastPos = e.ts;
    if (e.direction < 0 && (!lastNeg || e.ts > lastNeg)) lastNeg = e.ts;
  }
  // Squash accumulated signed evidence into [0,1]; zero evidence → 0.5 prior
  // with zero confidence (the policy treats low-confidence 0.5 as "unknown").
  const mastery = 1 / (1 + Math.exp(-1.4 * signed));
  const confidence = 1 - Math.exp(-weightSum / 1.5);
  return {
    mastery,
    confidence,
    evidence_count: evidence.length,
    last_positive: lastPos,
    last_negative: lastNeg,
  };
}

export function getEvidence(userId: string, conceptId: string, limit = 200): EvidenceRow[] {
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
       (user_id, concept_id, mastery, confidence, evidence_count, last_positive, last_negative, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      conceptId,
      state.mastery,
      state.confidence,
      state.evidence_count,
      state.last_positive,
      state.last_negative,
      new Date().toISOString()
    );
  return { concept_id: conceptId, ...state };
}

export function getState(userId: string, conceptId: string): ConceptStateRow {
  const row = db()
    .prepare(
      `SELECT concept_id, mastery, confidence, evidence_count, last_positive, last_negative
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
