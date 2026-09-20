# Designing a Personalized “Comprehension Compiler” for AI-Generated Information

## Executive recommendation

The strongest system I would build is **not** a generic “visual learner” wrapper and **not** a conventional student-modeling algorithm attached to an LLM. I would build a continuously updated **latent model of the user's concept-level knowledge**, plus a second model of **which pedagogical representation produces the most learning for that user in that situation**, and put those between the original AI response and a frontier generative model.

I will call it the **Adaptive Comprehension Compiler**.

Conceptually:

```text
                        LIVE USER EVIDENCE
       ┌───────────────────────────────────────────────────┐
       │ Claude/Codex conversations                        │
       │ ChatGPT conversations                             │
       │ Google searches                                   │
       │ YouTube searches                                  │
       │ Interactions with previous personalized answers   │
       └─────────────────────┬─────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │ Learner State Engine │
                  │                      │
                  │ What does user know?│
                  │ How certain are we? │
                  │ What was forgotten? │
                  │ Misconceptions?     │
                  │ What helped before? │
                  └──────────┬───────────┘
                             │
                             │ per-concept state
                             ▼
 ORIGINAL AI MESSAGE ──► Concept / proposition graph
                             │
                             ▼
                  ┌──────────────────────┐
                  │ Intervention Policy  │
                  │                      │
                  │ leave alone?        │
                  │ compress?           │
                  │ one-line reminder?  │
                  │ example?            │
                  │ diagram?            │
                  │ interactive sim?    │
                  └──────────┬───────────┘
                             │
                    pedagogical UI plan
                             ▼
                  Astra / Fable / other
                   frontier generator
                             │
                             ▼
               PERSONALIZED EXPLANATION UI
                             │
              interactions + later evidence
                             │
                             └────────► learner state
```

The key research result is that the pieces needed for this now exist separately, but the valuable product is in **joining them together**. Recent work already demonstrates LLM-based knowledge tracing with concept structure, continuously evolving learner profiles with memory and forgetting, dynamic persona tracking, and LLM-personalized educational material. TASA, for example, maintains both a structured proficiency profile and event memory, then updates mastery through knowledge tracing plus a forgetting model; SINKT uses LLM representations and explicit concept/question structure to address new concepts rather than relying only on fixed IDs. PAGE reports improved learning outcomes in a semester-long deployment of LLM-personalized educational material. citeturn19view0turn19view1turn19view2

There is also a strong reason **not simply to give a frontier model the user's entire history and say “personalize this.”** PersonaMem built histories as long as roughly one million tokens and found contemporary frontier models struggled to reliably track an evolving user state using straightforward prompting; performance in its response-selection benchmark was only around 50% overall. LaMP separately found value in retrieving relevant pieces of a user's profile rather than treating personalization as generic long-context generation. citeturn16view7turn20academia41

So my recommendation is a hybrid:

> **External, explicit, live-updating learner state + learned intervention policy + frontier generative renderer.**

I would use **Jev very heavily for the middle “decision” layer and for offline data labeling, but not as the main representation learner or explanation generator.** Jev was released only on September 15, 2026 and is specifically designed to take state and produce typed probabilistic decisions rather than prose. That makes its shape unusually well matched to questions such as *“Does this user already understand merge conflicts?”*, *“How much explanation does this span need?”*, and *“Which of these eight representation types should be used?”* TypeSafe currently lists $0.042 per million input tokens, free output tokens, and 70–500 ms end-to-end latency; those performance/calibration claims are from TypeSafe itself and should be independently validated on this task. citeturn22view1turn17view1turn17view2

For tomorrow's hackathon, I would build a smaller version of **exactly the same architecture**, rather than a disposable prototype based on a completely different idea.

## What the system should model

The biggest conceptual mistake would be to give every user a single embedding meaning something like:

```text
Sam:
  visual_learner = 0.91
  programming_skill = 0.78
  likes_details = 0.34
```

That throws away most of the information you actually possess.

The latent state should instead answer:

\[
P(K_{u,c,t}\mid E_{\le t})
\]

where \(K_{u,c,t}\) is what user \(u\) knows about **concept \(c\) at time \(t\)**, conditioned on all relevant evidence \(E\). Recent knowledge-tracing work increasingly treats uncertainty itself as important rather than reducing mastery to a single deterministic number; UKT and KeenKT explicitly represent uncertain/distributional learner states, and KeenKT reports gains over point-estimate approaches on six datasets. citeturn20academia42turn20academia40

