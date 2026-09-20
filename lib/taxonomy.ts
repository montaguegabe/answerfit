import fs from "fs";
import path from "path";

export interface Concept {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  viz: "prose" | "code" | "git_dag" | "timeline" | "sequence";
  prereqs: string[];
  contrasts?: string[];
}

let _concepts: Concept[] | null = null;
let _aliasPatterns: { concept: Concept; re: RegExp }[] | null = null;

export function taxonomy(): Concept[] {
  if (!_concepts) {
    const raw = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "taxonomy", "concepts.json"), "utf-8")
    );
    _concepts = raw.concepts as Concept[];
  }
  return _concepts!;
}

export function conceptById(id: string): Concept | undefined {
  return taxonomy().find((c) => c.id === id);
}

function aliasPatterns() {
  if (!_aliasPatterns) {
    _aliasPatterns = [];
    for (const c of taxonomy()) {
      for (const alias of [...c.aliases, c.name.toLowerCase()]) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        _aliasPatterns.push({ concept: c, re: new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i") });
      }
    }
  }
  return _aliasPatterns;
}

/** Match taxonomy concepts appearing in a piece of text (search query or pasted answer). */
export function matchConcepts(text: string): Concept[] {
  const found = new Map<string, Concept>();
  for (const { concept, re } of aliasPatterns()) {
    if (!found.has(concept.id) && re.test(text)) found.set(concept.id, concept);
  }
  return [...found.values()];
}

// ---------- registry mutation (promotion + discovery) ----------

const GENERIC_ALIASES = new Set([
  "code", "data", "error", "errors", "test", "tests", "testing", "app", "apps", "file", "files",
  "server", "python", "javascript", "js", "api", "bug", "issue", "install", "update", "mac",
  "google", "search", "video", "youtube", "claude", "chatgpt", "openai", "codex", "gpt", "ai",
  "model", "agent", "agents", "build", "system", "systems", "process", "service", "user", "state",
  "message", "messages", "answer", "question", "history", "concept", "database", "function", "cache",
]);

function cleanAlias(a: string): string | null {
  const t = a.toLowerCase().trim().replace(/\s+/g, " ");
  if (t.length < 4 || t.length > 45) return null;
  if (GENERIC_ALIASES.has(t)) return null;
  if (t.split(" ").length > 4) return null;
  return t;
}

/** Derive matchable aliases for a minted concept from its name and id slug. */
export function deriveAliases(id: string, name: string): string[] {
  const out = new Set<string>();
  const bare = name.replace(/\s*\([^)]*\)\s*/g, " ").trim(); // "CRDT (conflict-free…)" → "CRDT"
  for (const cand of [bare, ...(name.match(/\(([^)]+)\)/)?.[1] ? [name.match(/\(([^)]+)\)/)![1]] : [])]) {
    const c = cleanAlias(cand);
    if (c) out.add(c);
  }
  const slug = id.split(".").pop() ?? "";
  const slugPhrase = cleanAlias(slug.replace(/_/g, " "));
  if (slugPhrase) out.add(slugPhrase);
  return [...out];
}

export interface RegisterCandidate {
  id: string;
  name: string;
  aliases: string[];
  category: string;
  viz: Concept["viz"];
  prereqs: string[];
  source: "promoted" | "discovered";
}

/**
 * Merge candidates into the registry. Dedupe rules, in order: same id →
 * merge aliases; any alias already owned by an existing concept → fold into
 * that concept; otherwise append. Writes taxonomy/concepts.json, syncs the
 * DB concepts table, and invalidates the in-process caches so the very next
 * matchConcepts() sees the change.
 */
export function registerConcepts(candidates: RegisterCandidate[]): { added: string[]; merged: Record<string, string> } {
  const file = path.join(process.cwd(), "taxonomy", "concepts.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  const byId = new Map<string, any>(raw.concepts.map((c: any) => [c.id, c]));
  const aliasOwner = new Map<string, string>();
  for (const c of raw.concepts) for (const a of c.aliases) aliasOwner.set(a.toLowerCase(), c.id);

  const added: string[] = [];
  const merged: Record<string, string> = {};
  for (const cand of candidates) {
    const aliases = [...new Set(cand.aliases.map((a) => cleanAlias(a)).filter(Boolean) as string[])];
    const existing = byId.get(cand.id);
    const collide = aliases.map((a) => aliasOwner.get(a)).find(Boolean);
    const target = existing ?? (collide ? byId.get(collide) : null);
    if (target) {
      for (const a of aliases) {
        if (!aliasOwner.has(a)) {
          target.aliases.push(a);
          aliasOwner.set(a, target.id);
        }
      }
      if (target.id !== cand.id) merged[cand.id] = target.id;
      continue;
    }
    if (aliases.length === 0) continue; // unmatchable concept is useless in the registry
    const entry = {
      id: cand.id,
      name: cand.name,
      aliases,
      category: cand.category,
      viz: cand.viz,
      prereqs: cand.prereqs.filter((p) => byId.has(p)),
      source: cand.source,
    };
    raw.concepts.push(entry);
    byId.set(entry.id, entry);
    for (const a of aliases) aliasOwner.set(a, entry.id);
    added.push(entry.id);
  }

  if (added.length || Object.keys(merged).length) {
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    _concepts = null;
    _aliasPatterns = null;
    // Keep the DB concepts table in sync (used by inspect/eval joins).
    try {
      const { db } = require("./db");
      const stmt = db().prepare(
        "INSERT OR REPLACE INTO concepts (id, name, category, viz, prereqs, contrasts, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const id of added) {
        const c = byId.get(id);
        stmt.run(c.id, c.name, c.category, c.viz, JSON.stringify(c.prereqs), "[]", c.source);
      }
    } catch {}
  }
  return { added, merged };
}
