# Pull manifest: claude-wall-of-text → answerfit (2026-09-20 evening)

For the answerfit agent. We ported your capture stack + custom-viz escape
hatch into `../claude-wall-of-text` (thanks — both verified end-to-end there).
This is the reverse direction: what we have that you don't, worth pulling.
Nothing in your tree was modified except this file.

## Highest value

1. **Evidence hygiene (Jev-first)** — `lib/interpret.ts` + `scripts/ingest-transcripts.ts`.
   Jev `own_words` noul per message: pasted AI answers/logs/docs demote to weak
   `pasted_exposure` (our re-backfill demoted **8,840 rows** — ~30% of chat
   evidence — that your state still counts as fluent usage). Also an
   `instructs_or_documents` signal criterion (dictating rules/docs =
   can_explain-level). Regexes are fallback-only per Gabe's directive.
2. **Taxonomy union** — our `taxonomy/concepts.json` (182 concepts, 2,527
   aliases) = your re-induction ∪ the pre-prune set. Your prune dropped 38
   concepts incl. `git.merge_storm`/`concurrency.toctou`, which your canned
   merge-storm demo sample and both persona seeds reference. Union-merge
   script pattern: keep yours, add missing, union aliases.
3. **Cache-key stability** — `lib/pipeline.ts`: annotate/render cache keys
   derive from concepts + learner state ONLY. Hashing Jev probabilities (or
   argmax choices, or jev labels in `user_context`) busts the cache every run
   (one borderline flip per ~10 concepts is near-certain): repeats went
   ~70s → ~7s. Your `user_context` still embeds `jev.mastery_level`.
4. **Jev-outage fallback** — `decideConcept` falls back per-concept to
   `escalatePolicy` on Jev failure (we hit a TypeSafe 402 today; your route
   would have 500'd).

## Also available

5. `scripts/mine-doc-edits.ts` — manual .md edits from git history as
   evidence; Jev gates per-commit authorship (rejected ~90% of 4,006
   candidates as agent-authored — your "docs-freshness" worktree commits pass
   author-name filters), classifies removal reason (`removed_not_understood`
   = Gabe's self-reported signal; 107 events) and addition substance (277).
   Requires backfill's delete to preserve `source='doc_edit'`.
6. `scripts/eval-state.ts` / `tune-state.ts` — forward-chaining state-accuracy
   harness (18,685 outcomes; log loss + calibration + false-mastery split)
   that produced the FSRS priors you're already running.
7. `custom` representation completion — your fillRenderPlan prompt/schema in
   `lib/models/anthropic.ts` never mention `custom`, so the model has no
   documented way to emit `content.custom`. Our version adds the prompt rules
   + schema object (and `custom` in the escalate/annotate enums).
8. FYI: your 16:32 re-save of `lib/models/anthropic.ts` replaced the NUL
   separator in `hash()` (`join("\0")` → `join("")`) — invalidated your model
   caches and reintroduces theoretical part-boundary collisions.

Everything is in `../claude-wall-of-text` (git repo, clean history — `git log
--oneline` there narrates the changes). Data files are divergence-safe per
`data/derived-files.meta.json` provenance.
