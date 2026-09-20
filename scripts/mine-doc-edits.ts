/**
 * Mine the user's MANUAL markdown edits from git history as learner evidence.
 *
 * Rationale (user-reported): "sometimes I edit .md files manually and remove
 * concepts I don't understand." A human-authored commit that deletes lines
 * mentioning a concept is candidate negative evidence; a human-authored commit
 * that adds substantive text about a concept is can_explain-level positive
 * evidence. Files themselves are never read (unattributable mix of human +
 * agent + template text); git commits give author, timestamp, and diff.
 *
 * Judgment is Jev-first: for each (commit, concept) removal, Jev classifies
 * the removal reason (didn't-understand vs cleanup vs no-longer-relevant) and
 * for additions whether the text substantively explains the concept. The
 * fixed heuristic runs only when Jev is unavailable, at reduced strength.
 *
 * Only commits authored by the user WITHOUT agent trailers count — agent
 * commits (including dirty-commit sweeps) are excluded since their diffs
 * can't be attributed to the human. Idempotent: re-run replaces all
 * source='doc_edit' evidence (re-run after Jev credits return to upgrade
 * heuristic judgments).
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import "../lib/env";
import { db } from "../lib/db";
import { matchConcepts } from "../lib/taxonomy";
import { refreshState } from "../lib/mastery";
import { jevJudge, jevAvailable, mapConcurrent, type JevQuestion, type JevChoiceAnswer, type JevNoulAnswer } from "../lib/models/jev";

const USER = "gabe";
const AUTHOR_RE = /gabe|montague/i;
const AGENT_MARKERS = /(co-authored-by:\s*(claude|codex|openbase)|agent-thread-id|generated with \[?claude code|🤖)/i;
const MAX_COMMITS_PER_REPO = 500;

function sh(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function findRepos(root: string, maxDepth: number): string[] {
  const repos: string[] = [];
  (function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    if (entries.includes(".git")) { repos.push(dir); return; } // don't recurse into repos
    for (const e of entries) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = path.join(dir, e);
      try { if (fs.statSync(p).isDirectory()) walk(p, depth + 1); } catch {}
    }
  })(root, 0);
  return repos;
}

interface DocEdit {
  repo: string;
  sha: string;
  ts: string;
  message: string;
  concept_id: string;
  kind: "removal" | "addition";
  excerpt: string; // the removed/added lines mentioning the concept
}

function collectEdits(): DocEdit[] {
  const repos = findRepos(path.join(os.homedir(), "Projects"), 4);
  console.log(`Scanning ${repos.length} git repos for manual .md edits…`);
  const edits: DocEdit[] = [];
  for (const repo of repos) {
    const log = sh(
      `git log --no-merges -n ${MAX_COMMITS_PER_REPO} --format='%H%x01%an%x01%ae%x01%aI%x01%B%x02' -- '*.md'`,
      repo
    );
    if (!log.trim()) continue;
    for (const entry of log.split("\x02")) {
      const [sha, an, ae, aI, body] = entry.trim().split("\x01");
      if (!sha || !aI) continue;
      if (!AUTHOR_RE.test(an ?? "") && !AUTHOR_RE.test(ae ?? "")) continue;
      if (AGENT_MARKERS.test(body ?? "")) continue;
      const diff = sh(`git show ${sha} --format= --unified=0 -- '*.md'`, repo);
      if (!diff) continue;
      const removed: string[] = [];
      const added: string[] = [];
      for (const line of diff.split("\n")) {
        if (line.startsWith("---") || line.startsWith("+++")) continue;
        if (line.startsWith("-")) removed.push(line.slice(1));
        else if (line.startsWith("+")) added.push(line.slice(1));
      }
      const removedText = removed.join("\n");
      const addedText = added.join("\n");
      const removedIds = new Set(matchConcepts(removedText).map((c) => c.id));
      const addedIds = new Set(matchConcepts(addedText).map((c) => c.id));
      const msg = (body ?? "").split("\n")[0].slice(0, 120);
      for (const cid of removedIds) {
        if (addedIds.has(cid)) continue; // moved/rephrased, not removed
        const lines = removed.filter((l) => matchConcepts(l).some((c) => c.id === cid));
        edits.push({ repo: path.basename(repo), sha, ts: aI, message: msg, concept_id: cid, kind: "removal", excerpt: lines.join("\n").slice(0, 400) });
      }
      for (const cid of addedIds) {
        if (removedIds.has(cid)) continue;
        const lines = added.filter((l) => matchConcepts(l).some((c) => c.id === cid));
        edits.push({ repo: path.basename(repo), sha, ts: aI, message: msg, concept_id: cid, kind: "addition", excerpt: lines.join("\n").slice(0, 400) });
      }
    }
  }
  return edits;
}

// Agents commit under the user's git identity, often without trailers (e.g.
// automated docs-freshness passes in dated worktree checkouts) — author
// metadata alone cannot establish human authorship. Jev judges it per commit.
const AUTHORSHIP_QUESTION: JevQuestion = {
  type: "choice",
  instructions:
    "Was this markdown commit made manually by the human user, or by an AI coding agent working under the user's git identity? Signals: agents write descriptive/systematic commit messages and run bulk 'freshness'/regeneration passes, often in dated worktree checkouts; humans make small targeted edits with terse messages.",
  criteria: {
    human_manual: "A person's own targeted edit",
    agent_automated: "An AI agent's commit (bulk pass, generated docs, systematic rewrite)",
    unclear: "Cannot tell",
  },
};

const REMOVAL_QUESTIONS: Record<string, JevQuestion> = {
  authorship: AUTHORSHIP_QUESTION,
  reason: {
    type: "choice",
    instructions:
      "The user manually deleted these lines from a markdown doc they maintain. Why, most likely? (The user self-reports sometimes removing concepts they don't understand.)",
    criteria: {
      not_understood: "Removing content about a concept the user doesn't understand or can't vouch for",
      cleanup: "Restructuring, deduplicating, or trimming verbosity — content survives elsewhere or wasn't load-bearing",
      no_longer_relevant: "The content became outdated or out of scope for the project",
      unclear: "Cannot tell from this diff",
    },
  },
};

const ADDITION_QUESTIONS: Record<string, JevQuestion> = {
  authorship: AUTHORSHIP_QUESTION,
  substantive: {
    type: "noul",
    instructions:
      "Do these manually-authored doc lines substantively explain or operationalize the concept (vs a bare link, name-drop, or checklist mention)?",
  },
};

interface Verdict { direction: number; strength: number; interpretation: string; judge: "jev" | "heuristic"; skip?: boolean }

async function judge(e: DocEdit): Promise<Verdict> {
  if (jevAvailable()) {
    try {
      const state = {
        repo_directory_name: e.repo,
        repo_name_looks_like_dated_worktree: /-20\d\d-\d\d-\d\d/.test(e.repo),
        commit_message: e.message,
        concept: e.concept_id,
        [e.kind === "removal" ? "removed_lines" : "added_lines"]: e.excerpt,
      };
      const res = await jevJudge(state, e.kind === "removal" ? REMOVAL_QUESTIONS : ADDITION_QUESTIONS);
      const auth = res.answers.authorship as JevChoiceAnswer;
      if (auth.choice !== "human_manual" || auth.confidence < 0.4) {
        return { direction: 0, strength: 0, interpretation: `authorship_${auth.choice}`, judge: "jev", skip: true };
      }
      if (e.kind === "removal") {
        const r = res.answers.reason as JevChoiceAnswer;
        if (r.choice === "not_understood")
          return { direction: -0.6, strength: 0.4 + 0.4 * r.confidence, interpretation: "removed_not_understood", judge: "jev" };
        return { direction: 0, strength: 0, interpretation: r.choice, judge: "jev", skip: true };
      } else {
        const s = (res.answers.substantive as JevNoulAnswer).noul;
        if (s > 0.5) return { direction: 0.5, strength: 0.3 + 0.4 * s, interpretation: "authored_doc_explanation", judge: "jev" };
        return { direction: 0, strength: 0, interpretation: "namedrop", judge: "jev", skip: true };
      }
    } catch {
      /* fall through to heuristic */
    }
  }
  // No-Jev fallback: weak fixed verdicts (upgrade by re-running post-credits).
  return e.kind === "removal"
    ? { direction: -0.35, strength: 0.35, interpretation: "removed_concept_mention", judge: "heuristic" }
    : { direction: 0.4, strength: 0.35, interpretation: "authored_doc_mention", judge: "heuristic" };
}

