import { db } from "./db";
import { getEvidence, getState, type EvidenceRow } from "./mastery";
import { conceptById } from "./taxonomy";
import {
  extractConcepts,
  escalatePolicy,
  fillRenderPlan,
  type ExtractedConcept,
  type ConceptContent,
  type PolicyDecision,
} from "./models/anthropic";
import {
  jevJudge,
  mapConcurrent,
  type JevQuestion,
  type JevNoulAnswer,
  type JevChoiceAnswer,
  type JevScoreAnswer,
} from "./models/jev";

/**
 * Runtime pipeline (smaller-plan Day 2/3):
 * answer → Fable concept graph → per-concept evidence retrieval →
 * Jev policy fan-out (confidence-gated Fable escalation) → UI plan →
 * one Fable render-fill call for non-fluent concepts.
 */

// Per-question Jev confidence gates. Defaults are overridden by
// config/policy-gates.json when the Day 5 eval finds poor agreement on a
// question type (higher gate = escalate to Fable more often).
import fs from "fs";
import path from "path";
function loadGates(): { intervention: number; representation: number } {
  try {
    const p = path.join(process.cwd(), "config", "policy-gates.json");
    const g = JSON.parse(fs.readFileSync(p, "utf-8"));
    return { intervention: g.intervention_gate ?? 0.5, representation: g.representation_gate ?? 0.5 };
  } catch {
    return { intervention: 0.5, representation: 0.5 };
  }
}
const GATES = loadGates();

export interface ConceptBlock {
  concept: ExtractedConcept;
  state: { mastery: number; confidence: number; evidence_count: number };
  decision: PolicyDecision & { decided_by: "jev" | "fable" };
  jev?: {
    already_understands: number;
    mastery_level: string;
    mastery_score: number;
    intervention_probs: Record<string, number>;
    representation_probs: Record<string, number>;
    confidence: number;
  };
  provenance: { source: string; ts: string; text: string; interpretation: string | null }[];
  content?: ConceptContent;
}

export interface PersonalizeResult {
  user_id: string;
  answer: string;
  blocks: ConceptBlock[];
  timing_ms: { extract: number; policy: number; render: number };
}

export const MASTERY_LEVELS = ["unknown", "recognizes term", "can explain", "can apply", "fluent"];

export function policyQuestions(conceptName: string): Record<string, JevQuestion> {
  return {
    already_understands: {
      type: "noul",
      instructions: `Is there strong evidence in the user's history that they already understand "${conceptName}" well enough that explaining it would waste their time?`,
    },
    mastery: {
      type: "score",
      instructions: `Rate the user's current mastery of "${conceptName}" based on the evidence.`,
      criteria: MASTERY_LEVELS,
    },
    intervention: {
      type: "choice",
      instructions: `What intervention should the personalization layer apply for "${conceptName}" in this answer? Explain nothing the user demonstrably knows.`,
      criteria: {
        none: "Leave untouched / collapse: the user knows this; any explanation would be annoying",
        reminder: "One-line reminder: user knows it but it may be stale or the answer uses it in an unusual way",
        example: "Concrete worked/code example: user partially knows it and an example will bridge the gap",
        diagram: "Static diagram: the concept is structural/relational and the user lacks it",
        interactive: "Step-through interactive visualization: the concept is dynamic/temporal and the user lacks it",
      },
    },
    representation: {
      type: "choice",
      instructions: `If this concept is explained, which representation would teach it best to this user for this answer?`,
      criteria: {
        prose: "Plain prose explanation",
        code_example: "Minimal code example",
        git_dag: "Commit-graph (DAG) visualization — best for branch ancestry/topology",
        timeline: "Concurrent-lanes timeline — best for temporal ordering and interleaving",
        sequence: "Sequence diagram — best for multi-party call/message interactions",
      },
    },
  };
}

export function summarizeEvidence(rows: EvidenceRow[], limit = 8) {
  return rows.slice(0, limit).map((e) => ({
    ts: e.ts,
    source: e.source,
    text: e.raw_text?.slice(0, 120) ?? "",
    interpretation: e.interpretation,
    direction: e.direction > 0 ? "knows" : "gap",
    strength: Math.round(e.strength * 100) / 100,
  }));
}

function feedbackCounts(userId: string, conceptId: string): Record<string, number> {
  const rows = db()
    .prepare("SELECT action, COUNT(*) n FROM feedback WHERE user_id=? AND concept_id=? GROUP BY action")
    .all(userId, conceptId) as { action: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.action, r.n]));
}

