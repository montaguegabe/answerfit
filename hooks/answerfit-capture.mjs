#!/usr/bin/env node
/**
 * Claude Code Stop hook → AnswerFit capture loop.
 *
 * On each turn end:
 *   1. Tail the session transcript from a per-session byte cursor; collect the
 *      user's typed messages (live evidence) and the last assistant answer.
 *   2. POST them to the local AnswerFit server (fire-and-forget economics:
 *      the server personalizes in the background).
 *   3. Ask the server for finished-but-unannounced results that found real
 *      gaps, and surface ONE line for them. All-known answers stay silent —
 *      that verdict is the product working, not a missing notification.
 *
 * Fails silent by design: if the server is down or anything throws, exit 0
 * with no output. A capture layer must never break the tool it observes.
 */
import fs from "fs";
import os from "os";
import path from "path";

const BASE = process.env.ANSWERFIT_URL || "http://localhost:3210";
const STATE_PATH = path.join(os.homedir(), ".claude", "answerfit-hook-state.json");
const MAX_TAIL_BYTES = 4 * 1024 * 1024; // never read more than the last 4MB

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")); } catch { return { offsets: {} }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(s)); } catch {}
}

function cleanUserText(txt) {
  const t = (txt ?? "").trim();
  if (!t || t.length < 6) return null;
  for (const bad of ["<", "Caveat:", "/", "!", "[Request interrupted", "[Conversation context", "#", "This session is being continued"]) {
    if (t.startsWith(bad)) return null;
  }
  return t.slice(0, 1500);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  return "";
}

async function api(pathname, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(BASE + pathname, { ...init, signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf-8"));
  const sessionId = input.session_id ?? "unknown";
  const transcriptPath = input.transcript_path;
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

  const state = loadState();
  const size = fs.statSync(transcriptPath).size;
  let offset = state.offsets[sessionId] ?? 0;
  if (offset > size || size - offset > MAX_TAIL_BYTES) offset = Math.max(0, size - MAX_TAIL_BYTES);

  const fd = fs.openSync(transcriptPath, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  state.offsets[sessionId] = size;

  const userMessages = [];
  let lastAssistant = "";
  let prevAssistantTail = "";
  for (const line of buf.toString("utf-8").split("\n")) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.isMeta || r.isSidechain || !r.message || !r.timestamp) continue;
    const text = textOf(r.message.content);
    if (!text) continue;
    if (r.type === "assistant") {
      lastAssistant = text;
      prevAssistantTail = text.slice(-1200);
    } else if (r.type === "user") {
      const t = cleanUserText(text);
      if (t) userMessages.push({ ts: r.timestamp, text: t, prev_assistant_tail: prevAssistantTail });
    }
  }

  if (userMessages.length || lastAssistant.length >= 400) {
    await api("/api/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, answer: lastAssistant, user_messages: userMessages }),
    });
  }

  // Deferred notifications: results finished since the last Stop.
  const pending = await api("/api/feed?unnotified=1");
  const items = pending?.items ?? [];
  saveState(state);
  if (items.length) {
    await api("/api/feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notified_ids: items.map((i) => i.id) }),
    });
    const lines = items.map(
      (i) => `⚡ AnswerFit: ${i.gaps_count} gap${i.gaps_count === 1 ? "" : "s"} — ${i.headline} → ${BASE}/?feed=${i.id}`
    );
    process.stdout.write(JSON.stringify({ systemMessage: lines.join("\n") }));
  }
}

main().catch(() => {}).finally(() => process.exit(0));
