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
  const [feed, setFeed] = useState<any[]>([]);
  const [activeFeedId, setActiveFeedId] = useState<number | null>(null);

  async function openFeedItem(id: number) {
    const row = await fetch(`/api/feed?id=${id}`).then((r) => r.json());
    if (!row?.result) return;
    setActiveFeedId(id);
    setCompare(false);
    setSelected(row.result.user_id);
    setAnswer(row.answer);
    setResults({ [row.result.user_id]: row.result });
  }

  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((d) => {
        setUsers(d.users);
        setSamples(d.samples);
        const feedParam = new URLSearchParams(window.location.search).get("feed");
        if (feedParam) openFeedItem(Number(feedParam));
        else if (d.samples.length) setAnswer(d.samples[0].text);
      });
    const poll = () =>
      fetch("/api/feed")
        .then((r) => r.json())
        .then((d) => setFeed(d.items ?? []))
        .catch(() => {});
    poll();
    const t = setInterval(poll, 15000);
    return () => clearInterval(t);
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
    // Highlight extracted concept quotes inside the original answer, color-coded by plan verdict.
    let html = escapeHtml(result.answer);
    const blocks = [...result.blocks].sort((a: any, b: any) => b.concept.quote.length - a.concept.quote.length);
    for (const b of blocks) {
      const verdict = b.plan?.verdict ?? (b.decision.intervention === "none" ? "suppress" : b.decision.intervention);
      const kind =
        verdict === "suppress" ? "known" : verdict === "reminder" ? "reminder" : verdict === "hedge" ? "hedge" : "explain";
      const q = escapeHtml(b.concept.quote);
      if (q && html.includes(q)) html = html.replace(q, `<mark class="${kind}">${q}</mark>`);
    }
    // Caveat spans (plan rule 4) get a persistent warning underline on top.
    for (const c of result.plan?.caveats ?? []) {
      const q = escapeHtml(c.quote);
      if (q && html.includes(q) && !html.includes(`<mark class="caveat">${q}`)) {
        html = html.replace(q, `<mark class="caveat" title="${escapeHtml(c.reason)}">${q}</mark>`);
      }
    }
    return html;
  }

  return (
    <div className="app">
      <div className="header">
        <h1>AnswerFit</h1>
        <span className="tagline">one answer, fitted to what you already know</span>
        <a className="navlink" href="/chat">chat mode →</a>
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
          {anyLoading && <span className="status">Fable extracts → Jev judges each concept → Fable resolves the plan → fills content…</span>}
        </div>
        {error && <div className="error">{error}</div>}
        {feed.length > 0 && (
          <div className="row feed-strip">
            <span className="label">Captured</span>
            {feed.slice(0, 8).map((f) => (
              <button
                key={f.id}
                className={`chip small ${activeFeedId === f.id ? "active" : ""} ${f.status !== "done" ? "pending" : ""}`}
                title={f.preview}
                onClick={() => f.status === "done" && openFeedItem(f.id)}
              >
                {f.status === "pending" ? "⋯ " : f.gaps_count > 0 ? `⚡${f.gaps_count} ` : "✓ "}
                {(f.headline ?? f.preview ?? "").slice(0, 34)}
              </button>
            ))}
          </div>
        )}
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
                  {result.plan?.caveats?.length > 0 && (
                    <div className="caveats">
                      <div className="ptitle">⚠ Caveats preserved for every reader</div>
                      {result.plan.caveats.map((c: any, i: number) => (
                        <div className="pitem" key={i}>
                          “{c.quote}” <span style={{ color: "var(--muted)" }}>— {c.reason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="timing">
                    extract {result.timing_ms.extract}ms · policy {result.timing_ms.policy}ms · annotate{" "}
                    {result.timing_ms.annotate}ms · render {result.timing_ms.render}ms
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
