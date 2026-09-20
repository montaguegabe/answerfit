"use client";
import React, { useEffect, useRef, useState } from "react";
import { ConceptCard } from "@/components/ConceptCard";
import { Md } from "@/components/renderers";

interface ChatMsg { role: "user" | "assistant"; content: string }

interface Fit {
  status: string; // human-readable stage, "" when done/absent
  concepts: { id: string; name: string; quote: string }[];
  verdicts: Record<string, string>; // concept_id → tier1 intervention, then plan verdict
  result: any | null;
  error?: string;
}

const STAGE_LABEL: Record<string, string> = {
  extract: "extracting concepts…",
  policy: "judging what you already know…",
  annotate: "resolving the explanation plan…",
  render: "rendering explanations…",
};

const USERS = [
  { id: "gabe", name: "Gabe (real history)" },
  { id: "junior-frontend", name: "Junior frontend dev" },
  { id: "git-expert", name: "Senior git expert" },
];

export default function Chat() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [fits, setFits] = useState<Record<number, Fit>>({});
  const [input, setInput] = useState("");
  const [streamText, setStreamText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [userId, setUserId] = useState("gabe");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText, fits]);

  function patchFit(idx: number, patch: Partial<Fit> | ((f: Fit) => Fit)) {
    setFits((fs) => {
      const cur = fs[idx] ?? { status: "", concepts: [], verdicts: {}, result: null };
      return { ...fs, [idx]: typeof patch === "function" ? patch(cur) : { ...cur, ...patch } };
    });
  }

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const history = [...messages, { role: "user" as const, content: q }];
    const assistantIdx = history.length; // index the assistant reply will occupy
    setMessages(history);
    setStreamText("");
    let acc = "";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, user_id: userId }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const evt of events) {
          const line = evt.trim();
          if (!line.startsWith("data: ")) continue;
          let e: any;
          try { e = JSON.parse(line.slice(6)); } catch { continue; }
          switch (e.type) {
            case "delta":
              acc += e.text;
              setStreamText(acc);
              break;
            case "answer_done":
              setMessages((ms) => [...ms, { role: "assistant", content: e.answer }]);
              setStreamText(null);
              patchFit(assistantIdx, { status: "fitting to what you know…" });
              break;
            case "stage":
              patchFit(assistantIdx, { status: STAGE_LABEL[e.stage] ?? e.stage });
              break;
            case "concepts":
              patchFit(assistantIdx, { concepts: e.concepts });
              break;
            case "decision":
              patchFit(assistantIdx, (f) => ({
                ...f,
                verdicts: { ...f.verdicts, [e.block.concept.id]: e.block.decision.intervention },
              }));
              break;
            case "plan":
              patchFit(assistantIdx, (f) => ({
                ...f,
                verdicts: Object.fromEntries(e.entries.map((x: any) => [x.concept_id, x.verdict])),
              }));
              break;
            case "result":
              patchFit(assistantIdx, { status: "", result: e.result });
              break;
            case "fit_skipped":
              patchFit(assistantIdx, { status: "" });
              break;
            case "refusal":
              setMessages((ms) => [
                ...ms,
                { role: "assistant", content: "_The model declined this question (API-level safety refusal). Try rephrasing._" },
              ]);
              setStreamText(null);
              break;
            case "error":
              patchFit(assistantIdx, { status: "", error: e.error });
              break;
          }
        }
      }
    } catch (err: any) {
      setMessages((ms) =>
        streamText !== null && acc ? [...ms, { role: "assistant", content: acc }] : ms
      );
      patchFit(assistantIdx, { status: "", error: String(err?.message ?? err) });
      setStreamText(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app chat-app">
      <div className="header">
        <h1>AnswerFit</h1>
        <span className="tagline">chat — answers arrive already fitted to you</span>
        <a className="navlink" href="/">paste mode →</a>
      </div>

      <div className="row" style={{ marginBottom: 10 }}>
        <span className="label">Reader</span>
        {USERS.map((u) => (
          <button key={u.id} className={`chip small ${userId === u.id ? "active" : ""}`} onClick={() => setUserId(u.id)}>
            {u.name}
          </button>
        ))}
      </div>

      <div className="chat-log">
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div className="bubble user" key={i}>{m.content}</div>
          ) : (
            <AssistantTurn key={i} content={m.content} fit={fits[i]} userId={userId} />
          )
        )}
        {streamText !== null && (
          <div className="bubble assistant">
            <Md text={streamText || "…"} />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          placeholder="Ask anything — the answer gets fitted to what you already know…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn" onClick={send} disabled={busy || !input.trim()}>
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

const VERDICT_KIND: Record<string, string> = {
  none: "known", suppress: "known", reminder: "reminder", hedge: "hedge",
  example: "explain", diagram: "explain", interactive: "explain",
};

function AssistantTurn({ content, fit, userId }: { content: string; fit?: Fit; userId: string }) {
  // Finished: identical rendering vocabulary to paste mode.
  if (fit?.result) {
    const r = fit.result;
    return (
      <div className="bubble assistant fitted">
        <div className="source-answer chat-answer" dangerouslySetInnerHTML={{ __html: markedAnswer(content, r) }} />
        <div className="blocks">
          {r.blocks.map((b: any) => (
            <ConceptCard key={b.concept.id} block={b} userId={userId} />
          ))}
        </div>
        {r.plan?.caveats?.length > 0 && (
          <div className="caveats">
            <div className="ptitle">⚠ Caveats preserved</div>
            {r.plan.caveats.map((c: any, i: number) => (
              <div className="pitem" key={i}>“{c.quote}”</div>
            ))}
          </div>
        )}
      </div>
    );
  }
  // In-flight: raw answer + live verdict chips as Jev decides.
  return (
    <div className="bubble assistant">
      <Md text={content} />
      {fit?.error && <div className="error">fit failed: {fit.error}</div>}
      {fit && !fit.error && (fit.status || fit.concepts.length > 0) && (
        <div className="fit-progress">
          {fit.status && <span className="status">⟳ {fit.status}</span>}
          <span className="fit-chips">
            {fit.concepts.map((c) => {
              const v = fit.verdicts[c.id];
              const kind = v ? VERDICT_KIND[v] ?? "explain" : "";
              return (
                <span key={c.id} className={`chip small fitchip ${kind}`}>
                  {kind === "known" ? "✓ " : kind === "reminder" ? "↻ " : kind === "hedge" ? "▸ " : kind ? "⚡ " : "· "}
                  {c.name.slice(0, 28)}
                </span>
              );
            })}
          </span>
        </div>
      )}
    </div>
  );
}

function markedAnswer(answer: string, result: any) {
  let html = escapeHtml(answer);
  const blocks = [...result.blocks].sort((a: any, b: any) => b.concept.quote.length - a.concept.quote.length);
  for (const b of blocks) {
    const verdict = b.plan?.verdict ?? (b.decision.intervention === "none" ? "suppress" : b.decision.intervention);
    const kind = VERDICT_KIND[verdict] ?? "explain";
    const q = escapeHtml(b.concept.quote);
    if (q && html.includes(q)) html = html.replace(q, `<mark class="${kind}">${q}</mark>`);
  }
  for (const c of result.plan?.caveats ?? []) {
    const q = escapeHtml(c.quote);
    if (q && html.includes(q) && !html.includes(`<mark class="caveat">${q}`)) {
      html = html.replace(q, `<mark class="caveat" title="${escapeHtml(c.reason ?? "")}">${q}</mark>`);
    }
  }
  // Restore basic markdown (chat answers are markdown-heavy) after marking:
  // spans were matched against the escaped raw text, so this runs safely last.
  html = html
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="codeblock">${code.replace(/^\w+\n/, "")}</pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,3} (.+)$/gm, "<b>$1</b>")
    .replace(/^---$/gm, "");
  return html
    .split(/\n\s*\n/)
    .map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