I would make the state substantially richer than “known / unknown”:

```text
ConceptState {
    concept: "git merge storm"

    mastery: {
        recognize:     distribution,
        explain:       distribution,
        apply:         distribution,
        debug:         distribution
    }

    retrievability_now: probability
    uncertainty: probability

    misconceptions: [...]
    prerequisites: [...]

    last_positive_evidence: timestamp
    last_negative_evidence: timestamp

    evidence: [
        {source, timestamp, span, interpretation, weight},
        ...
    ]
}
```

This distinction matters. Someone can recognize “race condition,” be able to explain it, yet still fail to debug one in a distributed system. Conversely, they may never have heard the phrase “merge storm” while already understanding every prerequisite necessary to learn it in ten seconds.

TASA provides recent evidence for explicitly combining proficiency, interaction memory and forgetting rather than treating the learner state as static; SINKT provides evidence for using LLM-derived semantics and relationships between concepts to generalize to concepts that were not previously represented as fixed IDs. citeturn19view0turn19view1

### Your existing data is unusually valuable

The proposed data sources contain several kinds of supervision that ordinary tutoring systems do not receive.

Suppose yesterday Claude Code said:

> A merge storm can occur when...

and ten minutes later the user Googled:

```text
merge storm git meaning
```

That is not a perfect ground-truth label—the search could have been curiosity—but it is powerful evidence that the original explanation did not leave the concept comfortably understood.

Likewise:

```text
ChatGPT: "Can you explain race conditions?"
```

is high-quality evidence that race conditions were uncertain **before that interaction**.

Later:

```text
User: "This is actually a TOCTOU race because the check and write aren't atomic."
```

is evidence at a much higher competence level.

And:

```text
User: "I don't understand that."
```

after a long Codex response creates an **attribution problem** rather than a concept label. The system should assign a distribution over candidate antecedents:

\[
P(\text{confusion refers to span }i \mid
\text{message, next turn, later searches, history})
\]

rather than pretending it knows which sentence caused the problem.

This is exactly the kind of semantic inference for which I would use large modern models rather than older NLP pipelines. PersonaMem's results are particularly relevant here: multi-session interaction histories contain useful signals about evolving user traits, but simply stuffing the raw history into a model does not reliably reconstruct the current state. citeturn16view7

### Separate knowledge from presentation preference

I would maintain a second state:

\[
R_{u,c,q,a}
 =
P(\text{learning gain}\mid
u,c,q,\text{representation }a)
\]

where \(q\) represents the task/context and \(a\) could be:

```text
plain prose
compressed prose
analogy
worked example
code example
code diff
table
Git DAG
causal graph
sequence diagram
timeline
state machine
data-flow diagram
animation
interactive simulation
step-through visualization
nothing / leave original alone
```

This is much better than a global “visual learner” field.

The older empirical literature is quite skeptical of the strong “learning styles” hypothesis—that identifying someone as a visual or verbal learner and matching instruction to that label reliably improves learning. The classic evidence review found inadequate support for that matching hypothesis. citeturn15search31

But that does **not** mean your preference for visual explanations should be ignored. It means the system should learn a more precise relationship:

> **You + this concept + this task + this type of representation → measured utility.**

For example, the system could eventually learn:

```text
Git topology                → Git DAG is extremely useful
concurrency ordering        → interactive timeline is useful
race-condition definition   → diagram generally unnecessary
SQL window functions        → table + stepping example
API syntax                  → minimal code example
basic concept already known → suppress completely
```

That is a learnable policy, rather than a personality test.

## Recommended system: the Adaptive Comprehension Compiler

I would build Formulation A first, but make its internal interfaces suitable for eventually becoming Formulation B.

The pipeline has six major learned stages.

**The first stage is event ingestion and learner-state maintenance.** Every relevant historical event becomes an immutable evidence object rather than directly overwriting “what the user knows.”

For example:

```json
{
  "timestamp": "2026-09-18T21:14:00",
  "source": "google_search",
  "raw_text": "git merge storm meaning",
  "concept_candidates": ["git.merge_storm"],
  "signal": "explicit_information_seeking",
  "mastery_dimension": "recognition/explanation",
  "direction": "negative_or_uncertain",
  "strength": 0.82
}
```

