import Anthropic from "@anthropic-ai/sdk";
import crypto from "crypto";
import { cacheGet, cachePut } from "../db";
import { taxonomy } from "../taxonomy";

/**
 * Fable client: the two frontier calls in the smaller-plan pipeline
 * (concept extraction, render fill) plus confidence-gated policy escalation.
 * Results are cached in SQLite so dev-loop iteration replays instead of re-calling.
 */

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) _client = new Anthropic();
  return _client;
}

function hash(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("")).digest("hex");
}

async function jsonToolCall<T>(opts: {
  cacheKind: string;
  cacheKeyParts: string[];
  system: string;
  user: string;
  toolName: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  noCache?: boolean;
}): Promise<T> {
  const key = hash(opts.cacheKind, MODEL, ...opts.cacheKeyParts);
  if (!opts.noCache) {
    const cached = cacheGet(key);
    if (cached) return cached as T;
  }
  const res = await client().messages.create({
    model: MODEL,
    max_tokens: opts.maxTokens ?? 8192,
    system: [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: opts.user }],
    tools: [
      {
        name: opts.toolName,
        description: "Return the structured result.",
        input_schema: opts.schema as any,
      },
    ],
    tool_choice: { type: "tool", name: opts.toolName },
  });
  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("No tool_use block in Fable response");
  const value = toolUse.input as T;
  cachePut(key, opts.cacheKind, value);
  return value;
}

// ---------- 1. Concept extraction ----------

export interface ExtractedConcept {
  id: string; // taxonomy id when matched, else new slug like "new.some_concept"
  name: string;
  quote: string; // shortest verbatim span from the answer where the concept is central
  importance: "central" | "supporting" | "passing";
  viz_hint: "prose" | "code" | "git_dag" | "timeline" | "sequence";
  prereqs: string[];
  contrasts: string[];
}

