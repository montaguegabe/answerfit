import { NextRequest, NextResponse } from "next/server";
import { personalize } from "@/lib/pipeline";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { user_id, answer } = await req.json();
    if (!user_id || !answer?.trim()) {
      return NextResponse.json({ error: "user_id and answer required" }, { status: 400 });
    }
    const result = await personalize(user_id, answer.trim());
    return NextResponse.json(result);
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