A frontier model initially extracts new concepts, aliases, prerequisites and evidence semantics. You can later distill much of this into cheaper models.

**The second stage converts each incoming AI message into a semantic proposition/concept graph.** Do not merely chunk paragraphs. A sentence can contain four conceptual dependencies, and the same concept can span several paragraphs.

For the source:

```text
If both agents rebase repeatedly, you can create a merge storm:
each rebased branch invalidates work based on the previous history.
This isn't the same thing as a race condition...
```

the intermediate representation might look like:

```text
merge_storm
 ├── requires → git_merge
 ├── requires → rebase
 ├── requires → divergent_history
 ├── caused_by → repeated_concurrent_reintegration
 └── contrasts_with → race_condition
```

LLM-based structural concept modeling is already showing promise in knowledge tracing: SINKT uses LLM semantic representations to construct relationships among concepts/questions and specifically targets generalization to new concepts. citeturn19view1

**The third stage joins each concept with the user's current state.** Critically, retrieval should happen *concept by concept*. The runtime model does not need seven years of Google searches. For `merge_storm`, it might receive eight highly relevant pieces of evidence plus compressed prerequisite states.

This also makes privacy and provenance much easier: the UI can potentially say *“I inferred you're already comfortable with race conditions because you've used the concept correctly in three prior debugging conversations.”*

**The fourth stage is the pedagogical intervention policy.** This is the heart of the product.

For every semantic unit it chooses an action:

\[
a^* = \arg\max_a
E[
\Delta C
+\lambda\Delta R
-\alpha T
-\beta L
-\gamma A
]
\]

where:

- \(C\) = immediate comprehension,
- \(R\) = later retention,
- \(T\) = time cost,
- \(L\) = cognitive load/verbosity,
- \(A\) = annoyance from explaining something unnecessarily.

This is where personalization becomes much more interesting than “rewrite this simply.”

Suppose a response contains:

| Concept                                  |             Estimated state | Intervention               |
| ---------------------------------------- | --------------------------: | -------------------------- |
| race condition                           |          97% strong mastery | leave untouched / compress |
| Git rebase                               | 84% mastery, slightly stale | one-line reminder          |
| merge storm                              |                 14% mastery | explain                    |
| repeated rebases changing graph ancestry |                         31% | interactive Git DAG        |
| ordinary `git fetch` syntax              |                         99% | suppress explanation       |

Those numbers should be distributions with uncertainty, not claims of psychological ground truth. Recent uncertainty-aware KT work supports explicitly representing uncertainty rather than pretending learner state is directly observable. citeturn20academia42turn20academia40

**The fifth stage should create a pedagogical UI intermediate representation, not raw prose or arbitrary React immediately.** This is one of the strongest design recommendations in this report.

For example:

```json
{
  "blocks": [
    {
      "type": "source_summary",
      "detail": "minimal"
    },
    {
      "concept": "race_condition",
      "type": "inline_term",
      "mode": "no_explanation"
    },
    {
      "concept": "merge_storm",
      "type": "explanation",
      "depth": 2
    },
    {
      "concept": "merge_storm",
      "type": "git_dag_stepper",
      "steps": [...]
    }
  ]
}
```

Then your product owns reliable renderer components:

```text
Git DAG
timeline
sequence diagram
state machine
causal network
before/after diff
table stepper
stack/heap viewer
request waterfall
data-flow graph
interactive equation
```

Astra/Fable fills the semantic structure. Your React code renders it.

Only when nothing in the vocabulary can express the idea should the model emit a `custom_interactive` artifact.

This is superior to asking an LLM to generate arbitrary HTML for every explanation because it gives you a **trainable action space**. “Git DAG versus timeline versus prose” becomes a labeled decision. The output can also be tested automatically and cached.

**The sixth stage is a single frontier generation/rendering pass.** Your constraint about not parallel-generating multiple final explanations makes sense. I would not have five models generate five versions and choose one. The policy decides first; one powerful model then realizes the selected plan.

As of September 2026, both GPT‑6 Astra and Claude Fable 5.1 are priced at $10 per million ordinary input tokens and $50 per million output tokens; Astra's official model page gives a 1.05-million-token context window, while Fable 5.1 provides particularly inexpensive cache reads at $0.25/M tokens. Astra currently does not support fine-tuning, so it is especially natural as a renderer/orchestrator rather than the place where the persistent user state resides. citeturn18view0turn18view1turn18view2turn18view3turn18view4