export async function extractConcepts(answer: string): Promise<ExtractedConcept[]> {
  const taxList = taxonomy()
    .map((c) => `${c.id}: ${c.name} (aliases: ${c.aliases.slice(0, 4).join(", ")})`)
    .join("\n");
  const result = await jsonToolCall<{ concepts: ExtractedConcept[] }>({
    cacheKind: "extract",
    cacheKeyParts: [answer, hash(taxList)], // taxonomy change must invalidate cached extractions
    toolName: "report_concept_graph",
    system: `You extract a concept graph from an AI assistant's answer so a personalization layer can decide, per concept, whether this specific reader needs it explained. Identify the technical concepts a reader must understand to fully absorb the answer.

Rules:
- Match concepts to the known taxonomy id when one fits; otherwise mint id "new.<snake_slug>".
- quote must be a VERBATIM substring of the answer (the shortest span where the concept is most central).
- Only include concepts that carry real comprehension load. 3-10 concepts typical.
- viz_hint: which representation would best teach this concept to someone who lacks it (git_dag for commit-graph topology, timeline for temporal ordering/concurrency interleaving, sequence for multi-party call/message interactions, code for API/syntax mechanics, prose otherwise).

Known taxonomy:
${taxList}`,
    user: `Extract the concept graph from this answer:\n\n<answer>\n${answer}\n</answer>`,
    schema: {
      type: "object",
      required: ["concepts"],
      properties: {
        concepts: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name", "quote", "importance", "viz_hint", "prereqs", "contrasts"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              quote: { type: "string" },
              importance: { enum: ["central", "supporting", "passing"] },
              viz_hint: { enum: ["prose", "code", "git_dag", "timeline", "sequence"] },
              prereqs: { type: "array", items: { type: "string" } },
              contrasts: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  });
  return result.concepts;
}

// ---------- 2. Policy escalation (confidence-gated fallback from Jev) ----------

export interface PolicyDecision {
  intervention: "none" | "reminder" | "example" | "diagram" | "interactive";
  representation: "prose" | "code_example" | "git_dag" | "timeline" | "sequence" | "custom";
  depth: 1 | 2;
  rationale: string;
}

export async function escalatePolicy(state: unknown): Promise<PolicyDecision> {
  return jsonToolCall<PolicyDecision>({
    cacheKind: "escalate",
    cacheKeyParts: [JSON.stringify(state)],
    toolName: "decide_intervention",
    system:
      "You are the pedagogical intervention policy for a personalization layer. Given one concept from an AI answer plus evidence about what this user knows, decide the intervention. Explain nothing the user demonstrably knows; spend explanatory bandwidth only across the boundary of their current understanding.",
    user: `Decide for this concept/state:\n${JSON.stringify(state, null, 2)}`,
    schema: {
      type: "object",
      required: ["intervention", "representation", "depth", "rationale"],
      properties: {
        intervention: { enum: ["none", "reminder", "example", "diagram", "interactive"] },
        representation: { enum: ["prose", "code_example", "git_dag", "timeline", "sequence", "custom"] },
        depth: { enum: [1, 2] },
        rationale: { type: "string" },
      },
    },
    maxTokens: 1024,
  });
}

// ---------- 2b. Tier-2 annotator: coherent Explanation Plan (PROPOSAL §3.1/§3.2) ----------

export interface PlanEntry {
  concept_id: string;
  verdict: "suppress" | "hedge" | "reminder" | "example" | "diagram" | "interactive";
  representation: "prose" | "code_example" | "git_dag" | "timeline" | "sequence" | "custom";
  depth: 1 | 2;
  order: number; // teach order: prerequisites before dependents
  rationale: string;
}

export interface ExplanationPlan {
  entries: PlanEntry[];
  primary_visual: string | null; // concept_id owning the single primary visualization
  caveats: { quote: string; reason: string }[]; // verbatim spans that must stay visible
  coherence_notes: string;
}

/**
 * Tier-1 (Jev fan-out) judged each concept independently; independent judgments
 * cannot see cross-span coherence. This single Fable call resolves them into
 * one coherent plan: one primary visual, hedges for the uncertain band,
 * prerequisite ordering, caveats never suppressed.
 */
export async function annotatePlan(
  answer: string,
  conceptSummaries: unknown[],
  cacheKey?: string
): Promise<ExplanationPlan> {
  return jsonToolCall<ExplanationPlan>({
    cacheKind: "annotate",
    // cacheKey (when given) is built from stable inputs only (concepts, learner
    // state, Tier-1 choices) — raw Jev probabilities jitter run-to-run and made
    // every repeat a cache miss when hashed directly.
    cacheKeyParts: [answer, cacheKey ?? JSON.stringify(conceptSummaries)],
    toolName: "emit_explanation_plan",
    maxTokens: 4096,
    system: `You are the Tier-2 annotator of a personalization layer. Tier-1 (a cheap calibrated model) scored each concept in an AI answer INDEPENDENTLY: per-concept mastery estimates, intervention and representation probabilities. Independent per-concept judgments cannot enforce coherence across the whole answer — that is your job. Emit ONE coherent Explanation Plan.

Verdicts:
- suppress: user demonstrably knows this. Over-explaining experts actively harms them (expertise reversal) — suppression is a feature, not a downgrade.
- hedge: state is uncertain (mid mastery, low confidence, stale retrievability). Render collapsed: a one-line reminder the user can expand into a full explanation. This is the default when unsure — it bounds the cost of being wrong in both directions.
- reminder: known but stale or used unusually here — one line, always visible.
- example / diagram / interactive: genuine gaps, escalating richness.

Coherence rules (these override Tier-1 when they conflict; explain overrides in rationale):
1. At most ONE 'interactive' verdict, and at most TWO visual representations total (git_dag/timeline/sequence/custom) across the plan. 'custom' means a bespoke generated visualization — prefer it over a fixed form that fits poorly, but it still counts against the visual budget. The most central not-known concept gets the primary visual (set primary_visual to its concept_id); other would-be visuals become example or prose. One primary representation per idea — redundant representations add cognitive load.
2. Two concepts must not separately teach overlapping spans; fold the lesser into the more central one's rationale and give it suppress/reminder/hedge.
3. order: prerequisites before dependents; the primary visual's prerequisites must not come after it.
4. caveats: list every verbatim warning/imperative span in the answer (data-loss, security, "never…", "don't…"). Caveats must remain visible to every reader regardless of mastery — a concept hosting a caveat may be compressed but its warning must never disappear. Copy quotes EXACTLY from the answer.
5. Respect Tier-1's choice when no rule applies — do not churn decisions gratuitously.`,
    user: `<answer>\n${answer}\n</answer>\n\nTier-1 per-concept results (independent judgments to resolve):\n${JSON.stringify(conceptSummaries, null, 2)}`,
    schema: {
      type: "object",
      required: ["entries", "primary_visual", "caveats", "coherence_notes"],
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            required: ["concept_id", "verdict", "representation", "depth", "order", "rationale"],
            properties: {
              concept_id: { type: "string" },
              verdict: { enum: ["suppress", "hedge", "reminder", "example", "diagram", "interactive"] },
              representation: { enum: ["prose", "code_example", "git_dag", "timeline", "sequence", "custom"] },
              depth: { enum: [1, 2] },
              order: { type: "number" },
              rationale: { type: "string" },
            },
          },
        },
        primary_visual: { type: ["string", "null"] },
        caveats: {
          type: "array",
          items: {
            type: "object",
            required: ["quote", "reason"],
            properties: { quote: { type: "string" }, reason: { type: "string" } },
          },
        },
        coherence_notes: { type: "string" },
      },
    },
  });
}

