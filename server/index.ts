import "dotenv/config";
import cors from "cors";
import express from "express";
import { z } from "zod";
import type { RecoveryCandidate, SimulationResult } from "../shared/types";
import { explainAndStream } from "./ai";
import { network } from "./dataset";
import { recommendRecoveries, simulateNetwork } from "./engine";

const app = express();
const port = Number(process.env.PORT ?? 5174);
app.use(cors());
app.use(express.json({ limit: "64kb" }));

const scenarioStore = new Map<string, {
  result: SimulationResult;
  candidates?: RecoveryCandidate[];
}>();

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel_flight"), flightId: z.string() }),
  z.object({ type: z.literal("swap_spare_aircraft"), flightId: z.string(), spareId: z.string() }),
  z.object({ type: z.literal("swap_crew"), flightId: z.string(), replacementCrewId: z.string() }),
  z.object({ type: z.literal("hold_connection"), connectionId: z.string() }),
]);

const simulationSchema = z.object({
  airport: z.string().length(3),
  closeStart: z.number().int().min(0).max(1439),
  closeEnd: z.number().int().min(1).max(2879),
  actions: z.array(actionSchema).default([]),
});

const scenarioSchema = z.object({ scenarioId: z.string().min(1) });

function sendError(response: express.Response, status: number, message: string): void {
  response.status(status).json({ error: message });
}

app.get("/api/network", (_request, response) => {
  response.json(network);
});

app.post("/api/simulate", (request, response) => {
  const parsed = simulationSchema.safeParse(request.body);
  if (!parsed.success) return sendError(response, 400, parsed.error.issues[0]?.message ?? "Invalid simulation request.");
  const { airport, closeStart, closeEnd, actions } = parsed.data;
  if (!network.airports.some((item) => item.code === airport)) return sendError(response, 400, `Unknown airport: ${airport}`);
  if (closeEnd <= closeStart) return sendError(response, 400, "The closure end must be after its start.");

  for (const action of actions) {
    if (action.type === "hold_connection" && !network.connections.some((item) => item.id === action.connectionId)) {
      return sendError(response, 400, `Unknown connection: ${action.connectionId}`);
    }
    if (action.type !== "hold_connection" && !network.flights.some((item) => item.id === action.flightId)) {
      return sendError(response, 400, `Unknown flight: ${action.flightId}`);
    }
    if (action.type === "swap_spare_aircraft") {
      const spare = network.spares.find((item) => item.id === action.spareId);
      if (!spare) return sendError(response, 400, `Unknown spare aircraft: ${action.spareId}`);
      const flight = network.flights.find((item) => item.id === action.flightId);
      if (spare.base !== flight?.origin) return sendError(response, 400, "A spare aircraft must be based at the flight's origin.");
    }
    if (action.type === "swap_crew") {
      const replacement = network.crews.find((item) => item.id === action.replacementCrewId && item.reserve);
      const flight = network.flights.find((item) => item.id === action.flightId);
      if (!replacement || replacement.base !== flight?.origin) {
        return sendError(response, 400, "The replacement crew must be a reserve based at the flight's origin.");
      }
    }
  }
  const changedFlights = actions.filter((action) => action.type !== "hold_connection").map((action) => action.flightId);
  const usedSpareIds = actions.filter((action) => action.type === "swap_spare_aircraft").map((action) => action.spareId);
  const usedReserveCrewIds = actions.filter((action) => action.type === "swap_crew").map((action) => action.replacementCrewId);
  const swappedCrewRotations = actions
    .filter((action) => action.type === "swap_crew")
    .map((action) => network.flights.find((flight) => flight.id === action.flightId)?.crewId)
    .filter((crewId): crewId is string => Boolean(crewId));
  if (new Set(changedFlights).size !== changedFlights.length) return sendError(response, 400, "A flight can have only one recovery action.");
  if (new Set(usedSpareIds).size !== usedSpareIds.length) return sendError(response, 400, "A spare aircraft can be assigned to only one flight.");
  if (new Set(usedReserveCrewIds).size !== usedReserveCrewIds.length) return sendError(response, 400, "A reserve crew can be assigned to only one flight.");
  if (new Set(swappedCrewRotations).size !== swappedCrewRotations.length) return sendError(response, 400, "A crew rotation can have only one reserve-crew swap.");

  const scenarioId = `SKY-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const result = simulateNetwork(network, { airport, closeStart, closeEnd }, actions, scenarioId);
  scenarioStore.set(scenarioId, { result });
  response.json(result);
});

app.post("/api/recover", (request, response) => {
  const parsed = scenarioSchema.safeParse(request.body);
  if (!parsed.success) return sendError(response, 400, "A valid scenarioId is required.");
  const scenario = scenarioStore.get(parsed.data.scenarioId);
  if (!scenario) return sendError(response, 404, "Scenario not found. Run a simulation first.");
  const candidates = recommendRecoveries(network, scenario.result);
  scenario.candidates = candidates;
  response.json(candidates);
});

app.post("/api/ai/explain", async (request, response) => {
  const parsed = scenarioSchema.safeParse(request.body);
  if (!parsed.success) return sendError(response, 400, "A valid scenarioId is required.");
  const scenario = scenarioStore.get(parsed.data.scenarioId);
  if (!scenario) return sendError(response, 404, "Scenario not found. Run a simulation first.");
  const candidates = scenario.candidates ?? recommendRecoveries(network, scenario.result);
  scenario.candidates = candidates;

  response.status(200);
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders();
  try {
    await explainAndStream(scenario.result, candidates, (event, data) => {
      if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    });
    response.end();
  } catch (error) {
    console.error("Could not stream dispatcher explanation.", error);
    if (!response.writableEnded) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: "Could not create an explanation." })}\n\n`);
      response.end();
    }
  }
});

app.get("/api/health", (_request, response) => response.json({ status: "ok", flights: network.flights.length }));

app.listen(port, () => {
  console.log(`Domino Sky API ready at http://localhost:${port}`);
});
