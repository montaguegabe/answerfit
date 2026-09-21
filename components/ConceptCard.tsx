"use client";
import React, { useState } from "react";
import { Md, CodeBlock, GitDag, Timeline, Sequence, CustomViz } from "./renderers";

const FEEDBACK: { action: string; label: string }[] = [
  { action: "already_knew", label: "Already knew this" },
  { action: "still_confused", label: "Still confused" },
  { action: "more_detail", label: "More detail" },
  { action: "show_visually", label: "Show visually" },
];

export function ConceptCard({ block, userId }: { block: any; userId: string }) {
  const { concept, state, decision, jev, provenance, content, plan } = block;
  const verdict: string = plan?.verdict ?? (decision.intervention === "none" ? "suppress" : decision.intervention);
  const kind =
    verdict === "suppress" ? "known" : verdict === "reminder" ? "reminder" : verdict === "hedge" ? "hedge" : "explain";
  // Hedge = the uncertainty hedge (PROPOSAL P6): collapsed by default; the
  // expand action is itself evidence about the user's state.
  const [open, setOpen] = useState(kind === "explain");
  const [sent, setSent] = useState<string | null>(null);
  const [expandLogged, setExpandLogged] = useState(false);

  async function sendFeedback(action: string, silent = false) {
    if (!silent) setSent(action);
    await fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, concept_id: concept.id, action }),
    });
  }

  function toggle() {
    if (kind === "hedge" && !open && !expandLogged) {
      setExpandLogged(true);
      sendFeedback("expanded_hedge", true); // telemetry, not a button click
    }
    setOpen((o) => !o);
  }

  return (
    <div className="card">
      <div className="card-head" onClick={toggle}>
        <span className={`badge ${kind}`}>
          {kind === "known" ? "✓ known" : kind === "hedge" ? "▸ likely known" : kind}
        </span>
        <span className="cname">{concept.name}</span>
        {kind === "hedge" && !open && content?.reminder_text && (
          <span className="hedge-line">{content.reminder_text}</span>
        )}
        <span className="meta">
          m={state.mastery.toFixed(2)} · n={state.evidence_count} ·{" "}
          <span className={`badge ${decision.decided_by}`}>{decision.decided_by}</span>
          {plan?.overridden && <span className="badge plan" title={plan.rationale}>plan</span>}
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
          {(kind === "explain" || kind === "hedge") && content && (
            <div>
              {kind === "hedge" && content.reminder_text && (
                <div className="reminder-line">
                  <b>▾ Likely known:</b> {content.reminder_text}
                </div>
              )}
              {content.headline && <div className="headline">{content.headline}</div>}
              {content.body_markdown && <Md text={content.body_markdown} />}
              {content.code && <CodeBlock code={content.code} />}
              {content.git_dag && <GitDag dag={content.git_dag} />}
              {content.timeline && <Timeline timeline={content.timeline} />}
              {content.sequence && <Sequence seq={content.sequence} />}
              {content.custom && <CustomViz custom={content.custom} />}
            </div>
          )}
          {plan?.rationale && (
            <details className="plan-rationale">
              <summary>why this treatment</summary>
              {plan.rationale}
            </details>
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