// ---------- 3. Render fill ----------

export interface DagNode {
  id: string;
  parents: string[];
  branch: string;
  label?: string;
}
export interface DagStep {
  title: string;
  text: string;
  highlight: string[]; // node ids
  visible: string[]; // node ids visible at this step
}
export interface TimelineEvent {
  t: number; // 0..100 position
  label: string;
  kind?: "normal" | "conflict" | "highlight";
}
export interface SequenceMessage {
  from: string;
  to: string;
  label: string;
  note?: string;
}

export interface ConceptContent {
  concept_id: string;
  headline: string;
  reminder_text?: string; // for intervention=reminder: ONE sentence
  body_markdown?: string; // for explanations: short markdown at requested depth
  code?: { language: string; code: string; caption: string };
  git_dag?: { nodes: DagNode[]; steps: DagStep[] };
  timeline?: { lanes: { name: string; events: TimelineEvent[] }[]; caption: string };
  sequence?: { actors: string[]; messages: SequenceMessage[]; caption: string };
  custom?: {
    form_slug: string; // kebab-case name of the bespoke form, e.g. "request-waterfall" — recurring slugs get promoted into the fixed vocabulary
    description: string;
    html: string; // fully self-contained HTML+inline CSS/JS/SVG, no external resources
    height: number; // px
  };
}

export interface RenderRequestItem {
  concept_id: string;
  name: string;
  quote: string;
  intervention: string;
  representation: string;
  depth: number;
  user_context: string; // e.g. "mastery 0.14, searched 'git merge storm meaning' 2d ago"
}

