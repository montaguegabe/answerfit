/**
 * Seed the two synthetic personas (smaller-plan Day 4 step 2) as strong
 * evidence rows, so provenance still works ("synthetic persona seed").
 */
import "../lib/env";
import { db } from "../lib/db";
import { addEvidence, refreshState } from "../lib/mastery";
import { taxonomy } from "../lib/taxonomy";

interface PersonaSpec {
  id: string;
  name: string;
  description: string;
  // conceptId (or category prefix ending in ".") → mastery target: + strong known, - strong unknown
  knowledge: Record<string, number>;
}

const PERSONAS: PersonaSpec[] = [
  {
    id: "junior-frontend",
    name: "Junior frontend dev",
    description: "Comfortable with React/CSS basics; shaky on git internals and concurrency",
    knowledge: {
      "react.hooks": 0.9,
      "css.layout": 0.95,
      "js.closures": 0.5,
      "js.async_await": 0.4,
      "git.basics": 0.7,
      "git.merge": -0.4,
      "git.rebase": -0.9,
      "git.dag": -0.9,
      "git.merge_storm": -1.0,
      "concurrency.race_condition": -0.7,
      "concurrency.toctou": -1.0,
      "concurrency.atomicity": -0.8,
      "concurrency.event_loop": -0.3,
      "concurrency.deadlock": -0.9,
      "db.transactions": -0.8,
    },
  },
  {
    id: "git-expert",
    name: "Senior git expert",
    description: "Deep git internals + systems background; knows nearly everything in the demo answers",
    knowledge: {
      "git.": 1.0,
      "git.merge_storm": 0.85,
      "concurrency.": 0.9,
      "db.": 0.8,
      "web.": 0.7,
      "js.async_await": 0.8,
      "react.hooks": -0.3,
      "css.layout": -0.2,
    },
  },
];

const d = db();
for (const p of PERSONAS) {
  d.prepare("INSERT OR REPLACE INTO users (id, name, kind, description) VALUES (?, ?, 'synthetic', ?)").run(
    p.id,
    p.name,
    p.description
  );
  d.prepare("DELETE FROM events WHERE user_id = ?").run(p.id);
  const touched = new Set<string>();
  for (const c of taxonomy()) {
    // Most specific matching key wins (exact id beats category prefix).
    const key = Object.keys(p.knowledge)
      .filter((k) => c.id === k || (k.endsWith(".") && c.id.startsWith(k)))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) continue;
    const target = p.knowledge[key];
    addEvidence({
      userId: p.id,
      conceptId: c.id,
      ts: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      source: "persona_seed",
      rawText: `Persona seed: ${p.name}`,
      dimension: target > 0 ? "apply" : "recognition",
      direction: Math.sign(target) * 2, // strong signed evidence
      strength: Math.abs(target),
      interpretation: "persona_seed",
      judge: "heuristic",
    });
    touched.add(c.id);
  }
  for (const cid of touched) refreshState(p.id, cid);
  console.log(`Seeded ${p.id} (${touched.size} concepts)`);
}