async function main() {
  const edits = collectEdits();
  console.log(`${edits.length} candidate doc-edit evidence events (${edits.filter((e) => e.kind === "removal").length} removals, ${edits.filter((e) => e.kind === "addition").length} additions)`);
  const d = db();
  d.prepare("DELETE FROM events WHERE user_id = ? AND source = 'doc_edit'").run(USER);
  const insert = d.prepare(
    `INSERT INTO events (user_id, concept_id, ts, source, raw_text, dimension, direction, strength, interpretation, judge)
     VALUES (?, ?, ?, 'doc_edit', ?, ?, ?, ?, ?, ?)`
  );
  let written = 0, skipped = 0;
  const verdicts = await mapConcurrent(edits, 16, judge);
  edits.forEach((e, i) => {
    const v = verdicts[i];
    if (v.skip || v.strength === 0) { skipped++; return; }
    insert.run(
      USER, e.concept_id, e.ts,
      `[${e.repo} ${e.sha.slice(0, 7)}] ${e.kind}: "${e.excerpt.slice(0, 120)}" (${e.message})`,
      e.kind === "removal" ? "conceptual" : "explain",
      v.direction, v.strength, v.interpretation, v.judge
    );
    written++;
  });
  const touched = new Set(edits.map((e) => e.concept_id));
  for (const cid of touched) refreshState(USER, cid);
  console.log(`Wrote ${written} evidence rows (${skipped} judged non-informative), refreshed ${touched.size} concept states.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
