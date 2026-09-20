import fs from "fs";
import path from "path";

// Real answers mined from the user's own Claude Code / Codex transcripts
// (scripts/mine-samples.ts). The synthetic spec example stays last, labeled.
function realSamples(): { id: string; title: string; text: string }[] {
  const p = path.join(process.cwd(), "data", "real-samples.json");
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")).samples.map((s: any) => ({
      id: s.id,
      title: s.title,
      text: s.text,
    }));
  } catch {
    return [];
  }
}

const SYNTHETIC: { id: string; title: string; text: string }[] = [
  {
    id: "merge-storm",
    title: "Git merge storm (synthetic spec example)",
    text: `You're seeing this because both agents are rebasing their feature branches onto main repeatedly. If both agents rebase repeatedly, you can create a merge storm: each rebased branch invalidates work based on the previous history, so every integration attempt has to be redone against a graph that no longer exists. This isn't the same thing as a race condition — the operations are serialized by git, but the repeated rewriting of commit ancestry means each agent keeps invalidating the other's integration work.

The fix: designate one integration branch and have agents merge (not rebase) into it, or serialize the rebases through a queue. A merge preserves both histories in the DAG, so previously-tested merge results stay valid. You can also use \`git rerere\` to reuse recorded conflict resolutions if the same conflicts keep reappearing.`,
  },
  {
    id: "toctou",
    title: "TOCTOU race in file check (synthetic)",
    text: `The bug is a race condition between the existence check and the write. Your code calls fs.existsSync() and then writes the file, but another process can create the file in between — this is a classic TOCTOU (time-of-check to time-of-use) problem. The check and the write are not atomic, so the interleaving of the two processes determines the outcome.

Instead, open the file with the exclusive flag: fs.open(path, 'wx') fails atomically if the file already exists, collapsing check and use into a single operation the OS guarantees. If you need cross-process coordination beyond that, take a lockfile with the same wx trick, or use a proper mutex via flock. Note this is unrelated to the Node event loop — even single-threaded JavaScript hits this because the race is between processes, not threads.`,
  },
  {
    id: "prompt-caching",
    title: "Prompt caching costs (synthetic)",
    text: `Your costs are high because every request re-sends the full 40k-token system prompt at the normal input rate. With prompt caching, you mark the stable prefix with a cache_control breakpoint; the first request pays a small write premium, and subsequent requests within the TTL read that prefix at the cache-read rate (a fraction of normal input pricing). The cache key is the exact token prefix, so any edit above the breakpoint — even one character — invalidates everything after it.

Structure prompts with stable content first (system instructions, schemas, examples) and volatile content last (user message, retrieved context). Note the TTL is refreshed on each cache hit, so a steady request stream keeps the cache warm indefinitely; a gap longer than the TTL means the next request pays the write again.`,
  },
];

export const SAMPLES: { id: string; title: string; text: string }[] = [...realSamples(), ...SYNTHETIC];