The result is not merely a rewritten answer. It can be something like:

```text
Claude said three important things.

✓ Race conditions
  You appear to know this already; skipping the explanation.

? Merge storm
  New concept for you.

  A merge storm is what happens when several active branches repeatedly
  invalidate one another's integration work.

  [Interactive Git DAG: drag the timeline forward]

       A──B──C────F'────H'
          \      ↗
           D──E'
              ↖
               G──G'

  Step 1: Alice rebases...
  Step 2: Bob's branch is now based on stale ancestry...
  Step 3: ...

↻ Rebase
  You appear familiar with this, but here's the one relevant detail:
  rebasing rewrites commit ancestry.
```

That is qualitatively different from “make the text shorter.”

## Where Jev is genuinely useful

Jev is unusually well shaped for this architecture, but it is important to distinguish where it is excellent from where it is the wrong model.

TypeSafe describes Jev as a model that takes text or structured application state and answers predefined `Noul`, `Choice`, or `Score` questions. Choice responses include the full probability distribution and a confidence value; Score responses likewise return a distribution across rubric levels. Multiple judgments over the same state can be sent together. TypeSafe explicitly recommends decomposing systems into atomic decisions and composing them in ordinary code. citeturn22view0turn17view4turn17view3

That maps almost perfectly onto the policy layer.

A single request might contain:

```json
{
  "state": {
    "concept": "merge storm",
    "source_span": "...",
    "user_evidence": [...],
    "prerequisite_states": {...},
    "task_context": "understanding Claude Code response"
  },

  "questions": {
    "already_understands": {
      "type": "noul",
      "instructions": "Is there strong evidence the user already understands this concept?"
    },

    "mastery": {
      "type": "score",
      "criteria": [
        "unknown",
        "recognizes term",
        "can explain",
        "can apply",
        "fluent"
      ]
    },

    "intervention": {
      "type": "choice",
      "criteria": {
        "none": "...",
        "reminder": "...",
        "example": "...",
        "diagram": "...",
        "interactive": "..."
      }
    },

    "representation": {
      "type": "choice",
      "criteria": {
        "prose": "...",
        "git_dag": "...",
        "timeline": "...",
        "sequence": "...",
        "state_machine": "...",
        "code_example": "..."
      }
    }
  }
}
```

Jev would therefore have four especially compelling roles.

**At inference time, it can be the routing/policy model.** The expensive frontier model extracts genuinely novel semantic structure and eventually generates the explanation. Jev performs the dozens of repetitive judgments in between. TypeSafe explicitly documents confidence-gated routing and multi-question fan-out as intended architectural patterns. citeturn17view3turn22view1

**It can decide when *not* to call the expensive generator.** If a message contains no uncertain concepts and no representation change is predicted to help, simply show the original response. If Jev assigns low confidence to its own decision, escalate that specific decision to Astra/Fable. That is exactly the sort of confidence-gated architecture TypeSafe proposes. citeturn17view2turn17view3

**It is potentially outstanding for backfilling user histories.** At its currently advertised price, the raw Jev inference cost is approximately:

| Historical input processed | Jev input cost |
| -------------------------: | -------------: |
|          10 million tokens |      **$0.42** |
|                100 million |      **$4.20** |
|                  1 billion |        **$42** |
|                 10 billion |       **$420** |

Those figures are direct arithmetic from TypeSafe's current $0.042/M input-token price; its published pricing says output is unmetered/free. citeturn18view5

That changes what is economically plausible. You could use a high-end model once to generate/validate the ontology and labeling rubric, then send enormous volumes of historical events through Jev for questions such as:

```text
Does this utterance imply confusion?
Is the confusion concept-specific?
How strong is the evidence?
Does the user demonstrate application-level knowledge?
Does this search imply remedial learning intent?
Does this event supersede previous evidence?
```

**Jev also makes sense for internet-data curation.** But not directly on raw video. TypeSafe's current API documents its state as a string/object/array, and TypeSafe notes its current game-state demo is structured text rather than image input. So for YouTube-scale visual pedagogy data, I would use a multimodal VLM first and Jev second. citeturn22view0turn22view1

The pipeline would be:

