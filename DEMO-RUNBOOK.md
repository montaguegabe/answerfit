# AnswerFit — Demo Runbook

**One answer, fitted to what each reader already knows.**

| | |
|---|---|
| **App (compare view)** | [localhost:3210](http://localhost:3210) |
| **App (live chat)** | [localhost:3210/chat](http://localhost:3210/chat) |
| **Marketing site** (opener only — not the app) | [answerfit.bighelp.ai](https://answerfit.bighelp.ai) |
| **Repo** | [github.com/montaguegabe/answerfit](https://github.com/montaguegabe/answerfit) |
| **Sundai** | [sundai.club project page](https://www.sundai.club/projects/29533e39-75fb-47f1-908e-b0a6779111ad) |

---

## 0 · Pre-flight (do this ~5 min before)

- [ ] **Dev server up** → `npm run dev` (port **3210**). Confirm [localhost:3210](http://localhost:3210) loads.
- [ ] **Keys present** → `.env` has `ANTHROPIC_API_KEY` + `JEV_API_KEY` (`cp ~/Developer/.env .env` if missing).
- [ ] **Warm the cache** → click **Personalize** once on the Git merge storm sample so the first live run isn't the demo. Repeat runs of the same answer are near-instant (SQLite `model_cache`).
- [ ] **Readers seeded** → the Reader row shows three chips: **Senior git expert**, **Junior frontend dev**, **Gabe (real history)**. If not: `npm run seed-personas`.
- [ ] **Clean feedback state** → if you rehearsed the "Already knew this" moment, that feedback persists in SQLite. Re-seed or clear it so the live state-change lands fresh (see §6).
- [ ] **Browser** → tabs on [localhost:3210](http://localhost:3210) and [localhost:3210/chat](http://localhost:3210/chat), zoom ~110%, close the console. Optional third tab: the [marketing site](https://answerfit.bighelp.ai) as the opener.
- [ ] **Network** → Jev (`api.typesafe.ai`) + Anthropic reachable. No VPN weirdness.

> Everything in `data/`, `reports/`, and the DB is gitignored — safe to screen-share the repo.

---

## 1 · The pitch (30 seconds, say this)

> "Claude Code and Codex hand every developer the **same wall of text**. A beginner drowns in jargon; an expert skims three paragraphs re-explaining `rebase` to find the one new line. Same answer, wrong fit for everyone.
>
> **AnswerFit re-renders any AI answer for the person reading it.** The jargon you already know collapses out of the way; the parts that are new to you bloom into explanations you'll actually get. It knows what you know from evidence you already generate — your search history and your own Claude Code & Codex transcripts."

*(Optional opener: show the [marketing site](https://answerfit.bighelp.ai), scroll the animated pipeline diagram, then switch to the local app.)*

---

## 2 · How it works (one breath, point at the status line)

When you hit Personalize, the app literally prints the pipeline:

> **Fable extracts → Jev judges each concept → Fable resolves the plan → fills content…**

1. **Fable** (`claude-fable-5`) turns the answer into a **concept graph** (1 cached call).
2. **Jev** (TypeSafe System One) scores each concept against the reader's **learner state**, returning a calibrated probability they already understand it.
3. **Policy gate** decides per concept: `already_understands` → suppress · `intervention` → explain · pick a **representation**. Jev confidence < 0.5 escalates to Fable.
4. **Renderers** rebuild the answer in place.

---

## 3 · Main demo — the compare view (the money shot)

**Sample:** `Git merge storm (synthetic spec example)` · **Reader:** start on `Gabe (real history)`.

1. **Select the sample** — click the **Git merge storm** chip in the Sample row. The answer fills the textarea.
2. **Personalize for Gabe** — Reader = **Gabe (real history)** → click **Personalize**.
   - **Expect:** the source answer comes back **color-coded**, and concept cards appear below.
   - **Legend to narrate:**
     - ~~struck / dim~~ = **known** → suppressed
     - one-line = **reminder**
     - highlighted = **explain** (full treatment, e.g. interactive **git DAG**, timeline, code)
     - underlined = **caveat** — preserved for *everyone*, even experts
   - **Call out the provenance:** the race-condition concept gets a one-line reminder because Gabe's real 2018–19 Django race-condition searches are in his history; `git rerere` gets a code example.
3. **⇆ Compare all** — click the **⇆ Compare all** chip → **Personalize**.
   - **Expect:** three columns, one per reader, from the **same answer**:
     - **Senior git expert** — almost everything suppressed (knows it all).
     - **Junior frontend dev** — most concepts expanded with full explanations.
     - **Gabe** — the personalized middle ground.
   - **The line to say:** *"Same input. Three radically different renderings. Nobody reads what they already know."*
4. **Point at the timing footer** — `extract · policy · annotate · render` ms. Mention repeats are cache-hits (near-instant, free).

---

## 4 · The live state-change (the "wow", keep for last)

1. Back to single reader **Gabe**, Git merge storm personalized.
2. On the **Merge storm** concept card, click **Already knew this**.
3. Click **Personalize** again.
   - **Expect:** merge storm is now **suppressed** — Jev agrees with confidence ≈ **0.93**. The answer visibly reshapes.
   - **The line:** *"One tap. My learner state updated, and the very next answer is different. It compounds — it grows with you."*

> Feedback buttons on every card: **Already knew this** (`already_knew`) and **More detail** (`more_detail`).

---

## 5 · Optional B-sides (if there's time / questions)

- **Chat mode** — [localhost:3210/chat](http://localhost:3210/chat): answers arrive **already fitted** as you chat. Reader presets: *Junior frontend dev* / *Senior git expert*. Placeholder: *"Ask anything — the answer gets fitted to what you already know."*
- **Real Claude Code samples** — swap in `Why the API browns out…`, `The zombie voice call…`, or `openbase-coder provision…` (mined from real transcripts) to show it's not just the synthetic git example.
- **Live capture loop** — a Claude Code **Stop hook** feeds every real session back in. The **Captured** strip shows recent captures (`⚡n` = gaps, `✓` = all-known); click one to open its fitted rendering. *(Needs the dev server running; fails silent otherwise.)*
- **How it knows you** — search/watch history + your own Claude Code & Codex transcripts (Jev-judged), "didn't-land" remedial-search signals, and one-tap feedback.

---

## 6 · Reset between rehearsals

- The **Already knew this** feedback is written to SQLite and **persists**. To re-arm the §4 moment, clear Gabe's feedback events (or re-seed) so merge storm reads as a gap again.
- If a run looks stale, it's the **model cache** doing its job (same answer + same state = cached). Editing the answer text or the reader's state forces a fresh generation.
- Inspect any reader's state: `npm run inspect gabe` (optionally a concept id).

---

## 7 · Troubleshooting (live)

| Symptom | Fix |
|---|---|
| Personalize hangs / 500 | Check Jev reachable (`api.typesafe.ai`); per-concept it falls back to Fable on Jev failure. Re-run — cache makes retry fast. |
| No Reader chips | `npm run seed-personas`, refresh. |
| "Already knew this" didn't change anything | You're seeing a cache hit from before the feedback, **or** feedback didn't register — re-run Personalize; explicit feedback overrides Jev unconditionally. |
| Everything expanded for Gabe | History/backfill not loaded — `npm run backfill` (or `-- --heuristic-only` offline). |
| Captured strip empty | Expected unless a Claude Code session ended with the server up. |

---

## 8 · One-liners for Q&A

- **"Does it change what the AI says?"** — No. It's an *overlay*: it decides what to collapse, expand, and how to render — never rewrites the facts. Caveats are preserved for every reader.
- **"Where does the learner model come from?"** — Evidence you already generate: search/watch history + your own Claude Code/Codex transcripts, judged by Jev. Stored locally as an immutable evidence log; state is always recomputable.
- **"Jev vs. Fable?"** — Jev = calibrated *does-this-person-know-it* probabilities. Fable = extracts the concept graph and writes the fitted content. Low-confidence Jev → escalate to Fable.
- **"How accurate is the gate?"** — Intervention class **92.9%** agreement when Jev clears its 0.5 confidence gate; representation choice **89.1%**.

*Deep breath. Lead with the compare view. End on the live state-change.*
