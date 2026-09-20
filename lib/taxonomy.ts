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
