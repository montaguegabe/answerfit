import { jevJudge, jevAvailable, type JevQuestion, type JevChoiceAnswer, type JevNoulAnswer, type JevScoreAnswer } from "./models/jev";

/**
 * Evidence interpretation: turn a raw history event that mentions a concept
 * into (dimension, direction, strength). Heuristics give a cheap prior;
 * Jev refines it per the smaller-plan Day 1 backfill step.
 */

export interface RawHistoryEvent {
  action: string; // "Searched for" | "Visited" | "Watched"
  title: string;
  timestamp: string;
  source: "google_search" | "google_visit" | "youtube_search" | "youtube_watch";
}

export interface Interpretation {
  dimension: "recognition" | "explain" | "apply" | "debug";
  direction: number; // signed
  strength: number; // 0..1
  interpretation: string;
  judge: "heuristic" | "jev";
}

const REMEDIAL = /\b(what is|what does|meaning|explained|explain|tutorial|how to|how do|introduction to|basics|for beginners|vs\.?|difference between|definition)\b/i;
const TROUBLE = /\b(error|not working|fails?|failed|broken|fix|issue|problem|cannot|can't|why (is|does|won't))\b/i;

export function heuristicInterpret(ev: RawHistoryEvent): Interpretation {
  const t = ev.title;
  if (ev.source === "youtube_watch") {
    return { dimension: "recognition", direction: -0.3, strength: 0.4, interpretation: "watched_related_video", judge: "heuristic" };
  }
  if (REMEDIAL.test(t)) {
    return { dimension: "recognition", direction: -0.8, strength: 0.8, interpretation: "seeking_basic_understanding", judge: "heuristic" };
  }
  if (TROUBLE.test(t)) {
    // Troubleshooting a thing implies working with it (weak apply-positive).
    return { dimension: "apply", direction: 0.3, strength: 0.6, interpretation: "troubleshooting", judge: "heuristic" };
  }
  if (ev.source === "google_visit") {
    return { dimension: "recognition", direction: 0.1, strength: 0.3, interpretation: "visited_related_page", judge: "heuristic" };
  }
  // Casual/specific query using the term without asking what it is.
  return { dimension: "apply", direction: 0.25, strength: 0.5, interpretation: "casual_usage", judge: "heuristic" };
}

const JEV_EVENT_QUESTIONS = (conceptName: string): Record<string, JevQuestion> => ({
  learning_intent: {
    type: "noul",
    instructions: `Does this history event indicate the user was actively trying to learn or understand "${conceptName}" (as opposed to incidental mention, entertainment, or routine usage)?`,
  },
  signal: {
    type: "choice",
    instructions: `What does this event imply about the user's knowledge of "${conceptName}" at that moment?`,
    criteria: {
      seeking_basic_understanding: "User does not yet understand the concept and is looking for a basic explanation or definition",
      seeking_advanced_detail: "User understands the basics and is digging into advanced or specific aspects",
      troubleshooting: "User is actively working with the concept and debugging a problem, implying working knowledge",
      demonstrates_knowledge: "The phrasing shows fluent, correct, specific use of the concept",
      incidental: "The concept mention is incidental; little can be inferred",
    },
  },
  strength: {
    type: "score",
    instructions: `How strong is this single event as evidence about the user's knowledge of "${conceptName}"?`,
    criteria: ["negligible", "weak", "moderate", "strong", "decisive"],
  },
});

const SIGNAL_MAP: Record<string, { dimension: Interpretation["dimension"]; direction: number }> = {
  seeking_basic_understanding: { dimension: "recognition", direction: -0.8 },
  seeking_advanced_detail: { dimension: "explain", direction: 0.35 },
  troubleshooting: { dimension: "apply", direction: 0.3 },
  demonstrates_knowledge: { dimension: "apply", direction: 0.7 },
  incidental: { dimension: "recognition", direction: 0.05 },
};

export async function jevInterpret(ev: RawHistoryEvent, conceptName: string): Promise<Interpretation> {
  const res = await jevJudge(
    {
      event_type: ev.action,
      platform: ev.source,
      text: ev.title,
      timestamp: ev.timestamp,
      concept: conceptName,
    },
    JEV_EVENT_QUESTIONS(conceptName)
  );
  const signal = res.answers.signal as JevChoiceAnswer;
  const intent = res.answers.learning_intent as JevNoulAnswer;
  const strength = res.answers.strength as JevScoreAnswer;
  const mapped = SIGNAL_MAP[signal.choice] ?? SIGNAL_MAP.incidental;
  // Normalize score (0..4 rubric, 0-indexed legend) to 0..1, damp by choice confidence.
  const strengthNorm = Math.max(0, Math.min(1, strength.score / 4)) * (0.5 + 0.5 * signal.confidence);
  return {
    dimension: mapped.dimension,
    // Negative-direction evidence only counts when learning intent is plausible.
    direction: mapped.direction < 0 ? mapped.direction * Math.max(0.3, intent.noul) : mapped.direction,
    strength: strengthNorm,
    interpretation: signal.choice,
    judge: "jev",
  };
}

