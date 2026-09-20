"use client";
import React, { useEffect, useMemo, useState } from "react";
import { ConceptCard } from "@/components/ConceptCard";

interface User { id: string; name: string; kind: string; description: string }
interface Sample { id: string; title: string; text: string }

export default function Home() {
  const [users, setUsers] = useState<User[]>([]);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string>("gabe");
  const [compare, setCompare] = useState(false);
  const [results, setResults] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((d) => {
        setUsers(d.users);
        setSamples(d.samples);
        if (d.samples.length) setAnswer(d.samples[0].text);
      });
  }, []);

  const targets = useMemo(
    () => (compare ? users.map((u) => u.id) : [selected]),
    [compare, users, selected]
  );

  async function run() {
    setError("");
    setResults({});
    setLoading(Object.fromEntries(targets.map((t) => [t, true])));
    await Promise.all(
      targets.map(async (uid) => {
        try {
          const res = await fetch("/api/personalize", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: uid, answer }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.statusText);
          setResults((r) => ({ ...r, [uid]: data }));
        } catch (e: any) {
          setError((prev) => prev + `${uid}: ${e.message}\n`);
        } finally {
          setLoading((l) => ({ ...l, [uid]: false }));
        }
      })
    );
  }

  const anyLoading = Object.values(loading).some(Boolean);

  function markedAnswer(result: any) {
    // Highlight extracted concept quotes inside the original answer, color-coded by decision.
    let html = escapeHtml(result.answer);
    const blocks = [...result.blocks].sort((a: any, b: any) => b.concept.quote.length - a.concept.quote.length);
    for (const b of blocks) {
      const kind = b.decision.intervention === "none" ? "known" : b.decision.intervention === "reminder" ? "reminder" : "explain";
      const q = escapeHtml(b.concept.quote);
      if (q && html.includes(q)) html = html.replace(q, `<mark class="${kind}">${q}</mark>`);
    }
    return html;
  }

  return (
    <div className="app">
      <div className="header">
        <h1>AnswerFit</h1>
        <span className="tagline">one answer, fitted to what you already know</span>
      </div>

      <div className="controls">
        <div className="row">
          <span className="label">Sample</span>
          {samples.map((s) => (
            <button key={s.id} className={`chip ${answer === s.text ? "active" : ""}`} onClick={() => setAnswer(s.text)}>
              {s.title}
            </button>
          ))}
        </div>
        <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Paste an AI answer to personalize…" />
        <div className="row">
          <span className="label">Reader</span>
          {users.map((u) => (
            <button
              key={u.id}
              className={`chip ${!compare && selected === u.id ? "active" : ""}`}
              onClick={() => {
                setSelected(u.id);
                setCompare(false);
              }}
              title={u.description}
            >
              {u.name}
            </button>
          ))}
          <button className={`chip ${compare ? "active" : ""}`} onClick={() => setCompare(!compare)}>
            ⇆ Compare all
          </button>
          <button className="btn" onClick={run} disabled={anyLoading || !answer.trim()}>
            {anyLoading ? "Personalizing…" : "Personalize"}
          </button>
          {anyLoading && <span className="status">Fable extracts → Jev judges each concept → Fable fills the plan…</span>}
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      <div className={`results ${compare ? "compare" : ""}`}>
        {targets.map((uid) => {
          const user = users.find((u) => u.id === uid);
          const result = results[uid];
          return (
            <div className="user-col" key={uid}>
              <h2>{user?.name ?? uid}</h2>
              <div className="desc">{user?.description}</div>
              {loading[uid] && <div className="status">Running pipeline…</div>}
              {result && (
                <>
                  <div className="source-answer" dangerouslySetInnerHTML={{ __html: markedAnswer(result) }} />
                  <div className="blocks">
                    {result.blocks.map((b: any) => (
                      <ConceptCard key={b.concept.id} block={b} userId={uid} />
                    ))}
                  </div>
                  <div className="timing">
                    extract {result.timing_ms.extract}ms · policy {result.timing_ms.policy}ms · render {result.timing_ms.render}ms
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
