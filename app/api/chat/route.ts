import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { personalize } from "@/lib/pipeline";
import { ingestLiveMessages } from "@/lib/capture";

export const maxDuration = 300;

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";

// NB: keep this prompt minimal — Fable 5's safety layer hard-refuses on some
// innocuous-looking output-shaping sentences (verified empirically; both
// "a personalization layer downstream adapts your answer" and "write one
// complete answer for a technical reader" triggered stop_reason=refusal).
const CHAT_SYSTEM = `You are a helpful expert assistant. Answer with technical precision and enough depth to be genuinely useful; use concrete examples where they clarify.`;

const MIN_FIT_LEN = 300;

/**
 * One SSE stream, two acts: the raw Claude answer streams first (fidelity —
 * the reader never waits on personalization), then the fitting events fold in
 * as each pipeline stage completes.
 */
export async function POST(req: NextRequest) {
  const { messages, user_id } = await req.json();
  const uid = user_id || "gabe";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        // The user's question is live evidence (same path as backfill/capture).
        const last = messages[messages.length - 1];
        if (last?.role === "user") {
          const prevTail = String(messages[messages.length - 2]?.content ?? "").slice(-1200);
          void ingestLiveMessages(
            uid,
            [{ ts: new Date().toISOString(), text: String(last.content), prev_assistant_tail: prevTail }],
            "chat_app"
          ).catch(() => {});
        }

        const client = new Anthropic();
        const s = client.messages.stream({
          model: MODEL,
          max_tokens: 4096,
          system: CHAT_SYSTEM,
          messages,
        });
        s.on("text", (t) => send({ type: "delta", text: t }));
        s.on("error", (e) => console.error("[chat] stream error:", e));
        const final = await s.finalMessage();
        if (final.stop_reason === "refusal") {
          send({ type: "refusal" });
          return;
        }
        const answer = final.content
          .filter((b) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        send({ type: "answer_done", answer });

        if (answer.trim().length >= MIN_FIT_LEN) {
          const result = await personalize(uid, answer, { onEvent: send });
          send({ type: "result", result });
        } else {
          send({ type: "fit_skipped", reason: "answer too short to personalize" });
        }
      } catch (err) {
        send({ type: "error", error: String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
