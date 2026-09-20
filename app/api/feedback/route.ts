import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { addEvidence, refreshState } from "@/lib/mastery";

// Feedback → evidence append → state refresh (smaller-plan Day 4 loop).
const ACTIONS: Record<string, { dimension: string; direction: number; strength: number }> = {
  already_knew: { dimension: "explain", direction: 2, strength: 0.95 },
  still_confused: { dimension: "explain", direction: -2, strength: 0.9 },
  more_detail: { dimension: "explain", direction: -0.5, strength: 0.5 },
  show_visually: { dimension: "recognition", direction: -0.2, strength: 0.3 },
};

export async function POST(req: NextRequest) {
  const { user_id, concept_id, action } = await req.json();
  const spec = ACTIONS[action];
  if (!user_id || !concept_id || !spec) {
    return NextResponse.json({ error: "user_id, concept_id, valid action required" }, { status: 400 });
  }
  const ts = new Date().toISOString();
  db().prepare("INSERT INTO feedback (user_id, concept_id, action, ts) VALUES (?, ?, ?, ?)").run(
    user_id,
    concept_id,
    action,
    ts
  );
  addEvidence({
    userId: user_id,
    conceptId: concept_id,
    ts,
    source: "feedback",
    rawText: `User clicked: ${action.replace("_", " ")}`,
    dimension: spec.dimension,
    direction: spec.direction,
    strength: spec.strength,
    interpretation: action,
    judge: "heuristic",
  });
  const state = refreshState(user_id, concept_id);
  return NextResponse.json({ ok: true, state });
}
