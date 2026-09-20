import crypto from "crypto";
import { db } from "./db";
import { addEvidence, refreshState } from "./mastery";
import { matchConcepts } from "./taxonomy";
import { interpretChatEvent, CONFUSION, type ChatEvent } from "./interpret";
import { personalize, finalVerdict, type ConceptBlock } from "./pipeline";

/**
 * Live capture loop (Claude Code Stop hook → here):
 *  - the user's new messages become evidence immediately (same interpretation
 *    path as the backfill, so live and historical evidence are identical)
 *  - the assistant's answer is queued and personalized in the background,
 *    with annotate/render skipped when the policy finds no gaps
 */

const MIN_ANSWER_LEN = 400;
const HEAVY = new Set(["example", "diagram", "interactive"]);

export interface CaptureUserMessage {
  ts: string;
  text: string;
  prev_assistant_tail?: string;
}

export async function ingestLiveMessages(userId: string, messages: CaptureUserMessage[]): Promise<number> {
  let added = 0;
  for (const m of messages) {
    const ev: ChatEvent = {
      ts: m.ts,
      source: "claude_code",
      user_text: m.text.slice(0, 1500),
      prev_assistant_tail: m.prev_assistant_tail ?? "",
    };
    let concepts = matchConcepts(ev.user_text);
    let inUserText = true;
    if (concepts.length === 0 && CONFUSION.test(ev.user_text) && ev.prev_assistant_tail) {
      concepts = matchConcepts(ev.prev_assistant_tail).slice(0, 3);
      inUserText = false;
    }
    for (const c of concepts.slice(0, 3)) {
      const interp = await interpretChatEvent(ev, c.name, inUserText, true);
      addEvidence({
        userId,
        conceptId: c.id,
        ts: ev.ts,
        source: "claude_code",
        rawText: ev.user_text.slice(0, 200),
        dimension: interp.dimension,
        direction: interp.direction,
        strength: interp.strength,
        interpretation: interp.interpretation,
        judge: interp.judge,
      });
      refreshState(userId, c.id);
      added++;
    }
  }
  return added;
}

export function enqueueAnswer(userId: string, sessionId: string | null, answer: string): { id: number | null; deduped: boolean } {
  const text = answer.trim();
  if (text.length < MIN_ANSWER_LEN) return { id: null, deduped: false };
  const hash = crypto.createHash("sha256").update(text).digest("hex");
  const existing = db().prepare("SELECT id FROM feed WHERE answer_hash = ?").get(hash) as { id: number } | undefined;
  if (existing) return { id: existing.id, deduped: true };
  const info = db()
    .prepare("INSERT INTO feed (ts, session_id, user_id, answer_hash, answer) VALUES (?, ?, ?, ?, ?)")
    .run(new Date().toISOString(), sessionId, userId, hash, text);
  const id = Number(info.lastInsertRowid);
  void processFeedItem(id); // background; route returns immediately
  return { id, deduped: false };
}

async function processFeedItem(id: number) {
  const row = db().prepare("SELECT user_id, answer FROM feed WHERE id = ?").get(id) as
    | { user_id: string; answer: string }
    | undefined;
  if (!row) return;
  try {
    const result = await personalize(row.user_id, row.answer, { skipHeavyIfNoGaps: true });
    const gaps = result.blocks.filter((b: ConceptBlock) => HEAVY.has(finalVerdict(b))).length;
    const central = result.blocks.find((b) => HEAVY.has(finalVerdict(b))) ?? result.blocks[0];
    const headline = central?.concept.name ?? row.answer.slice(0, 60);
    db()
      .prepare("UPDATE feed SET status='done', gaps_count=?, headline=?, result=? WHERE id=?")
      .run(gaps, headline, JSON.stringify(result), id);
  } catch (err) {
    db().prepare("UPDATE feed SET status='error', error=? WHERE id=?").run(String(err).slice(0, 500), id);
  }
}
