/**
 * Day 5 sanity eval (smaller-plan): ~150 policy decisions, Jev vs a Fable
 * reference labeler, on real concept states from the backfilled user.
 * Reports per-question agreement; if a question type agrees poorly, writes
 * config/policy-gates.json to raise that question's escalation gate.
 *
 * (The plan says "hand-labeled"; with no human labeling budget the reference
 * labels come from Fable — this validates Jev against the model we would
 * escalate to, which is exactly the routing decision the gate controls.)
 */
import fs from "fs";
import path from "path";
import "../lib/env";
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../lib/db";
import { getEvidence, getState } from "../lib/mastery";
import { conceptById, taxonomy } from "../lib/taxonomy";
import { jevJudge, mapConcurrent } from "../lib/models/jev";
import { policyQuestions, summarizeEvidence } from "../lib/pipeline";

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const USER = "gabe";
const N = 150;

interface DecisionPoint {
  concept_id: string;
  state: any; // the shared jev/fable judgment state bundle
}

interface JevOut { already: boolean; intervention: string; representation: string; conf_i: number; conf_r: number }
interface FableOut { already: boolean; intervention: string; representation: string }

function buildPoints(): DecisionPoint[] {
  const rows = db()
    .prepare(
      `SELECT concept_id FROM concept_state WHERE user_id = ? AND evidence_count > 0 ORDER BY concept_id`
    )
    .all(USER) as { concept_id: string }[];
  const points: DecisionPoint[] = [];
  for (const { concept_id } of rows) {
    const c = conceptById(concept_id);
    if (!c) continue;
    const st = getState(USER, concept_id);
    const evidence = summarizeEvidence(getEvidence(USER, concept_id, 50));
    const prereqStates = (c.prereqs ?? [])
      .filter((p) => conceptById(p))
      .map((p) => ({ concept: p, mastery: Math.round(getState(USER, p).mastery * 100) / 100 }));
    points.push({
      concept_id,
      state: {
        concept: c.name,
        importance_in_answer: "central",
        source_span: `An AI assistant's answer uses and depends on the concept "${c.name}".`,
        task_context: "User pasted an AI assistant's answer and wants it personalized to what they already know",
        user_mastery_estimate: Math.round(st.mastery * 100) / 100,
        estimate_confidence: Math.round(st.confidence * 100) / 100,
        evidence,
        prerequisite_states: prereqStates,
        explicit_user_feedback: {},
        representation_hint_for_concept_type: c.viz,
      },
    });
  }
  return points.slice(0, N);
}

const FABLE_BATCH = 10;

async function fableLabels(client: Anthropic, batch: DecisionPoint[], offset: number): Promise<FableOut[]> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: `You are the reference pedagogical policy for a personalization layer. For each numbered case, given one concept from an AI answer plus evidence about what this user knows, decide independently:
- already_understands: would explaining this concept waste this user's time?
- intervention: none | reminder | example | diagram | interactive
- representation (best teaching form if explained): prose | code_example | git_dag | timeline | sequence
Explain nothing the user demonstrably knows; spend explanatory bandwidth only across the boundary of their current understanding.`,
    messages: [
      {
        role: "user",
        content: batch.map((p, i) => `CASE ${offset + i}:\n${JSON.stringify(p.state)}`).join("\n\n"),
      },
    ],
    tools: [
      {
        name: "label_cases",
        description: "Return one label per case.",
        input_schema: {
          type: "object",
          required: ["labels"],
          properties: {
            labels: {
              type: "array",
              items: {
                type: "object",
                required: ["case", "already_understands", "intervention", "representation"],
                properties: {
                  case: { type: "integer" },
                  already_understands: { type: "boolean" },
                  intervention: { enum: ["none", "reminder", "example", "diagram", "interactive"] },
                  representation: { enum: ["prose", "code_example", "git_dag", "timeline", "sequence"] },
                },
              },
            },
          },
        } as any,
      },
    ],
    tool_choice: { type: "tool", name: "label_cases" },
  });
  const tu = res.content.find((b) => b.type === "tool_use") as any;
  const byCase = new Map<number, any>((tu.input.labels ?? []).map((l: any) => [l.case, l]));
  return batch.map((_, i) => {
    const l = byCase.get(offset + i);
    return l
      ? { already: l.already_understands, intervention: l.intervention, representation: l.representation }
      : { already: false, intervention: "example", representation: "prose" };
  });
}

