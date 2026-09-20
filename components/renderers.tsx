"use client";
import React, { useMemo, useState } from "react";

// ---------- mini markdown (paragraphs, **bold**, *em*, `code`) ----------

export function Md({ text }: { text: string }) {
  const paras = text.split(/\n\s*\n/).filter(Boolean);
  return (
    <div className="md">
      {paras.map((p, i) => (
        <p key={i} dangerouslySetInnerHTML={{ __html: inline(p) }} />
      ))}
    </div>
  );
}

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/\n/g, "<br/>");
}

// ---------- code ----------

export function CodeBlock({ code }: { code: { language: string; code: string; caption: string } }) {
  return (
    <div>
      <pre className="codeblock">{code.code}</pre>
      <div className="caption">{code.caption}</div>
    </div>
  );
}

// ---------- git DAG stepper ----------

interface DagNode { id: string; parents: string[]; branch: string; label?: string }
interface DagStep { title: string; text: string; highlight: string[]; visible: string[] }

const LANE_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f85149", "#39c5cf"];

export function GitDag({ dag }: { dag: { nodes: DagNode[]; steps: DagStep[] } }) {
  const [step, setStep] = useState(0);
  const layout = useMemo(() => {
    const branches = [...new Set(dag.nodes.map((n) => n.branch))];
    const laneOf = new Map(branches.map((b, i) => [b, i]));
    const pos = new Map<string, { x: number; y: number }>();
    dag.nodes.forEach((n, i) => {
      pos.set(n.id, { x: 50 + i * 62, y: 34 + (laneOf.get(n.branch) ?? 0) * 52 });
    });
    return { branches, laneOf, pos };
  }, [dag]);

  const cur = dag.steps[Math.min(step, dag.steps.length - 1)];
  const visible = new Set(cur?.visible?.length ? cur.visible : dag.nodes.map((n) => n.id));
  const highlight = new Set(cur?.highlight ?? []);
  const w = 70 + dag.nodes.length * 62;
  const h = 60 + layout.branches.length * 52;

  return (
    <div>
      <div className="viz">
        <svg width={Math.max(w, 360)} height={h}>
          {layout.branches.map((b, i) => (
            <text key={b} x={6} y={38 + i * 52} fontSize={10} fill="#8b949e">
              {b.slice(0, 9)}
            </text>
          ))}
          {dag.nodes.flatMap((n) =>
            n.parents.filter((p) => visible.has(p) && visible.has(n.id)).map((p) => {
              const a = layout.pos.get(p)!;
              const c = layout.pos.get(n.id)!;
              if (!a || !c) return null;
              return (
                <path
                  key={`${p}->${n.id}`}
                  d={`M ${a.x} ${a.y} C ${(a.x + c.x) / 2} ${a.y}, ${(a.x + c.x) / 2} ${c.y}, ${c.x} ${c.y}`}
                  stroke="#30363d"
                  strokeWidth={2}
                  fill="none"
                />
              );
            })
          )}
          {dag.nodes.filter((n) => visible.has(n.id)).map((n) => {
            const p = layout.pos.get(n.id)!;
            const color = LANE_COLORS[(layout.laneOf.get(n.branch) ?? 0) % LANE_COLORS.length];
            const hot = highlight.has(n.id);
            return (
              <g key={n.id}>
                {hot && <circle cx={p.x} cy={p.y} r={13} fill="none" stroke="#f8514966" strokeWidth={4} />}
                <circle cx={p.x} cy={p.y} r={8} fill={hot ? "#f85149" : color} />
                <text x={p.x} y={p.y - 14} fontSize={10} textAnchor="middle">
                  {n.label ?? n.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {dag.steps.length > 0 && (
        <>
          <div className="stepper">
            <button onClick={() => setStep((s) => s - 1)} disabled={step === 0}>←</button>
            <span className="status">
              step {step + 1}/{dag.steps.length}
            </span>
            <button onClick={() => setStep((s) => s + 1)} disabled={step >= dag.steps.length - 1}>→</button>
          </div>
          <div className="step-text">
            <b>{cur.title}.</b> {cur.text}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- timeline (concurrent lanes) ----------

interface TLEvent { t: number; label: string; kind?: string }

export function Timeline({ timeline }: { timeline: { lanes: { name: string; events: TLEvent[] }[]; caption: string } }) {
  const W = 640;
  const laneH = 56;
  const h = 20 + timeline.lanes.length * laneH;
  return (
    <div>
      <div className="viz">
        <svg width={W} height={h}>
          {timeline.lanes.map((lane, i) => {
            const y = 30 + i * laneH;
            return (
              <g key={lane.name}>
                <text x={4} y={y - 14} fontSize={10.5} fill="#8b949e">{lane.name}</text>
                <line x1={10} y1={y} x2={W - 14} y2={y} stroke="#30363d" strokeWidth={2} />
                {lane.events.map((e, j) => {
                  const x = 24 + (e.t / 100) * (W - 60);
                  const color = e.kind === "conflict" ? "#f85149" : e.kind === "highlight" ? "#d29922" : "#58a6ff";
                  return (
                    <g key={j}>
                      <circle cx={x} cy={y} r={5.5} fill={color} />
                      <text x={x} y={y + (j % 2 === 0 ? 16 : -9)} fontSize={9.5} textAnchor="middle" fill={e.kind === "conflict" ? "#f85149" : "#e6edf3"}>
                        {e.label.slice(0, 26)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="caption">{timeline.caption}</div>
    </div>
  );
}

// ---------- custom generated visualization (escape hatch) ----------
// Model-generated HTML runs in a sandboxed iframe: scripts allowed (the point
// is interactivity) but no same-origin access, no navigation, no network.

export function CustomViz({ custom }: { custom: { form_slug: string; description: string; html: string; height: number } }) {
  const doc = `<!doctype html><html><head><style>
    html,body{margin:0;background:#0a0d12;color:#e6edf3;font-family:ui-monospace,Menlo,monospace;font-size:13px}
  </style></head><body>${custom.html}</body></html>`;
  return (
    <div>
      <div className="viz" style={{ padding: 0 }}>
        <iframe
          sandbox="allow-scripts"
          srcDoc={doc}
          style={{ width: "100%", height: Math.min(Math.max(custom.height || 320, 120), 800), border: "none", display: "block" }}
          title={custom.form_slug}
        />
      </div>
      <div className="caption">
        {custom.description} <span style={{ opacity: 0.6 }}>· generated form: {custom.form_slug}</span>
      </div>
    </div>
  );
}

// ---------- sequence diagram ----------

interface SeqMsg { from: string; to: string; label: string; note?: string }

export function Sequence({ seq }: { seq: { actors: string[]; messages: SeqMsg[]; caption: string } }) {
  const colW = 150;
  const W = Math.max(360, seq.actors.length * colW);
  const H = 56 + seq.messages.length * 36;
  const xOf = (a: string) => 70 + seq.actors.indexOf(a) * colW;
  return (
    <div>
      <div className="viz">
        <svg width={W} height={H}>
          {seq.actors.map((a) => (
            <g key={a}>
              <rect x={xOf(a) - 52} y={6} width={104} height={22} rx={5} fill="#1c2129" stroke="#30363d" />
              <text x={xOf(a)} y={21} fontSize={11} textAnchor="middle">{a.slice(0, 15)}</text>
              <line x1={xOf(a)} y1={28} x2={xOf(a)} y2={H - 8} stroke="#30363d" strokeDasharray="3 3" />
            </g>
          ))}
          {seq.messages.map((m, i) => {
            const y = 52 + i * 36;
            const x1 = xOf(m.from);
            const x2 = xOf(m.to);
            const self = x1 === x2;
            const color = m.note ? "#d29922" : "#8b949e";
            return (
              <g key={i}>
                {self ? (
                  <path d={`M ${x1} ${y - 8} h 30 v 14 h -30`} fill="none" stroke={color} strokeWidth={1.5} markerEnd={`url(#arr${i})`} />
                ) : (
                  <line x1={x1} y1={y} x2={x2 + (x2 > x1 ? -6 : 6)} y2={y} stroke={color} strokeWidth={1.5} markerEnd={`url(#arr${i})`} />
                )}
                <defs>
                  <marker id={`arr${i}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                  </marker>
                </defs>
                <text x={(x1 + x2) / 2} y={y - 5} fontSize={10} textAnchor="middle" fill={m.note ? "#d29922" : "#e6edf3"}>
                  {m.label.slice(0, 42)}
                </text>
                {m.note && (
                  <text x={(x1 + x2) / 2} y={y + 12} fontSize={9} textAnchor="middle" fill="#8b949e">
                    {m.note.slice(0, 60)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="caption">{seq.caption}</div>
    </div>
  );
}
