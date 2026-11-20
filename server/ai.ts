import type { Metrics, RecoveryCandidate, SimulationResult } from "../shared/types";

type ExplanationSource = "ai" | "offline";

function collectNumbers(value: unknown, found = new Set<number>()): Set<number> {
  if (typeof value === "number" && Number.isFinite(value)) found.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectNumbers(item, found));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectNumbers(item, found));
  }
  return found;
}

export function numericClaimsMatch(text: string, allowed: Set<number>): boolean {
  if (/%|\b(?:flight|leg|crew|aircraft)\s+#?\d|\b(?:F|DS|S|A|C|RC)\d{1,4}\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|once|twice|double|triple|half|single|dozen|several|couple|few|many)\b/i.test(text)) {
    return false;
  }
  const claims = text.match(/(?<![A-Za-z])\d+(?:\.\d+)?/g) ?? [];
  return claims.every((claim) => allowed.has(Number(claim)));
}

function makeFallback(metrics: Metrics, candidates: RecoveryCandidate[]): string {
  const crewLabel = metrics.crewViolations === 1 ? "crew violation" : "crew violations";
  if (!candidates.length) {
    return `The deterministic run records ${metrics.delayedFlights} delayed flights, ${metrics.totalDelayMinutes} total delay minutes, ${metrics.strandedPassengers} stranded passengers, and ${metrics.crewViolations} ${crewLabel}. No evaluated recovery action improves the combined network score.`;
  }
  const best = candidates[0];
  return `The deterministic run records ${metrics.delayedFlights} delayed flights, ${metrics.totalDelayMinutes} total delay minutes, ${metrics.strandedPassengers} stranded passengers, and ${metrics.crewViolations} ${crewLabel}. The highest-ranked tested action is ${best.title}: it changes total delay from ${best.before.totalDelayMinutes} to ${best.after.totalDelayMinutes} minutes, delayed flights from ${best.before.delayedFlights} to ${best.after.delayedFlights}, stranded passengers from ${best.before.strandedPassengers} to ${best.after.strandedPassengers}, cancellations from ${best.before.cancelledFlights} to ${best.after.cancelledFlights}, and crew violations from ${best.before.crewViolations} to ${best.after.crewViolations}.`;
}

function promptPayload(result: SimulationResult, candidates: RecoveryCandidate[]) {
  return {
    baseline: result.metrics,
    rankedActions: candidates.map((candidate, rank) => ({
      rank: rank + 1,
      action: candidate.action.type,
      before: candidate.before,
      after: candidate.after,
    })),
  };
}

async function requestExplanation(
  payload: ReturnType<typeof promptPayload>,
): Promise<string | undefined> {
  const key = process.env.LLM_API_KEY;
  if (!key) return undefined;
  const baseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "Explain the results and rank the provided action types. The user-facing text may state only numeric values present in the supplied JSON. Do not calculate, infer, or introduce other numbers. Do not mention flight IDs. Keep the answer concise.",
        },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`LLM endpoint returned HTTP ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim();
  return text || undefined;
}

export async function explainAndStream(
  result: SimulationResult,
  candidates: RecoveryCandidate[],
  write: (event: "delta" | "done", data: unknown) => void,
): Promise<void> {
  const payload = promptPayload(result, candidates);
  const allowedNumbers = collectNumbers(payload);
  let text: string;
  let source: ExplanationSource = "offline";
  try {
    const responseText = await requestExplanation(payload);
    if (responseText && numericClaimsMatch(responseText, allowedNumbers)) {
      text = responseText;
      source = "ai";
    } else {
      if (responseText) console.warn("AI explanation included numbers not present in the computed result; using offline explanation.");
      text = makeFallback(result.metrics, candidates);
    }
  } catch (error) {
    console.warn("AI explanation unavailable; using offline explanation.", error);
    text = makeFallback(result.metrics, candidates);
  }

  for (let offset = 0; offset < text.length; offset += 28) {
    write("delta", text.slice(offset, offset + 28));
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  write("done", { source });
}