async function decideConcept(userId: string, answer: string, c: ExtractedConcept): Promise<ConceptBlock> {
  const state = getState(userId, c.id);
  const evidence = getEvidence(userId, c.id, 50);
  const fb = feedbackCounts(userId, c.id);
  const prereqStates = c.prereqs
    .map((p) => ({ concept: p, mastery: Math.round(getState(userId, p).mastery * 100) / 100 }))
    .filter((p) => conceptById(p.concept));

  const jevState = {
    concept: c.name,
    importance_in_answer: c.importance,
    source_span: c.quote,
    task_context: "User pasted an AI assistant's answer and wants it personalized to what they already know",
    user_mastery_estimate: Math.round(state.mastery * 100) / 100,
    estimate_confidence: Math.round(state.confidence * 100) / 100,
    evidence: summarizeEvidence(evidence),
    prerequisite_states: prereqStates,
    explicit_user_feedback: fb,
    representation_hint_for_concept_type: c.viz_hint,
  };

  const res = await jevJudge(jevState, policyQuestions(c.name));
  const already = (res.answers.already_understands as JevNoulAnswer).noul;
  const mastery = res.answers.mastery as JevScoreAnswer;
  const intervention = res.answers.intervention as JevChoiceAnswer;
  const representation = res.answers.representation as JevChoiceAnswer;

  const jevSummary = {
    already_understands: already,
    mastery_level: MASTERY_LEVELS[Math.round(Math.max(0, Math.min(4, mastery.score)))],
    mastery_score: mastery.score,
    intervention_probs: intervention.probabilities,
    representation_probs: representation.probabilities,
    confidence: Math.min(intervention.confidence, representation.confidence),
  };

  let decision: PolicyDecision & { decided_by: "jev" | "fable" };
  const needsRepresentation = !["none", "reminder"].includes(intervention.choice);
  const escalate =
    intervention.confidence < GATES.intervention ||
    (needsRepresentation && representation.confidence < GATES.representation);

  if (escalate) {
    // Confidence-gated escalation to Fable (smaller-plan Day 5 fallback).
    const fable = await escalatePolicy({ ...jevState, jev_low_confidence_answers: res.answers });
    decision = { ...fable, decided_by: "fable" };
  } else {
    const depth: 1 | 2 = mastery.score < 1 ? 2 : 1;
    decision = {
      intervention: intervention.choice as PolicyDecision["intervention"],
      representation: representation.choice as PolicyDecision["representation"],
      depth: (fb.more_detail ?? 0) > 0 ? 2 : depth,
      rationale: `Jev: already_understands=${already.toFixed(2)}, mastery=${jevSummary.mastery_level}, intervention=${intervention.choice} (conf ${intervention.confidence.toFixed(2)})`,
      decided_by: "jev",
    };
  }

  // Explicit feedback hard-overrides inferred state (eval showed Jev's
  // already_understands runs strict — never let it veto the user's own claim).
  if ((fb.already_knew ?? 0) > 0) {
    decision = { ...decision, intervention: "none", rationale: decision.rationale + "; user said already-knew" };
  }
  if ((fb.show_visually ?? 0) > 0 && decision.representation === "prose") {
    decision = { ...decision, representation: c.viz_hint === "prose" ? "timeline" : (c.viz_hint as PolicyDecision["representation"]) };
  }
  if ((fb.still_confused ?? 0) > 0 && decision.intervention === "none") {
    decision = { ...decision, intervention: "example", depth: 2, rationale: decision.rationale + "; user said still-confused" };
  }

  return {
    concept: c,
    state: {
      mastery: Math.round(state.mastery * 100) / 100,
      confidence: Math.round(state.confidence * 100) / 100,
      evidence_count: state.evidence_count,
    },
    decision,
    jev: jevSummary,
    provenance: evidence.slice(0, 4).map((e) => ({
      source: e.source,
      ts: e.ts,
      text: e.raw_text?.slice(0, 90) ?? "",
      interpretation: e.interpretation,
    })),
  };
}

export async function personalize(userId: string, answer: string): Promise<PersonalizeResult> {
  const t0 = Date.now();
  const concepts = await extractConcepts(answer);
  const t1 = Date.now();

  const blocks = await mapConcurrent(concepts, 8, (c) => decideConcept(userId, answer, c));
  const t2 = Date.now();

  // One render-fill call covering every concept that needs content.
  const items = blocks
    .filter((b) => b.decision.intervention !== "none")
    .map((b) => ({
      concept_id: b.concept.id,
      name: b.concept.name,
      quote: b.concept.quote,
      intervention: b.decision.intervention,
      representation: b.decision.intervention === "reminder" ? "reminder" : b.decision.representation,
      depth: b.decision.depth,
      user_context: `mastery=${b.state.mastery} (${b.jev?.mastery_level ?? "n/a"}); recent evidence: ${b.provenance
        .map((p) => `${p.source}:"${p.text}"`)
        .slice(0, 2)
        .join("; ")}`,
    }));
  const contents = await fillRenderPlan(answer, items);
  const byId = new Map(contents.map((c) => [c.concept_id, c]));
  for (const b of blocks) {
    const content = byId.get(b.concept.id);
    if (content) b.content = content;
  }
  const t3 = Date.now();

  return {
    user_id: userId,
    answer,
    blocks,
    timing_ms: { extract: t1 - t0, policy: t2 - t1, render: t3 - t2 },
  };
}
