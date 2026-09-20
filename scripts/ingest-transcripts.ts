/**
 * Full-history transcript ingester (supersedes answerfit/scripts/ingest-transcripts.ts).
 *
 * Sources:
 *   ~/.claude/projects/** /*.jsonl          — Claude Code sessions (720 files, ~800MB)
 *   ~/.codex/sessions/** /*.jsonl           — Codex active sessions
 *   ~/.codex/archived_sessions/** /*.jsonl  — Codex archive (the bulk: ~2,400 files)
 *
 * Improvements over the answerfit version:
 *   - includes archived_sessions (previously ~3.7GB of history was skipped)
 *   - skips *sync-conflict* files and dedupes records by (session, ts, role, text)
 *   - skips Claude Code sidechain rows (subagent traffic is not the human)
 *   - cheap substring guards before JSON.parse (most lines are tool noise)
 *
 * Output contract is identical to the answerfit version, so backfill.ts and the
 * "explanation didn't land" join consume these files unchanged:
 *   data/chat-history.jsonl       — human-typed user messages + assistant tail
 *   data/assistant-mentions.jsonl — assistant concept mentions with timestamps
 */
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import crypto from "crypto";
import "../lib/env";
import { matchConcepts } from "../lib/taxonomy";

const OUT_CHAT = path.join(process.cwd(), "data", "chat-history.jsonl");
const OUT_MENTIONS = path.join(process.cwd(), "data", "assistant-mentions.jsonl");

const MAX_USER_LEN = 1500; // longer = pasted content, not typed thought
const ASSISTANT_TAIL = 1200;

interface Msg {
  ts: string;
  role: "user" | "assistant";
  text: string;
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

function listJsonl(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  (function walk(dir: string) {
    for (const f of fs.readdirSync(dir)) {
      if (f.includes("sync-conflict")) continue;
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith(".jsonl")) files.push(p);
    }
  })(root);
  return files;
}

async function* claudeMessages(files: string[]): AsyncGenerator<Msg> {
  for (const file of files) {
    const session = path.basename(file, ".jsonl");
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      // Cheap guard: only user/assistant rows carry evidence; tool rows dominate volume.
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let r: any;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.isMeta || r.isSidechain || !r.message || !r.timestamp) continue;
      if (r.type !== "user" && r.type !== "assistant") continue;
      const c = r.message.content;
      const text: string =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ")
            : "";
      if (!text) continue;
      yield { ts: r.timestamp, role: r.type, text, session };
    }
  }
}

async function* codexMessages(files: string[]): AsyncGenerator<Msg> {
  for (const file of files) {
    const session = path.basename(file, ".jsonl");
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      if (!line.includes('"response_item"') || !line.includes('"message"')) continue;
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
      if (role) yield { ts: r.timestamp, role, text, session };
    }
  }
}

async function main() {
  const claudeFiles = listJsonl(path.join(os.homedir(), ".claude", "projects"));
  const codexFiles = [
    ...listJsonl(path.join(os.homedir(), ".codex", "sessions")),
    ...listJsonl(path.join(os.homedir(), ".codex", "archived_sessions")),
  ];
  console.log(`Claude Code files: ${claudeFiles.length}, Codex files (incl. archived): ${codexFiles.length}`);

  const chat = fs.createWriteStream(OUT_CHAT);
  const mentions = fs.createWriteStream(OUT_MENTIONS);
  const seen = new Set<string>();
  const stats = {
    claude_code: { user: 0, assistant: 0, mentions: 0 },
    codex: { user: 0, assistant: 0, mentions: 0 },
    dupes: 0,
  };

  const sources: { src: "claude_code" | "codex"; gen: AsyncGenerator<Msg> }[] = [
    { src: "claude_code", gen: claudeMessages(claudeFiles) },
    { src: "codex", gen: codexMessages(codexFiles) },
  ];

  const t0 = Date.now();
  let scanned = 0;
  for (const { src, gen } of sources) {
    let prevAssistant = "";
    let prevSession = "";
    for await (const m of gen) {
      scanned++;
      if (scanned % 50000 === 0) {
        console.log(`  …${scanned} messages scanned (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
      const key = crypto
        .createHash("sha1")
        .update(`${m.session}|${m.ts}|${m.role}|${m.text.slice(0, 300)}`)
        .digest("base64");
      if (seen.has(key)) { stats.dupes++; continue; }
      seen.add(key);
      if (m.session !== prevSession) prevAssistant = ""; // don't attribute across sessions
      prevSession = m.session;
      if (m.role === "assistant") {
        stats[src].assistant++;
        prevAssistant = m.text.slice(-ASSISTANT_TAIL);
        const ids = matchConcepts(m.text.slice(0, 6000)).map((c) => c.id);
        if (ids.length) {
          mentions.write(JSON.stringify({ ts: m.ts, source: src, concepts: ids }) + "\n");
          stats[src].mentions++;
        }
      } else {
        const txt = cleanUserText(m.text);
        if (!txt) continue;
        chat.write(
          JSON.stringify({ ts: m.ts, source: src, user_text: txt, prev_assistant_tail: prevAssistant, session: m.session }) + "\n"
        );
        stats[src].user++;
      }
    }
  }

  await Promise.all([new Promise((r) => chat.end(r)), new Promise((r) => mentions.end(r))]);

  // Provenance manifest: both this repo and ../claude-wall-of-text can
  // (re)generate the two derived files above. Record which generator produced
  // the current versions so the implementations never get confused.
  fs.writeFileSync(
    path.join(process.cwd(), "data", "derived-files.meta.json"),
    JSON.stringify(
      {
        generator: "answerfit/scripts/ingest-transcripts.ts (ported from claude-wall-of-text)",
        generated_at: new Date().toISOString(),
        outputs: ["chat-history.jsonl", "assistant-mentions.jsonl"],
        inputs: {
          claude_code_files: claudeFiles.length,
          codex_files_incl_archived: codexFiles.length,
        },
        stats,
        notes:
          "Superset of answerfit/scripts/ingest-transcripts.ts output (same schema): adds ~/.codex/archived_sessions, sidechain filtering, dedupe. Raw history files in data/ are never written by this script.",
      },
      null,
      2
    )
  );
  console.log(JSON.stringify(stats, null, 2));
  console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s (manifest: data/derived-files.meta.json)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
