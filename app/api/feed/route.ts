import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const row = db().prepare("SELECT * FROM feed WHERE id = ?").get(Number(id)) as any;
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ...row, result: row.result ? JSON.parse(row.result) : null });
  }
  if (req.nextUrl.searchParams.get("unnotified") === "1") {
    const rows = db()
      .prepare("SELECT id, ts, headline, gaps_count FROM feed WHERE status='done' AND notified=0 AND gaps_count > 0 ORDER BY id")
      .all();
    return NextResponse.json({ items: rows });
  }
  const rows = db()
    .prepare("SELECT id, ts, session_id, status, gaps_count, headline, substr(answer,1,90) preview FROM feed ORDER BY id DESC LIMIT 30")
    .all();
  return NextResponse.json({ items: rows });
}

// Mark feed items as notified (hook calls this after emitting its one-liner).
export async function POST(req: NextRequest) {
  const { notified_ids } = await req.json();
  if (Array.isArray(notified_ids) && notified_ids.length) {
    const stmt = db().prepare("UPDATE feed SET notified=1 WHERE id=?");
    for (const id of notified_ids) stmt.run(Number(id));
  }
  return NextResponse.json({ ok: true });
}