```text
instructional video
      │
      ▼
frontier VLM
      │
      ├─ concept taught
      ├─ transcript segment
      ├─ visual technique
      ├─ causal/spatial/temporal structure
      ├─ pedagogical sequence
      └─ candidate quality metadata
      │
      ▼
Jev at enormous scale
      │
      ├─ is visualization actually explanatory?
      ├─ representation class?
      ├─ prerequisite level?
      ├─ visual complexity?
      ├─ example vs analogy vs demonstration?
      └─ useful training pair?
```

There is precedent for extracting training signal at this scale from instructional video. HowTo100M contains 136 million clips from 1.22 million narrated instructional videos, while the 2026 DenseStep2M work uses current multimodal/LLM components to automatically turn about 100,000 instructional videos into roughly two million temporally grounded instructional steps. citeturn19view7turn19view8

I would use that corpus to learn a **representation policy**, not merely a video-generation model. The useful training pair is:

\[
(\text{concept structure},\text{learner state},\text{goal})
\rightarrow
\text{representation strategy}
\]

For example:

```text
temporal ordering + concurrency
→ timeline / swimlane

branch ancestry
→ DAG

finite process with transitions
→ state machine

call interaction
→ sequence diagram

data transformation
→ data-flow graph

simple lexical definition
→ probably no diagram
```

There is one major caveat: Jev is four days old as of this report. Its latency, price, calibration and benchmark comparisons are largely vendor-reported. TypeSafe itself notes caveats and possible bias in its workflow evaluations. So I would run a few thousand hand-/frontier-labeled decisions through Jev before committing the learner-state updater to it. citeturn22view1

Also, the slogan that it “can't hallucinate” should not be interpreted as “can't be wrong.” Its restricted output schema can prevent malformed or invented output types; it can still choose the semantically wrong option. The probability distribution is useful precisely because those decisions remain uncertain. citeturn17view1turn17view2

## Integrated and alternative architectures

I see four serious architectures. They are not equally good.

| Architecture                                       | Quality ceiling       | Live-state fidelity | Build difficulty | Recommendation       |
| -------------------------------------------------- | --------------------- | ------------------- | ---------------- | -------------------- |
| **Adaptive Comprehension Compiler**                | Very high             | Excellent           | Medium           | **Build this first** |
| Context-integrated personalized LLM                | High                  | Excellent           | Low–medium       | Strong alternative   |
| Learned user embedding / adapter + external memory | Potentially very high | Excellent if hybrid | High             | Funded project       |
| Fully end-to-end personalized foundation model     | Unknown/high          | Difficult           | Very high        | Research program     |

### Context-integrated personalized LLM

This is the simplest version of Formulation B.

Instead of translating an already produced answer:

```text
Codex answer → translator → user
```

you intercept the original request and generate directly:

```text
user request
     +
retrieved learner state
     +
pedagogical policy
     ↓
frontier LLM
     ↓
personalized answer
```

The model receives something like:

```xml
<user_knowledge>
race_condition:
  application mastery: high
  evidence confidence: high

git_rebase:
  mastery: medium/high

merge_storm:
  no positive evidence
  one recent remedial search
  posterior: likely unknown
</user_knowledge>

<presentation_policy>
Do not define concepts rated fluent.
Use diagrams only when predicted value exceeds prose.
For merge_storm, use an interactive Git DAG.
</presentation_policy>
```

This avoids the information loss inherent in translating an answer that was already written for somebody else.

It is probably where the product should eventually go.

But I would still preserve the **external learner-model service**. PersonaMem's results are a warning against assuming the generator will reliably reconstruct dynamic preferences from giant raw histories on its own. citeturn16view7

In other words, Formulation B should mean:

> **Generate directly from explicitly retrieved user state.**

It should *not* mean:

> **Give the LLM every conversation the user has ever had and hope it figures them out.**

### Learned user representation plus external concept memory

The more ambitious integrated architecture learns a persistent user representation:

\[
z_u = f_\theta(H_u)
\]

and injects it into the language model, while retaining rapidly changing concept mastery outside the weights.

There is already research precedent for injecting parameterized user memory into an LLM. MiLP explores PEFT/LoRA-based memory injection derived from historical user content and reports improvements on its personalization benchmarks, although the authors note significant compute requirements and scaling limitations—their setup was designed for a single user and reports a minimum of four A100s for their search procedure. citeturn16view9

I would modify this idea substantially.

