# AnswerFit — 5-Minute Room Demo

**One answer, fitted to what each reader already knows.**

> Companion to [DEMO-RUNBOOK.md](DEMO-RUNBOOK.md) (operational pre-flight lives there).
> Tabs open before you start: ① answerfit.bighelp.ai ② localhost:3210 ③ localhost:3210/chat

---

## Beat 0 — Fire the chat FIRST (0:00, silent)

Before you say a word: in tab ③, ask the chat something real, e.g.

> *"Why does prompt caching break when I edit the top of my system prompt?"*

The full loop (generate → judge every concept against your history → plan → fold)
takes ~2 minutes. It cooks while you do beats 1–3; you return to it as the finale.

## Beat 1 — The pitch (0:15)

Tab ①, live site. Say:

> "Claude and Codex hand every developer the **same wall of text**. A beginner
> drowns; an expert skims three paragraphs re-explaining `rebase` to find the
> one new line. We built the fix: a model of what *you* specifically know —
> mined from 3,000+ of your own AI transcripts and ten years of searches —
> that re-fits every answer to *your* knowledge."

## Beat 2 — One answer, three readers (0:45)

Tab ②: **Git merge storm** sample → **⇆ Compare all** → **Personalize** (cached, fast).

Point at the three columns, same source text, colored differently:

- **Junior dev**: everything explained — diagrams, examples.
- **Git expert**: nearly everything suppressed; merge-storm is a one-line
  *"likely known"* he can expand.
- **Me (real history)**: `rebase` and `race condition` **suppressed** — it knows
  I know, from years of my own transcripts. Merge-storm gets the one diagram.

> "One primary visualization per answer, prerequisites taught in order, and the
> red caveat — *never force-push* — survives for **every** reader. Suppression
> never eats a warning."

## Beat 3 — It shows its work, and you can correct it (1:00)

Still tab ②, my column:

1. Open a suppressed card → **"Why we think this"** → real provenance:
   an actual search or chat message, with date. *"It's not a vibe — it cites
   my own history."*
2. Click **"Already knew this"** on any explained concept → **Personalize**
   again → it's now suppressed. *"The model updated live. My click is
   evidence, same as ten years of history."*

## Beat 4 — FINALE: live chat, answers born fitted (1:30)

Tab ③. The answer you fired in Beat 0 has been streaming and folding.

> "Everything so far re-rendered an *existing* answer. Chat mode goes further —
> the answer is **born fitted**. Watch the pipeline: it streamed the draft,
> judged all nine concepts against my history, then folded what I already know
> into one-line reminders and spent the space on what I don't."

Scroll the result: folded known-parts, expanded gaps, the diagram where a
diagram teaches best. If time allows, expand one folded section: *"the
explanation is there if I want it — it just doesn't cost me attention by default."*

## Beat 5 — It's always on (0:30)

> "And it's not an app you have to visit. A hook watches my real Claude Code
> sessions: every question I type becomes evidence, every long answer gets
> re-fitted in the background. When it finds real gaps I get one line —
> *⚡ 2 gaps: TOCTOU* — and silence means I knew everything. The model of me
> gets sharper every time I work."

Show the **Captured** strip in tab ② (or a real terminal if one is staged).

## Closer (0:15)

> "36,000 evidence events, 400+ concepts, memory that decays like real memory —
> and the state model is calibration-tested by forward-chaining prediction on
> held-out history, not vibes. Same answer, different reader, different page.
> That's AnswerFit."

---

## If things break

- **Chat is slow/stuck** → beats 1–3 are fully cached and carry the demo;
  narrate chat over the partial stream ("you can see it judging concepts live").
- **Network/API dies** → every sample × reader in tab ② is cache-warm; nothing
  in beats 2–3 needs the network.
- **Wrong feedback state** (rehearsed "already knew") → see runbook §6 to reset.
