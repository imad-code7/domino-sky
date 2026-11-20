import type {
  NetworkData,
  RecoveryAction,
  RecoveryCandidate,
  SimulationResult,
} from "../../shared/types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function getNetwork(): Promise<NetworkData> {
  return request("/api/network");
}

export function simulate(
  input: { airport: string; closeStart: number; closeEnd: number; actions: RecoveryAction[] },
): Promise<SimulationResult> {
  return request("/api/simulate", { method: "POST", body: JSON.stringify(input) });
}

export function recover(scenarioId: string): Promise<RecoveryCandidate[]> {
  return request("/api/recover", { method: "POST", body: JSON.stringify({ scenarioId }) });
}

export async function streamExplanation(
  scenarioId: string,
  onText: (chunk: string) => void,
  onSource: (source: "ai" | "offline") => void,
): Promise<void> {
  const response = await fetch("/api/ai/explain", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenarioId }),
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? "Dispatcher explanation is unavailable.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const eventName = event.match(/^event: ([\w-]+)/m)?.[1];
      const data = event.match(/^data: (.*)$/m)?.[1];
      if (!data) continue;
      const parsed = JSON.parse(data) as string | { source?: "ai" | "offline"; message?: string };
      if (eventName === "delta" && typeof parsed === "string") onText(parsed);
      if (eventName === "done" && typeof parsed === "object" && parsed.source) onSource(parsed.source);
      if (eventName === "error" && typeof parsed === "object") throw new Error(parsed.message ?? "Dispatcher stream failed.");
    }
    if (done) break;
  }
}