Do **not** use per-user weights to store:

```text
"Sam learned merge storms yesterday."
```

That state changes too fast.

Use them to store stable or slowly changing tendencies:

```text
prefers directness
responds well to spatial manipulation
technical vocabulary baseline
likes counterexamples
tends to skip long prose
benefits from code before abstraction
```

Then keep knowledge state in an external differentiable/retrievable memory:

```text
stable user latent z_u        slow update
        +
concept memory K_u(t)         fast update
        +
current task
        ↓
cross-attention / conditioning
        ↓
decoder
```

That is, in my view, the right eventual Formulation B.

### Native learner-state architecture

For a well-funded research effort, I would go one step further and modify an open-weight decoder to have a **dedicated learner-state encoder**.

```text
                    ┌──────────────────┐
historical events ─►│ Learner encoder  │──► user-state tokens
                    └──────────────────┘          │
                                                  ▼
current prompt ───────────────► LLM self-attention + cross-attention
                                                  │
concept memory ───────────────────────────────────┘
                                                  │
                                                  ▼
                                     personalized generation
```

Train it jointly on three tasks:

\[
L =
L_{\text{generation}}
+\lambda_1 L_{\text{knowledge-state}}
+\lambda_2 L_{\text{pedagogical-outcome}}
\]

The model must therefore both produce the answer **and predict the learner state/outcome that justifies its answer**.

This offers an interesting research advantage: knowledge-state prediction acts as an auxiliary task rather than personalization being an invisible side effect of generation.

I would still retain explicit external memory. A user's knowledge can change after one five-minute interaction; requiring gradient updates to reflect that would be operationally absurd.

### Jev-only personalization overlay

There is also an aggressively simple alternative that may actually make the best demo tomorrow:

```text
raw response
  ↓
Astra/Fable extracts concepts once
  ↓
retrieve history
  ↓
Jev:
  known?
  explain?
  representation?
  depth?
  ↓
deterministic UI templates
  ↓
frontier model fills only unknown concepts
```

This lacks a sophisticated learned knowledge-state transition model, but it could already demonstrate the important product behavior:

**One original message → radically different renderings for different people.**

That is much more compelling at a hackathon than spending the entire day building a mathematically elegant knowledge-tracing backend nobody can see.

## Data flywheel, training, and evaluation

The system becomes truly defensible once interaction with the product generates better training data than you began with.

The canonical training object should look approximately like:

```json
{
  "source_message": "...",

  "user_state_before": {
    "concept_states": {...},
    "representation_history": {...}
  },

  "retrieved_evidence": [...],

  "analysis": {
    "concept_graph": {...},
    "confusion_attribution": {...}
  },

  "action": {
    "intervention": "...",
    "representation": "...",
    "depth": "..."
  },

  "rendered_explanation": {...},

  "outcomes": {
    "immediate": {...},
    "later": {...}
  },

  "user_state_after": {...}
}
```

The crucial part is **outcomes**.

Clicks alone are terrible ground truth for learning. A beautiful animated DAG may get clicked because it is fun while teaching less than a six-line example.

The UI should therefore collect several tiers of evidence.

**Implicit immediate signals** include expanding an explanation, collapsing it as unnecessary, hovering/rewinding an animation, asking a follow-up linked to a particular span, opening an example, running/copying code, or explicitly clicking “I already knew this.”

**Natural delayed signals** are even more valuable. The user later asks what the concept means again; searches externally for it; correctly applies it in a subsequent coding conversation; correctly diagnoses a bug using it; or uses terminology coherently without assistance.

**Occasional explicit measurement** could be tiny and optional:

```text
Quick check:
Why did rebasing Alice's branch invalidate Bob's merge work?

[A] ...
[B] ...
[C] ...
```

The user need not feel like they are taking a course. A small percentage of interactions can provide high-quality labels that calibrate the huge sea of noisy behavioral evidence.

This distinction matters because success on the immediate activity does not imply durable learning. In a 2025 study of 148 students, an LLM tutoring system improved homework performance but did not produce a statistically significant overall improvement in exam performance; the authors also found signs of possible over-reliance. By contrast, Tutor CoPilot's randomized trial with 900 tutors and 1,800 students found a four-percentage-point increase in topic mastery, with a nine-point improvement for students of lower-rated tutors; its analysis tied the system to changes in pedagogical strategies rather than merely answer generation. citeturn19view5turn19view6turn19view3

