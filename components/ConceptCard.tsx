"use client";
import React, { useState } from "react";
import { Md, CodeBlock, GitDag, Timeline, Sequence } from "./renderers";

const FEEDBACK: { action: string; label: string }[] = [
  { action: "already_knew", label: "Already knew this" },
  { action: "still_confused", label: "Still confused" },
  { action: "more_detail", label: "More detail" },
  { action: "show_visually", label: "Show visually" },
];

export function ConceptCard({ block, userId }: { block: any; userId: string }) {
  const { concept, state, decision, jev, provenance, content } = block;
  const kind = decision.intervention === "none" ? "known" : decision.intervention === "reminder" ? "reminder" : "explain";
  const [open, setOpen] = useState(kind !== "known");
  const [sent, setSent] = useState<string | null>(null);

  async function sendFeedback(action: string) {
    setSent(action);
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, concept_id: concept.id, action }),
    });
  }

  return (
    <div className="card">
      <div className="card-head" onClick={() => setOpen((o) => !o)}>
        <span className={`badge ${kind}`}>{kind === "known" ? "✓ known" : kind}</span>
        <span className="cname">{concept.name}</span>
        <span className="meta">
          m={state.mastery.toFixed(2)} · n={state.evidence_count} ·{" "}
          <span className={`badge ${decision.decided_by}`}>{decision.decided_by}</span>
        </span>
      </div>
      {open && (
        <div className="card-body">
          {kind === "known" && (
            <div className="reminder-line" style={{ color: "var(--muted)" }}>
              Suppressed — evidence says you already know this
              {jev ? ` (P(understands)=${jev.already_understands.toFixed(2)}, ${jev.mastery_level})` : ""}.
            </div>
          )}
          {kind === "reminder" && content?.reminder_text && (
            <div className="reminder-line">
              <b>↻ Reminder:</b> {content.reminder_text}
            </div>
          )}
          {kind === "explain" && content && (
            <div>
              {content.headline && <div className="headline">{content.headline}</div>}
              {content.body_markdown && <Md text={content.body_markdown} />}
              {content.code && <CodeBlock code={content.code} />}
              {content.git_dag && <GitDag dag={content.git_dag} />}
              {content.timeline && <Timeline timeline={content.timeline} />}
              {content.sequence && <Sequence seq={content.sequence} />}
            </div>
          )}
          {provenance?.length > 0 && (
            <div className="provenance">
              <div className="ptitle">Why we think this</div>
              {provenance.map((p: any, i: number) => (
                <div className="pitem" key={i}>
                  {p.ts?.slice(0, 10)} {p.source}: <b>“{p.text}”</b> → {p.interpretation}
                </div>
              ))}
            </div>
          )}
          <div className="fbrow">
            {FEEDBACK.map((f) => (
              <button
                key={f.action}
                className={`chip small ${sent === f.action ? "done" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  sendFeedback(f.action);
                }}
              >
                {sent === f.action ? "✓ " : ""}
                {f.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
