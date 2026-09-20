# AnswerFit — Build Plan (<$100, ~5–7 days)

## What we're building

The **Jev-only personalization overlay** from SPEC.md ("aggressively simple alternative"), upgraded in one important way: the learner state is **backfilled from real history** (the 170k parsed Google/YouTube events already in `data/`), not hand-seeded. This keeps the demo thesis intact — *one original AI answer → radically different renderings for different users* — while exercising the same architecture the full system would use.

```
paste AI answer ──► Fable: concept graph (1 call)
                        │
     data/*.jsonl ──► SQLite learner state (backfilled once)
                        │  per-concept evidence retrieval
                        ▼
                   Jev: known? / intervention? / representation? / depth?
                        │
                        ▼
                   UI-plan JSON ──► Fable: fill unknown-concept content (1 call)
                        │
                        ▼
                   React renderers + feedback buttons ──► evidence appended back
```

Explicitly **out of scope** (defer, per SPEC's own tiering): learned KT/forgetting models, contextual bandits, video-corpus mining, browser-extension live capture, multi-user infra, fine-tuning.

## Stack

- **App**: Next.js + React, one page, local dev (deploy to Vercel free tier only if demoing remotely).
- **Store**: SQLite (`better-sqlite3` or a small Python sidecar). Tables: `events`, `concepts`, `concept_state`, `feedback`.
- **Models**: Fable 5.1 (or Astra) for concept extraction + rendering; Jev for all repeated judgments. Cache the system prompts/schemas (Fable cache reads $0.25/M).
- **Renderers** (5, all deterministic React over structured props): prose block, code example, Git-style DAG (custom SVG), timeline/swimlane, sequence diagram (Mermaid is acceptable for the last two if time is short).

## Day-by-day

### Day 1 — Concept index + history backfill
1. Cheap heuristic pre-filter of the 170k events: drop notifications/nulls, non-learning noise (music, entertainment) via keyword rules first. Expect ~20–50k candidate "learning-intent" events.
2. One frontier pass over a **sample** (~2k events) to induce a concept taxonomy + aliases (single batched calls, ~$2–5).
3. Jev backfill over all candidate events: `learning_intent?` (noul), `concept match` (choice against taxonomy shortlist retrieved by embedding/keyword), `signal strength/direction` (score). ~30M tokens ≈ **$1.50**.
4. Write `events` + initial `concept_state` rows. Mastery = recency-weighted evidence score with a hand-tuned decay — no learned KT.

**Checkpoint**: query "what does this user know about X?" returns sane answers for ~20 spot-checked concepts (e.g., things you searched remedially last month vs. things you use fluently).

### Day 2 — Runtime pipeline, no UI
1. Endpoint: POST an AI answer → Fable extracts concept graph (concepts, prerequisites, spans, contrasts) as JSON.
2. Per-concept retrieval: top-k evidence rows + prerequisite states from SQLite.
3. Jev policy call (fan-out, one request per concept): `already_understands`, `mastery` score, `intervention` choice, `representation` choice — exactly the schema in SPEC lines 419–469.
4. Emit UI-plan JSON (the block vocabulary from SPEC lines 323–347).

**Checkpoint**: same pasted answer + two different `user_id`s → visibly different UI plans in raw JSON.

### Day 3 — Render pass + React components
1. One Fable call fills the UI plan: explanation text at chosen depth, DAG/timeline/sequence step data — only for concepts marked non-fluent. Suppressed concepts get the original text untouched (fidelity guarantee: renderer may not delete caveats, only collapse them behind "already known ✓").
2. Build the 5 renderers + the collapsed "you already know this" affordance.

**Checkpoint**: end-to-end paste → personalized page.

### Day 4 — Feedback loop + second/third user
1. Buttons: `[Already knew this] [Still confused] [More detail] [Show visually]` → append evidence rows → next request on the same concept behaves differently. Demonstrate live state change ("tell it you already knew X, re-run, X is now suppressed").
2. Create 2 synthetic personas (junior frontend dev, senior git expert) by seeding `concept_state` directly — plus **you** as the real, history-backed user. Side-by-side compare view (3 columns or tabbed).

### Day 5 — Validation + demo polish
1. Jev sanity eval: ~150 hand-labeled policy decisions (known/unknown + representation) vs. Jev output; if agreement is poor on a question type, route that question to Fable instead (confidence-gated fallback is a one-line change). Cost: pennies.
2. Pick 3 canned source answers (the merge-storm one from SPEC, one concurrency one, one from your real Claude Code history) and rehearse the demo. Record a fallback screen capture.

### Days 6–7 (buffer / stretch, in priority order)
- Import real Claude Code / ChatGPT conversation history as an additional evidence source (much higher-signal than searches; JSON exports parse easily).
- Provenance tooltips: "inferred from your search *'git merge storm meaning'* on Sep 18" — cheap to add, disproportionately impressive.
- Tiny optional quiz block for one concept to show the outcome-measurement story.

## Budget (worst case)

| Item | Estimate |
| --- | ---: |
| Frontier taxonomy induction (Day 1, ~5M in / 0.5M out) | ~$8 |
| Jev backfill of full history (~30–50M in, output free) | ~$2 |
| Jev runtime + eval calls | <$1 |
| Fable extraction+render during dev: ~250 runs × (~12k in / 3k out) ≈ 3M in / 0.75M out, much of it cache-read | ~$40–60 |
| Hosting | $0 (local / Vercel free) |
| **Total** | **~$50–70** |

Biggest cost lever is dev-loop render calls: cache the schema/system prefix and reuse canned extraction results while iterating on renderers (replay from stored JSON, don't re-call the model to tweak CSS).

## Risks & cuts

- **Jev is 4 days old** — vendor-reported latency/calibration. Mitigation is Day 5's eval + per-question Fable fallback; the architecture doesn't change either way.
- **History is noisy** (searches ≠ knowledge). Acceptable: the demo claim is "evidence-conditioned rendering," and the synthetic personas guarantee contrast even if real-history inference is mediocre. Provenance display turns noise into a feature ("here's *why* I think you know this — correct me").
- **Behind schedule?** Cut in this order: Mermaid instead of custom sequence/timeline renderers → drop feedback-driven re-run → drop Day 1 backfill and ship personas-only (SPEC's original hackathon shape). Never cut the side-by-side multi-user demo — it *is* the thesis.