export async function interpretEvent(ev: RawHistoryEvent, conceptName: string, useJev: boolean): Promise<Interpretation> {
  if (useJev && jevAvailable()) {
    try {
      return await jevInterpret(ev, conceptName);
    } catch {
      return heuristicInterpret(ev); // per-event fallback keeps the backfill running
    }
  }
  return heuristicInterpret(ev);
}

// ---------- chat transcript evidence (detailed-plan: confusion points in chat history) ----------

export interface ChatEvent {
  ts: string;
  source: "claude_code" | "codex";
  user_text: string;
  prev_assistant_tail: string;
}

export const CONFUSION = /(don'?t (understand|get|follow)|what does (that|this|it) mean|what (is|are|does|do you mean)|i'?m (confused|lost)|can you explain|explain (that|this|what)|huh\?|wait,? (what|why)|why (is|does|did|would))/i;

const CHAT_SIGNAL_MAP: Record<string, { dimension: Interpretation["dimension"]; direction: number }> = {
  expresses_confusion: { dimension: "explain", direction: -0.9 },
  asks_for_explanation: { dimension: "recognition", direction: -0.85 },
  asks_advanced_question: { dimension: "explain", direction: 0.4 },
  uses_correctly: { dimension: "apply", direction: 0.75 },
  corrects_assistant: { dimension: "debug", direction: 0.9 },
  incidental: { dimension: "recognition", direction: 0.05 },
};

const JEV_CHAT_QUESTIONS = (conceptName: string): Record<string, JevQuestion> => ({
  signal: {
    type: "choice",
    instructions: `This is a message the user typed to an AI coding assistant (with the assistant's preceding message for context). What does it imply about the user's knowledge of "${conceptName}" at that moment?`,
    criteria: {
      expresses_confusion: `User signals they did not understand something involving "${conceptName}" (possibly reacting to the assistant's preceding message)`,
      asks_for_explanation: `User asks what "${conceptName}" is or how it works — basic information seeking`,
      asks_advanced_question: `User asks a specific/advanced question that presupposes understanding the basics of "${conceptName}"`,
      uses_correctly: `User employs "${conceptName}" fluently and correctly while directing work`,
      corrects_assistant: `User correctly corrects or challenges the assistant about "${conceptName}" — expert-level signal`,
      incidental: "The concept mention is incidental; little can be inferred",
    },
  },
  strength: {
    type: "score",
    instructions: `How strong is this single message as evidence about the user's knowledge of "${conceptName}"?`,
    criteria: ["negligible", "weak", "moderate", "strong", "decisive"],
  },
});

export function heuristicInterpretChat(ev: ChatEvent, conceptInUserText: boolean): Interpretation {
  if (!conceptInUserText) {
    // Concept only appears in the assistant's preceding message → attributed confusion.
    return { dimension: "explain", direction: -0.8, strength: 0.6, interpretation: "confusion_about_prior_message", judge: "heuristic" };
  }
  if (CONFUSION.test(ev.user_text)) {
    return { dimension: "recognition", direction: -0.7, strength: 0.7, interpretation: "asks_for_explanation", judge: "heuristic" };
  }
  return { dimension: "apply", direction: 0.4, strength: 0.55, interpretation: "uses_correctly", judge: "heuristic" };
}

export async function interpretChatEvent(
  ev: ChatEvent,
  conceptName: string,
  conceptInUserText: boolean,
  useJev: boolean
): Promise<Interpretation> {
  if (useJev && jevAvailable()) {
    try {
      const res = await jevJudge(
        {
          platform: ev.source,
          user_message: ev.user_text,
          preceding_assistant_message_excerpt: ev.prev_assistant_tail.slice(-500),
          concept: conceptName,
          concept_appears_in: conceptInUserText ? "user_message" : "preceding_assistant_message_only",
        },
        JEV_CHAT_QUESTIONS(conceptName)
      );
      const signal = res.answers.signal as JevChoiceAnswer;
      const strength = res.answers.strength as JevScoreAnswer;
      const mapped = CHAT_SIGNAL_MAP[signal.choice] ?? CHAT_SIGNAL_MAP.incidental;
      return {
        dimension: mapped.dimension,
        direction: mapped.direction,
        strength: Math.max(0, Math.min(1, strength.score / 4)) * (0.5 + 0.5 * signal.confidence),
        interpretation: signal.choice,
        judge: "jev",
      };
    } catch {
      return heuristicInterpretChat(ev, conceptInUserText);
    }
  }
  return heuristicInterpretChat(ev, conceptInUserText);
}
