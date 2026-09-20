/**
 * TypeSafe Jev client (System One model).
 * POST https://api.typesafe.ai/v1/systemone — typed noul/choice/score questions
 * over structured state, calibrated probabilities back, output tokens free.
 */

const JEV_URL = process.env.JEV_API_URL || "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = process.env.JEV_MODEL || "jev-latest";

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface JevNoulAnswer { type: "noul"; noul: number }
export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, number>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export function jevAvailable(): boolean {
  return !!process.env.JEV_API_KEY;
}

export async function jevJudge(
  state: unknown,
  questions: Record<string, JevQuestion>,
  { retries = 3 }: { retries?: number } = {}
): Promise<JevResponse> {
  const key = process.env.JEV_API_KEY;
  if (!key) throw new Error("JEV_API_KEY not set");
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(JEV_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      });
      if (res.status === 429 || res.status === 529) {
        await sleep(500 * 2 ** attempt + Math.random() * 250);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 500)}`);
      }
      return (await res.json()) as JevResponse;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Bounded-concurrency map for large fan-outs (backfill, per-concept policy). */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
