import { NextRequest, NextResponse } from "next/server";
import { enqueueAnswer, ingestLiveMessages } from "@/lib/capture";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { session_id, answer, user_messages, user_id } = await req.json();
    const uid = user_id || "gabe";
    // Evidence ingestion is small (a handful of Jev calls) — do it inline so
    // the hook's next capture already sees updated state.
    const evidence_added = Array.isArray(user_messages) ? await ingestLiveMessages(uid, user_messages) : 0;
    const queued = typeof answer === "string" ? enqueueAnswer(uid, session_id ?? null, answer) : { id: null, deduped: false };
    return NextResponse.json({ ok: true, feed_id: queued.id, deduped: queued.deduped, evidence_added });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
