import "../lib/env";
import { db } from "../lib/db";
import { taxonomy } from "../lib/taxonomy";

const d = db();
for (const c of taxonomy()) {
  d.prepare(
    "INSERT OR REPLACE INTO concepts (id, name, category, viz, prereqs, contrasts, source) VALUES (?, ?, ?, ?, ?, ?, 'seed')"
  ).run(c.id, c.name, c.category, c.viz, JSON.stringify(c.prereqs), JSON.stringify(c.contrasts ?? []));
}
console.log(`DB initialized with ${taxonomy().length} seed concepts.`);