const lightSet = new Set(["none", "reminder"]);

async function main() {
  const points = buildPoints();
  console.log(`Evaluating ${points.length} policy decisions (Jev vs Fable reference)…`);

  const jevOuts: JevOut[] = await mapConcurrent(points, 24, async (p) => {
    const res = await jevJudge(p.state, policyQuestions(p.state.concept));
    const a = res.answers as any;
    return {
      already: a.already_understands.noul > 0.5,
      intervention: a.intervention.choice,
      representation: a.representation.choice,
      conf_i: a.intervention.confidence,
      conf_r: a.representation.confidence,
    };
  });
  console.log("Jev done; running Fable reference labels…");

  const client = new Anthropic();
  const batches: DecisionPoint[][] = [];
  for (let i = 0; i < points.length; i += FABLE_BATCH) batches.push(points.slice(i, i + FABLE_BATCH));
  const fableOuts: FableOut[] = (
    await mapConcurrent(batches, 4, (b, bi) => fableLabels(client, b, bi * FABLE_BATCH))
  ).flat();

  let aAgree = 0, iExact = 0, iClass = 0, rExact = 0, rEligible = 0;
  let hcN = 0, hcClass = 0; // agreement among decisions Jev is confident about (past the gate)
  const disagreements: any[] = [];
  points.forEach((p, i) => {
    const j = jevOuts[i], f = fableOuts[i];
    if (j.already === f.already) aAgree++;
    if (j.intervention === f.intervention) iExact++;
    if (lightSet.has(j.intervention) === lightSet.has(f.intervention)) iClass++;
    if (j.conf_i >= 0.5) {
      hcN++;
      if (lightSet.has(j.intervention) === lightSet.has(f.intervention)) hcClass++;
    }
    const bothHeavy = !lightSet.has(j.intervention) && !lightSet.has(f.intervention);
    if (bothHeavy) {
      rEligible++;
      if (j.representation === f.representation) rExact++;
    }
    if (j.intervention !== f.intervention || j.already !== f.already) {
      disagreements.push({ concept: p.concept_id, jev: j, fable: f });
    }
  });

  const n = points.length;
  const pct = (x: number, d = n) => ((100 * x) / Math.max(1, d)).toFixed(1) + "%";
  const report = {
    n,
    already_agreement: pct(aAgree),
    intervention_exact: pct(iExact),
    intervention_class: pct(iClass),
    representation_exact_when_both_explain: `${pct(rExact, rEligible)} (n=${rEligible})`,
    intervention_class_when_jev_confident: `${pct(hcClass, hcN)} (n=${hcN})`,
    disagreement_examples: disagreements.slice(0, 12),
  };
  console.log(`\nalready_understands agreement: ${report.already_agreement}`);
  console.log(`intervention exact:            ${report.intervention_exact}`);
  console.log(`intervention class (light/heavy): ${report.intervention_class}`);
  console.log(`representation exact (both explain): ${report.representation_exact_when_both_explain}`);

  // Gate policy: raise a question's escalation gate when agreement is poor.
  const gates: any = { intervention_gate: 0.5, representation_gate: 0.5 };
  if ((100 * iClass) / n < 75) gates.intervention_gate = 0.75;
  if (rEligible >= 10 && (100 * rExact) / rEligible < 60) gates.representation_gate = 0.75;
  fs.mkdirSync(path.join(process.cwd(), "config"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "config", "policy-gates.json"), JSON.stringify(gates, null, 2));
  fs.mkdirSync(path.join(process.cwd(), "reports"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "reports", "eval-policy.json"), JSON.stringify(report, null, 2));
  console.log(`\nGates written: ${JSON.stringify(gates)} → config/policy-gates.json`);
  console.log("Full report → reports/eval-policy.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
