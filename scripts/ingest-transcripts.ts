/**
 * Ingest Claude Code (~/.claude/projects) and Codex (~/.codex/sessions)
 * transcripts into two evidence sources (detailed-plan "existing data is
 * unusually valuable"; smaller-plan Day 6 stretch, promoted):
 *
 *   data/chat-history.jsonl       — human-typed user messages + preceding
 *                                   assistant tail (for confusion attribution)
 *   data/assistant-mentions.jsonl — assistant messages' concept mentions
 *                                   (for the "explanation didn't land" join)
 *
 * Only message text is read; tool results, system reminders, meta rows and
 * pasted blobs are skipped.
 */
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import "../lib/env";
import { matchConcepts } from "../lib/taxonomy";

const OUT_CHAT = path.join(process.cwd(), "data", "chat-history.jsonl");
const OUT_MENTIONS = path.join(process.cwd(), "data", "assistant-mentions.jsonl");

const MAX_USER_LEN = 1500; // longer = pasted content, not typed thought
const ASSISTANT_TAIL = 1200;

interface ChatRecord {
  ts: string;
  source: "claude_code" | "codex";
  user_text: string;
  prev_assistant_tail: string;
  session: string;
}

function cleanUserText(txt: string): string | null {
  const t = txt.trim();
  if (!t || t.length < 6) return null;
  if (t.startsWith("<") || t.startsWith("Caveat:")) return null; // system/injected
  if (t.startsWith("/") || t.startsWith("!")) return null; // slash/bang commands
  if (t.startsWith("[Request interrupted")) return null;
  return t.slice(0, MAX_USER_LEN);
}

async function* claudeMessages(): AsyncGenerator<{ ts: string; role: "user" | "assistant"; text: string; session: string }> {
  const root = path.join(os.homedir(), ".claude", "projects");
  const files: string[] = [];
  for (const dir of fs.readdirSync(root)) {
    const p = path.join(root, dir);
    if (!fs.statSync(p).isDirectory()) continue;
    for (const f of fs.readdirSync(p)) if (f.endsWith(".jsonl")) files.push(path.join(p, f));
  }
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.isMeta || !r.message || !r.timestamp) continue;
      const c = r.message.content;
      const text: string =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
            : "";
      if (!text) continue;
      if (r.type === "user" || r.type === "assistant") {
        yield { ts: r.timestamp, role: r.type, text, session: path.basename(file, ".jsonl") };
      }
    }
  }
}

async function* codexMessages(): AsyncGenerator<{ ts: string; role: "user" | "assistant"; text: string; session: string }> {
  const root = path.join(os.homedir(), ".codex", "sessions");
  if (!fs.existsSync(root)) return;
  const files: string[] = [];
  (function walk(dir: string) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".jsonl")) files.push(p);
    }
  })(root);
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      const p = r.payload;
      if (r.type !== "response_item" || !p || p.type !== "message" || !r.timestamp) continue;
      const text: string = Array.isArray(p.content)
        ? p.content
            .filter((b: any) => b.type === "input_text" || b.type === "output_text")
            .map((b: any) => b.text)
            .join(" ")
        : "";
      if (!text) continue;
      const role = p.role === "user" ? "user" : p.role === "assistant" ? "assistant" : null;
      if (role) yield { ts: r.timestamp, role, text, session: path.basename(file, ".jsonl") };
    }
  }
}

async function main() {
  const chat = fs.createWriteStream(OUT_CHAT);
  const mentions = fs.createWriteStream(OUT_MENTIONS);
  let nUser = 0, nMention = 0, nAssistant = 0;

  for (const gen of [claudeMessages(), codexMessages()]) {
    let prevAssistant = "";
    let prevSession = "";
    const source = gen === undefined ? "claude_code" : undefined; // placeholder, set below
    for await (const m of gen) {
      const src: "claude_code" | "codex" = m.session.startsWith("rollout-") ? "codex" : "claude_code";
      if (m.session !== prevSession) prevAssistant = ""; // don't attribute across sessions
      prevSession = m.session;
      if (m.role === "assistant") {
        nAssistant++;
        prevAssistant = m.text.slice(-ASSISTANT_TAIL);
        const ids = matchConcepts(m.text.slice(0, 6000)).map((c) => c.id);
        if (ids.length) {
          mentions.write(JSON.stringify({ ts: m.ts, source: src, concepts: ids }) + "\n");
          nMention++;
        }
      } else {
        const txt = cleanUserText(m.text);
        if (!txt) continue;
        const rec: ChatRecord = { ts: m.ts, source: src, user_text: txt, prev_assistant_tail: prevAssistant, session: m.session };
        chat.write(JSON.stringify(rec) + "\n");
        nUser++;
      }
    }
  }
  await Promise.all([new Promise((r) => chat.end(r)), new Promise((r) => mentions.end(r))]);
  console.log(`user messages: ${nUser}, assistant messages scanned: ${nAssistant}, assistant concept-mention rows: ${nMention}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
