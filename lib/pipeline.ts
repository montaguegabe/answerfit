import { db } from "./db";
import { getEvidence, getState, type EvidenceRow } from "./mastery";
import { conceptById } from "./taxonomy";
import {
  extractConcepts,
  escalatePolicy,
  fillRenderPlan,
  annotatePlan,
  type ExtractedConcept,
  type ConceptContent,
  type PolicyDecision,
  type PlanEntry,
  type ExplanationPlan,
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

// Per-question Jev confidence gates, settable from eval results
// (scripts/eval-policy.ts writes config/policy-gates.json; adopted from
// ../answerfit — their n=137 run validated 0.5: Jev-confident decisions agree
// with Fable 92.9% on the light/heavy intervention class).
import fs from "fs";
import path from "path";
function loadGates(): { intervention_gate: number; representation_gate: number } {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "policy-gates.json"), "utf-8"));
  } catch {
    return { intervention_gate: 0.5, representation_gate: 0.5 };
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
  plan?: PlanEntry & { overridden: boolean };
}

export interface PersonalizeResult {
  user_id: string;
  answer: string;
  blocks: ConceptBlock[];
  plan: { primary_visual: string | null; caveats: { quote: string; reason: string }[]; coherence_notes: string };
  timing_ms: { extract: number; policy: number; annotate: number; render: number };
}

/** The verdict the renderer/UI act on: Tier-2 plan wins, Tier-1 is the fallback. */
export function finalVerdict(b: ConceptBlock): PlanEntry["verdict"] {
  if (b.plan) return b.plan.verdict;
  return b.decision.intervention === "none" ? "suppress" : (b.decision.intervention as PlanEntry["verdict"]);
}

const VISUAL_REPS = new Set(["git_dag", "timeline", "sequence", "custom"]);

/** Code-level backstop for plan rule 1 (≤1 interactive, ≤2 visuals) — the model
 * is told the rule, but a coherence invariant should not depend on obedience. */
function enforceVisualBudget(plan: ExplanationPlan): ExplanationPlan {
  const entries = [...plan.entries].sort((a, b) => a.order - b.order);
  let interactives = 0;
  let visuals = 0;
  for (const e of entries) {
    const isPrimary = e.concept_id === plan.primary_visual;
    if (e.verdict === "interactive") {
      interactives++;
      if (interactives > 1 && !isPrimary) {
        e.verdict = "example";
        e.representation = "prose";
        e.rationale += " [backstop: demoted — only one interactive per plan]";
      }
    }
    if (VISUAL_REPS.has(e.representation) && e.verdict !== "suppress") {
      visuals++;
      if (visuals > 2 && !isPrimary) {
        e.representation = e.verdict === "example" ? "code_example" : "prose";
        e.rationale += " [backstop: visual budget exceeded — switched to non-visual representation]";
      }
    }
  }
  return { ...plan, entries };
}