That suggests your reward should explicitly distinguish:

\[
\text{“user got unstuck”}
\]

from

\[
\text{“user acquired a reusable mental model.”}
\]

They are different product objectives.

### The training flywheel

I would train the eventual system in roughly this order:

```text
Stage A
Raw histories
    ↓
frontier teacher extracts concepts/evidence
    ↓
human spot-check
    ↓
high-quality learner-state corpus

Stage B
High-quality labels
    ↓
distill repetitive judgments to Jev / smaller policy model
    ↓
backfill huge history

Stage C
Internet instructional media
    ↓
VLM extraction
    ↓
representation taxonomy + quality labels
    ↓
train representation policy

Stage D
Real product deployment
    ↓
observe user outcomes
    ↓
contextual-bandit / reward-model learning
    ↓
personalized policy improves per user

Stage E
Large multi-user dataset
    ↓
train integrated learner encoder / personalized model
```

A very valuable training trick would be to build **counterfactual examples**.

For the same underlying source message and concept state, generate:

```text
A: no explanation
B: prose
C: example
D: static diagram
E: interactive diagram
```

You do not need to serve all five to one user. Across users/experiments, selectively randomize among plausible alternatives. That lets you estimate:

\[
E[\text{learning outcome} \mid a]
\]

rather than training on historical correlations like “people who were most confused happened to receive the most elaborate diagrams.”

Eventually, this is naturally a **contextual-bandit** problem:

```text
context:
  user
  concept
  current mastery
  uncertainty
  task
  source material
  available screen/device

actions:
  none / prose / example / DAG / timeline / ...

reward:
  immediate comprehension
  + delayed retention
  - reading time
  - unnecessary explanation
  - annoyance
```

The frontier LLM can remain the renderer while a much smaller learned policy becomes increasingly good at choosing *what should be rendered*.

### Evaluation should have three separate scorecards

**Learner-state accuracy** should ask whether the system's probabilities predict later evidence. Use temporal holdouts—future interactions cannot leak into the past—and score calibration/Brier or log loss as well as ranking accuracy. Recent uncertainty-aware KT work reinforces the usefulness of preserving uncertainty in this state. citeturn20academia42turn20academia40

**Policy quality** should measure time to understanding, delayed retrieval/application, unnecessary-intervention rate, follow-up confusion, and representation regret.

**Generation quality** should separately measure factual fidelity to the original agent answer. The personalized renderer must never delete an important caveat simply because the concept classifier thinks the user knows it.

The experiment I would most want to run is:

| Condition                    | Knowledge-aware? | Representation-aware? |
| ---------------------------- | ---------------- | --------------------- |
| Original Codex/Claude        | No               | No                    |
| Generic “make concise”       | No               | No                    |
| Personal writing preferences | No               | Weak                  |
| Knowledge adaptation         | Yes              | No                    |
| Full compiler                | Yes              | **Yes**               |

Measure both **task completion now** and **correct use of the concept later**.

## Costs, implementation path, and verdict

Current frontier-model economics make the architecture surprisingly feasible because the expensive generative model does not have to do every classification.

With both Astra and Fable 5.1 currently at $10/M normal input tokens and $50/M output tokens, a representative final render costs approximately:

| Final frontier call                 | Approximate model cost |
| ----------------------------------- | ---------------------: |
| 10k input + 2k output               |              **$0.20** |
| 20k input + 4k output               |              **$0.40** |
| 10k input + 8k output, elaborate UI |              **$0.50** |

These are token-only estimates from current published prices and exclude tools/hosting. Astra offers Batch/Flex at half its standard token rates; Fable's cache reads are $0.25/M, so stable rendering instructions, schemas and large repeated prefixes can be much cheaper when cacheable. citeturn18view0turn18view4

The Jev routing layer is orders of magnitude cheaper at its currently published pricing: a 10,000-token state costs about **$0.00042** in input inference. TypeSafe currently advertises 70–500 ms response times, although both price and speed should be treated as early-access vendor figures rather than long-established production guarantees. citeturn18view5turn18view6

For large-scale synthetic/teacher data, a useful planning number is that **500 million Astra/Fable input tokens plus 100 million output tokens would cost about $10,000** at today's uncached standard flagship rates. The same 500 million tokens passed through Jev for structured curation would cost about **$21**. This is why I would spend frontier-model compute on difficult semantic discovery and use Jev for repeated judgments once the taxonomy exists. citeturn18view0turn18view3turn18view5

