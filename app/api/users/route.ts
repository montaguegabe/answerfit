import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { SAMPLES } from "@/lib/samples";

export async function GET() {
  const users = db().prepare("SELECT id, name, kind, description FROM users ORDER BY kind DESC, id").all();
  return NextResponse.json({ users, samples: SAMPLES });
}
