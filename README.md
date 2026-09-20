# AnswerFit

One AI answer, fitted to what each reader already knows. Implementation of `smaller-plan.md` (the Jev-only personalization overlay from `detailed-plan.md`, upgraded with real-history backfill).

## Pipeline

```
paste AI answer ─► Fable: concept graph (1 call, cached)
                     │
data/*.jsonl ─────► SQLite learner state (backfilled once via Jev)
                     │  per-concept evidence retrieval (top-k, not whole history)
                     ▼
                Jev policy per concept: already_understands / mastery /
                intervention / representation  (confidence < 0.5 → Fable escalation)
                     │
                     ▼
                UI-plan → Fable fills content for non-fluent concepts (1 call, cached)
                     │
                     ▼
                React renderers (prose, code, git DAG stepper, timeline, sequence)
                + feedback buttons → evidence appended → next run differs
```

## Setup

```bash
npm install
cp ~/Developer/.env .env               # needs ANTHROPIC_API_KEY + JEV_API_KEY
npx tsx scripts/ingest-transcripts.ts  # Claude Code + Codex transcripts → chat evidence
npx tsx scripts/induce-taxonomy.ts     # Fable induces taxonomy from sampled history (~$2)
npx tsx scripts/ingest-transcripts.ts  # re-run: assistant mentions vs induced taxonomy
npm run backfill                       # Jev interprets all matched events (~3 min, <$1)
npm run seed-personas                  # junior-frontend + git-expert synthetic readers
npm run dev                            # http://localhost:3210
```

`npm run backfill -- --heuristic-only` skips the Jev API (keyword rules only).
`npm run inspect [user] [concept_id]` spot-checks learner state and evidence.

## Evidence sources

1. **Google/YouTube history** (`data/*.jsonl`) — searches, visits, watches.
2. **Chat transcripts** (`~/.claude/projects`, `~/.codex/sessions`) — your typed messages, judged by Jev as expresses_confusion / asks_for_explanation / asks_advanced_question / uses_correctly / corrects_assistant. Confusion messages with no concept mention are attributed to concepts in the assistant's preceding message.
3. **"Explanation didn't land" join** — a remedial search within 30 min of an assistant explaining the same concept becomes strong negative evidence (the detailed-plan merge-storm example, operationalized).

The taxonomy (`taxonomy/concepts.json`) is data-governed: Fable induces concepts from sampled history (`scripts/induce-taxonomy.ts`), then a subsume/retire pass (`scripts/prune-taxonomy.ts`) merges duplicates and retires hand-written seeds the evidence doesn't support (survivors: 144 concepts). Assistant brand names (claude, codex, gpt…) are banned as aliases — they match every chat message and poison the LLM-fundamentals state.

Demo samples are real answers mined from the user's own transcripts (`scripts/mine-samples.ts` → `data/real-samples.json`); the synthetic spec examples remain, labeled as such.

## Day 5 policy eval

`scripts/eval-policy.ts` runs ~140 real concept states through both Jev and a Fable reference labeler:
- intervention class (explain vs. don't): 82.5% overall, **92.9% when Jev clears the 0.5 confidence gate** — low-confidence cases already escalate to Fable, so the gate is doing its job
- representation choice: 89.1% agreement
- `already_understands`: 67% — Jev runs systematically strict, which is why explicit user feedback now overrides it unconditionally
- Poor agreement would auto-raise per-question gates via `config/policy-gates.json` (read by the pipeline at startup)

## Layout

- `taxonomy/concepts.json` — seed concept taxonomy with aliases (offline stand-in for the frontier taxonomy-induction pass)
- `lib/mastery.ts` — Learner State Engine: immutable evidence log → recency-decayed mastery (state always recomputable from events)
- `lib/interpret.ts` — history event → evidence (heuristic prior, Jev refinement)
- `lib/models/jev.ts` — TypeSafe System One client (`POST /v1/systemone`)
- `lib/models/anthropic.ts` — Fable: extraction, render fill, policy escalation; SQLite-cached for dev-loop replay
- `lib/pipeline.ts` — Intervention Policy: retrieval → Jev fan-out → confidence gate → UI plan
- `scripts/` — init-db, backfill, seed-personas, inspect-state
- `app/`, `components/` — Next.js UI: compare view, concept cards, provenance ("why we think this"), feedback loop

## Demo script

1. Sample "Git merge storm", reader **Gabe (real history)** → Personalize. Merge storm/rebase/DAG get interactive DAG explanations; race condition gets a one-line reminder (provenance: 2018–19 Django race-condition searches); `git rerere` gets a code example.
2. **⇆ Compare all** → same answer, three radically different plans (git expert sees five concepts suppressed).
3. Click **Already knew this** on Merge storm → re-run → now suppressed with Jev conf ≈ 0.93. Live state change.

## Live capture loop (Claude Code hook)

A user-level Stop hook (`hooks/answerfit-capture.mjs`, registered in
`~/.claude/settings.json`) closes the loop on every Claude Code session:

- your typed messages become Jev-judged evidence immediately (same
  interpretation path as the backfill)
- each substantive assistant answer is queued and personalized in the
  background; annotate/render are skipped when the policy finds no gaps
- the terminal stays SILENT for all-known answers; when real gaps exist the
  next turn end prints one line: `⚡ AnswerFit: N gaps — <concept> → localhost:3210/?feed=<id>`
- the web app's **Captured** strip lists recent captures (⚡n = gaps, ✓ = all
  known); deep links open the fitted rendering

The hook fails silent by design (server down → no-op) and never blocks the
session. Per-session transcript cursors live in `~/.claude/answerfit-hook-state.json`.

## Chat mode (/chat)

The flagship surface: ask a question, the raw answer streams immediately
(fidelity first — never withheld), then personalization folds in live in the
same bubble: verdict chips appear per concept as Jev decides (✓ known,
↻ reminder, ▸ hedge, ⚡ explain), then the fitted view swaps in — marked
spans, ordered concept cards, visuals, caveats. Your questions become live
evidence. No hook, no second surface, no deferred notification.

Note: Fable 5's API safety layer hard-refuses some innocuous prompts
(observed: output-shaping system-prompt sentences; a BGP route-manipulation
question). The route surfaces these as a friendly notice.