My engineering budget estimates—not vendor quotes—would look like this:

| Version                                         | What it contains                                             |                              Time |       Approximate incremental compute/API budget |
| ----------------------------------------------- | ------------------------------------------------------------ | --------------------------------: | -----------------------------------------------: |
| **Hackathon**                                   | concept extraction, small user memory, Jev policy, 4–6 visual components, one frontier render |                             1 day |                                      **$10–$50** |
| **Serious prototype**                           | live ingestion, temporal evidence store, concept graph, feedback instrumentation, 10–20 renderers, eval set |                        1–2 months |        **$1k–$20k** API/compute plus engineering |
| **Production research system**                  | learned mastery model, representation reward model, contextual bandit, internet visual corpus, privacy infrastructure |                       6–12 months | **$100k–$1M+** compute/data/evaluation plus team |
| **Native personalized foundation-model effort** | user encoder, end-to-end training, large multimodal pedagogy corpus, extensive controlled evaluation | multi-year-scale research project |                plausibly **millions of dollars** |

The latter two ranges are deliberately order-of-magnitude project estimates, because the dominant unknown is not token pricing—it is how much multimodal training, human evaluation and model adaptation you decide to perform.

For the **hackathon tomorrow**, I would reduce the system to this:

```text
Browser/paste input
      │
      ▼
Claude/Codex answer
      │
      ▼
Astra or Fable
extract:
 - concepts
 - prerequisites
 - semantic structure
      │
      ▼
SQLite/Postgres user memory
with manually seeded or imported history
      │
      ▼
Jev
 - does user know it?
 - how deep?
 - which representation?
      │
      ▼
Structured pedagogical UI JSON
      │
      ▼
one frontier generation call
      │
      ▼
React
 ├── prose
 ├── code
 ├── Git DAG
 ├── sequence diagram
 ├── timeline
 └── state machine

Buttons:
[Already knew this]
[Still confused]
[More detail]
[Show visually]
```

I would deliberately demo **two or three simulated users against the exact same Claude Code response**.

For example:

```text
USER A — experienced distributed-systems engineer
race condition: fluent
Git internals: moderate
merge storm: unknown
visual response to Git DAGs: high

→ output explains only merge storm
→ shows one small Git DAG
→ leaves race-condition terminology untouched
```

versus:

```text
USER B — junior frontend engineer
race condition: uncertain
Git internals: weak
merge storm: unknown
step-through visualizations historically effective

→ output introduces concurrency ordering
→ interactive timeline
→ then Git DAG
→ explains why the concepts differ
```

versus:

```text
USER C — senior Git expert
everything in answer: high confidence known

→ basically shows the original answer,
   compressed by 35%,
   with no diagrams.
```

That demonstrates the core thesis much more powerfully than showing that an LLM can make diagrams.

The deepest product insight here is:

> **The product should not learn how the user “likes answers written.” It should learn the boundary of the user's current understanding, and then spend explanatory bandwidth only across that boundary.**

The research now points in that direction. TASA shows the value of explicit evolving mastery, memory and forgetting; SINKT shows that LLM semantics can generalize concept models beyond fixed IDs; PersonaMem demonstrates why dynamic user state should not be entrusted to naive long-context prompting; PAGE provides evidence that LLM personalization can improve actual educational outcomes; uncertainty-aware KT argues against pretending mastery is known exactly; and tutoring trials show that pedagogical strategy and durable learning must be measured separately from simply making an immediate task easier. citeturn19view0turn19view1turn16view7turn19view2turn20academia42turn19view3turn19view5

**The architecture I would bet on for a company is therefore neither pure Formulation A nor pure Formulation B.** It is a hybrid:

\[
\boxed{
\text{External live learner state}
+
\text{learned pedagogical policy}
+
\text{frontier generator}
+
\text{instrumented adaptive UI}
}
\]

Start with the translation layer because it can sit on top of Claude Code, Codex, ChatGPT, documentation, email, papers, or anything else. As data accumulates, move the same state and policy **upstream** so the underlying model generates the personalized response directly. Keep the learner model outside the generative model even then, because the most important property of the entire system is that **what it believes about you can change after every interaction**.