const MASTERY_LEVELS = ["unknown", "recognizes term", "can explain", "can apply", "fluent"];

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
        custom: "None of the fixed forms fits well — a bespoke generated visualization (architecture/topology, state machine, table transformation, memory layout, waterfall, …) would teach this concept better",
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
  const belowGate =
    intervention.confidence < GATES.intervention_gate ||
    (needsRepresentation && representation.confidence < GATES.representation_gate);

  if (belowGate) {
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

const HEAVY = new Set(["example", "diagram", "interactive"]);

export async function personalize(
  userId: string,
  answer: string,
  opts: { skipHeavyIfNoGaps?: boolean } = {}
): Promise<PersonalizeResult> {
  const t0 = Date.now();
  const concepts = await extractConcepts(answer);
  const t1 = Date.now();

  const blocks = await mapConcurrent(concepts, 8, (c) => decideConcept(userId, answer, c));
  const t2 = Date.now();

  // Capture-loop economy (smaller-plan: "decide when NOT to call the expensive
  // generator"): if Tier-1 found no genuine gaps, skip annotate + render — the
  // all-known verdict IS the result, and it cost only the cheap Jev fan-out.
  if (opts.skipHeavyIfNoGaps && !blocks.some((b) => HEAVY.has(b.decision.intervention))) {
    return {
      user_id: userId,
      answer,
      blocks,
      plan: { primary_visual: null, caveats: [], coherence_notes: "no gaps found; heavy stages skipped" },
      timing_ms: { extract: t1 - t0, policy: t2 - t1, annotate: 0, render: 0 },
    };
  }

  // Tier-2 annotator (PROPOSAL §3.1): resolve independent per-concept decisions
  // into one coherent Explanation Plan. Tier-1 results are features, not verdicts.
  // Jev probabilities are rounded to one decimal before entering the summaries:
  // they jitter run-to-run, and since the annotate cache key hashes these
  // summaries, raw values caused a cache miss (and a fresh ~40s Fable call,
  // plus verdict wobble on borderline concepts) on every repeat run.
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const rProbs = (p: Record<string, number>) =>
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, r1(v)]));
  const summaries = blocks.map((b) => ({
    concept_id: b.concept.id,
    name: b.concept.name,
    quote: b.concept.quote,
    importance: b.concept.importance,
    viz_hint: b.concept.viz_hint,
    prereqs: b.concept.prereqs,
    state: b.state,
    tier1: {
      intervention: b.decision.intervention,
      representation: b.decision.representation,
      depth: b.decision.depth,
      decided_by: b.decision.decided_by,
    },
    jev_probs: b.jev
      ? {
          already_understands: r1(b.jev.already_understands),
          mastery_level: b.jev.mastery_level,
          intervention: rProbs(b.jev.intervention_probs),
          representation: rProbs(b.jev.representation_probs),
          confidence: r1(b.jev.confidence),
        }
      : null,
  }));
  const stableKey = JSON.stringify(
    blocks.map((b) => ({
      c: b.concept.id,
      m: Math.round(b.state.mastery * 50) / 50, // 0.02 granularity: stable, still state-sensitive
      cf: Math.round(b.state.confidence * 20) / 20,
      t1: [b.decision.intervention, b.decision.representation, b.decision.depth],
    }))
  );
  let plan: ExplanationPlan;
  try {
    plan = enforceVisualBudget(await annotatePlan(answer, summaries, stableKey));
  } catch {
    // Annotator failure degrades gracefully to Tier-1-only behavior.
    plan = { entries: [], primary_visual: null, caveats: [], coherence_notes: "annotator unavailable; Tier-1 only" };
  }
  const entryById = new Map(plan.entries.map((e) => [e.concept_id, e]));
  for (const b of blocks) {
    const e = entryById.get(b.concept.id);
    if (!e) continue;
    const tier1Equiv = b.decision.intervention === "none" ? "suppress" : b.decision.intervention;
    b.plan = { ...e, overridden: e.verdict !== tier1Equiv };
  }
  blocks.sort((a, b) => (a.plan?.order ?? 99) - (b.plan?.order ?? 99));
  const t3 = Date.now();

  // One render-fill call covering every concept that needs content
  // (hedged concepts get content too, so expansion works without another call).
  const items = blocks
    .filter((b) => finalVerdict(b) !== "suppress")
    .map((b) => {
      const verdict = finalVerdict(b);
      return {
        concept_id: b.concept.id,
        name: b.concept.name,
        quote: b.concept.quote,
        intervention: verdict,
        representation:
          verdict === "reminder" ? "reminder" : b.plan?.representation ?? b.decision.representation,
        depth: b.plan?.depth ?? b.decision.depth,
        user_context: `mastery=${b.state.mastery} (${b.jev?.mastery_level ?? "n/a"}); recent evidence: ${b.provenance
          .map((p) => `${p.source}:"${p.text}"`)
          .slice(0, 2)
          .join("; ")}`,
      };
    });
  const contents = await fillRenderPlan(answer, items);
  const byId = new Map(contents.map((c) => [c.concept_id, c]));
  const logCustom = db().prepare(
    "INSERT INTO custom_renders (ts, user_id, concept_id, form_slug, description) VALUES (?, ?, ?, ?, ?)"
  );
  for (const b of blocks) {
    const content = byId.get(b.concept.id);
    if (content) b.content = content;
    if (content?.custom) {
      logCustom.run(new Date().toISOString(), userId, b.concept.id, content.custom.form_slug, content.custom.description);
    }
  }
  const t4 = Date.now();

  return {
    user_id: userId,
    answer,
    blocks,
    plan: { primary_visual: plan.primary_visual, caveats: plan.caveats, coherence_notes: plan.coherence_notes },
    timing_ms: { extract: t1 - t0, policy: t2 - t1, annotate: t3 - t2, render: t4 - t3 },
  };
}