export async function fillRenderPlan(
  answer: string,
  items: RenderRequestItem[]
): Promise<ConceptContent[]> {
  if (items.length === 0) return [];
  const result = await jsonToolCall<{ contents: ConceptContent[] }>({
    cacheKind: "render",
    cacheKeyParts: [answer, JSON.stringify(items)],
    toolName: "fill_ui_plan",
    maxTokens: 16384,
    system: `You fill a pedagogical UI plan for a personalization layer. For each requested concept you produce teaching content at the requested depth and representation, tailored to the given user context. The original answer is ALWAYS shown to the user untouched — your content is additive, so never restate the whole answer; teach only the requested concept.

Representation field requirements:
- reminder: ONLY reminder_text — one crisp sentence reactivating a stale concept.
- hedge: reminder_text (one sentence, shown collapsed) AND the fields for the requested representation at depth 1 (shown only if the user expands). Keep the expanded content compact.
- prose: body_markdown (depth 1: 2-3 sentences; depth 2: 1-3 short paragraphs, may include an analogy).
- code_example: body_markdown (1-2 sentences) + code (minimal runnable example, <=20 lines, caption).
- git_dag: body_markdown (1-2 sentences) + git_dag. Nodes form a commit DAG (parents reference node ids; branch groups nodes into lanes). steps is a 3-6 step walkthrough; each step lists which nodes are visible and which are highlighted, telling the story chronologically.
- timeline: body_markdown (1-2 sentences) + timeline. Lanes are concurrent actors/threads; events positioned t 0-100; mark conflicting/critical events kind=conflict or highlight.
- sequence: body_markdown (1-2 sentences) + sequence. Actors exchange ordered labeled messages; use note for the key insight message.
- custom: body_markdown (1-2 sentences) + custom. The escape hatch when no fixed form fits: invent the ideal bespoke visualization. custom.html must be FULLY self-contained (inline CSS/JS/SVG only, no external resources or network requests), render on a dark background (#0a0d12, text #e6edf3), fit width 640px, and set custom.height to its pixel height. Interactivity via inline JS is encouraged (steppers, hover states, drag). form_slug names the general form you invented (kebab-case, e.g. "request-waterfall", "memory-layout") — recurring slugs become first-class renderers later, so name the form, not the concept.

Ground every example in the scenario of the original answer when possible (same branch names, same variables), so the explanation feels native to what the user was reading.`,
    user: `<original_answer>\n${answer}\n</original_answer>\n\nFill content for these concepts:\n${JSON.stringify(items, null, 2)}`,
    schema: {
      type: "object",
      required: ["contents"],
      properties: {
        contents: {
          type: "array",
          items: {
            type: "object",
            required: ["concept_id", "headline"],
            properties: {
              concept_id: { type: "string" },
              headline: { type: "string" },
              reminder_text: { type: "string" },
              body_markdown: { type: "string" },
              code: {
                type: "object",
                required: ["language", "code", "caption"],
                properties: {
                  language: { type: "string" },
                  code: { type: "string" },
                  caption: { type: "string" },
                },
              },
              git_dag: {
                type: "object",
                required: ["nodes", "steps"],
                properties: {
                  nodes: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "parents", "branch"],
                      properties: {
                        id: { type: "string" },
                        parents: { type: "array", items: { type: "string" } },
                        branch: { type: "string" },
                        label: { type: "string" },
                      },
                    },
                  },
                  steps: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["title", "text", "highlight", "visible"],
                      properties: {
                        title: { type: "string" },
                        text: { type: "string" },
                        highlight: { type: "array", items: { type: "string" } },
                        visible: { type: "array", items: { type: "string" } },
                      },
                    },
                  },
                },
              },
              timeline: {
                type: "object",
                required: ["lanes", "caption"],
                properties: {
                  caption: { type: "string" },
                  lanes: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["name", "events"],
                      properties: {
                        name: { type: "string" },
                        events: {
                          type: "array",
                          items: {
                            type: "object",
                            required: ["t", "label"],
                            properties: {
                              t: { type: "number" },
                              label: { type: "string" },
                              kind: { enum: ["normal", "conflict", "highlight"] },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              sequence: {
                type: "object",
                required: ["actors", "messages", "caption"],
                properties: {
                  caption: { type: "string" },
                  actors: { type: "array", items: { type: "string" } },
                  messages: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["from", "to", "label"],
                      properties: {
                        from: { type: "string" },
                        to: { type: "string" },
                        label: { type: "string" },
                        note: { type: "string" },
                      },
                    },
                  },
                },
              },
              custom: {
                type: "object",
                required: ["form_slug", "description", "html", "height"],
                properties: {
                  form_slug: { type: "string" },
                  description: { type: "string" },
                  html: { type: "string" },
                  height: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
  });
  return result.contents;
}
