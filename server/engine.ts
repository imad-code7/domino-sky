import type {
  Closure,
  Flight,
  FlightResult,
  Metrics,
  NetworkData,
  RecoveryAction,
  RecoveryCandidate,
  SimulationResult,
} from "../shared/types";

const CREW_TURN_MINUTES = 30;

function isClosedAt(closure: Closure, airport: string, time: number): boolean {
  return airport === closure.airport && time >= closure.closeStart && time < closure.closeEnd;
}

function closeLabel(closure: Closure): string {
  return `${closure.airport} closed ${formatTime(closure.closeStart)}–${formatTime(closure.closeEnd)} IST`;
}

export function formatTime(time: number): string {
  const normalized = ((time % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function metricSummary(flights: FlightResult[], strandedPassengers: number): Metrics {
  const crewViolations = new Set(
    flights.filter((flight) => flight.crewViolation).map((flight) => flight.assignedCrewId),
  );
  return {
    totalDelayMinutes: flights.reduce((sum, flight) => sum + flight.delayMinutes, 0),
    delayedFlights: flights.filter((flight) => flight.status === "delayed").length,
    cancelledFlights: flights.filter((flight) => flight.status === "cancelled").length,
    strandedPassengers,
    crewViolations: crewViolations.size,
  };
}

export function simulateNetwork(
  network: NetworkData,
  closure: Closure,
  actions: RecoveryAction[] = [],
  scenarioId = "simulation",
): SimulationResult {
  const actionByFlight = new Map<string, RecoveryAction>();
  const heldConnections = new Set<string>();
  const crewSwapByOriginal = new Map<string, { startAt: number; replacementCrewId: string }>();
  for (const action of actions) {
    if (action.type === "hold_connection") {
      heldConnections.add(action.connectionId);
    } else {
      actionByFlight.set(action.flightId, action);
      if (action.type === "swap_crew") {
        const target = network.flights.find((flight) => flight.id === action.flightId);
        if (!target) throw new Error(`Unknown flight for crew swap: ${action.flightId}`);
        if (crewSwapByOriginal.has(target.crewId)) throw new Error(`Crew rotation ${target.crewId} has multiple swap actions`);
        crewSwapByOriginal.set(target.crewId, {
          startAt: target.scheduledDeparture,
          replacementCrewId: action.replacementCrewId,
        });
      }
    }
  }

  const connectionsByOutbound = new Map<string, typeof network.connections>();
  for (const connection of network.connections) {
    const list = connectionsByOutbound.get(connection.outboundFlightId) ?? [];
    list.push(connection);
    connectionsByOutbound.set(connection.outboundFlightId, list);
  }

  const aircraftReady = new Map<string, number>();
  const aircraftReasons = new Map<string, string[]>();
  const crewReady = new Map<string, number>();
  const crewReasons = new Map<string, string[]>();
  const crewDutyStart = new Map<string, number>();
  const resultsById = new Map<string, FlightResult>();
  const results: FlightResult[] = [];
  const sortedFlights = [...network.flights].sort(
    (a, b) => a.scheduledDeparture - b.scheduledDeparture || a.id.localeCompare(b.id),
  );

  for (const flight of sortedFlights) {
    const action = actionByFlight.get(flight.id);
    const cancelled = action?.type === "cancel_flight";
    const assignedAircraftId = action?.type === "swap_spare_aircraft" ? action.spareId : flight.aircraftId;
    const crewSwap = crewSwapByOriginal.get(flight.crewId);
    const assignedCrewId = crewSwap && flight.scheduledDeparture >= crewSwap.startAt
      ? crewSwap.replacementCrewId
      : flight.crewId;
    const aircraft = [...network.aircraft, ...network.spares].find((item) => item.id === assignedAircraftId);
    const crew = network.crews.find((item) => item.id === assignedCrewId);
    if (!aircraft || !crew) throw new Error(`Unknown aircraft or crew assignment on flight ${flight.id}`);
    if (action?.type === "swap_spare_aircraft" && aircraft.base !== flight.origin) {
      throw new Error(`Spare aircraft ${aircraft.id} is not based at ${flight.origin}`);
    }
    if (action?.type === "swap_crew" && crew.base !== flight.origin) {
      throw new Error(`Reserve crew ${crew.id} is not based at ${flight.origin}`);
    }

    const previousAircraftReady = aircraftReady.get(assignedAircraftId) ?? Number.NEGATIVE_INFINITY;
    const previousCrewReady = crewReady.get(assignedCrewId) ?? Number.NEGATIVE_INFINITY;
    const crewStart = crewDutyStart.get(assignedCrewId) ?? flight.scheduledDeparture - crew.reportMinutes;
    crewDutyStart.set(assignedCrewId, crewStart);

    let actualDeparture = Math.max(flight.scheduledDeparture, previousAircraftReady, previousCrewReady);
    const reasons: string[] = [];
    const priorReasons: string[] = [];
    if (previousAircraftReady > flight.scheduledDeparture) {
      priorReasons.push(...(aircraftReasons.get(assignedAircraftId) ?? []));
      reasons.push(`Aircraft turnaround behind the prior leg`);
    }
    if (previousCrewReady > flight.scheduledDeparture) {
      priorReasons.push(...(crewReasons.get(assignedCrewId) ?? []));
      reasons.push(`Crew readiness behind the prior duty leg`);
    }

    const heldUntil = (connectionsByOutbound.get(flight.id) ?? [])
      .filter((connection) => heldConnections.has(connection.id))
      .map((connection) => {
        const inbound = resultsById.get(connection.inboundFlightId);
        return inbound && inbound.status !== "cancelled"
          ? inbound.actualArrival + connection.minConnectMinutes
          : flight.scheduledDeparture;
      });
    const latestHold = heldUntil.length ? Math.max(...heldUntil) : flight.scheduledDeparture;
    if (latestHold > actualDeparture) {
      actualDeparture = latestHold;
      reasons.push("Held for a connecting passenger transfer");
    }

    if (isClosedAt(closure, flight.origin, actualDeparture)) {
      actualDeparture = closure.closeEnd;
      reasons.push(`Airport closure at departure (${closeLabel(closure)})`);
    }
    let actualArrival = actualDeparture + flight.blockMinutes;
    if (isClosedAt(closure, flight.destination, actualArrival)) {
      actualDeparture = Math.max(actualDeparture, closure.closeEnd - flight.blockMinutes);
      actualArrival = actualDeparture + flight.blockMinutes;
      reasons.push(`Airport closure at arrival (${closeLabel(closure)})`);
    }

    const delayMinutes = cancelled ? 0 : Math.max(0, actualDeparture - flight.scheduledDeparture);
    const dutyElapsed = actualArrival - crewStart;
    const crewViolation = !cancelled && dutyElapsed > crew.maxDutyMinutes;
    const result: FlightResult = {
      ...flight,
      scheduledArrival: flight.scheduledDeparture + flight.blockMinutes,
      actualDeparture: cancelled ? flight.scheduledDeparture : actualDeparture,
      actualArrival: cancelled ? flight.scheduledDeparture + flight.blockMinutes : actualArrival,
      delayMinutes,
      status: cancelled ? "cancelled" : delayMinutes > 0 ? "delayed" : "on-time",
      reasonChain: cancelled ? ["Flight cancelled as a recovery action"] : unique([...priorReasons, ...reasons]),
      crewViolation,
      assignedAircraftId,
      assignedCrewId,
    };
    results.push(result);
    resultsById.set(flight.id, result);

    const aircraftReadyAt = cancelled
      ? flight.scheduledDeparture + flight.blockMinutes + aircraft.turnaroundMinutes
      : actualArrival + aircraft.turnaroundMinutes;
    aircraftReady.set(assignedAircraftId, aircraftReadyAt);
    aircraftReasons.set(assignedAircraftId, result.reasonChain);
    crewReady.set(assignedCrewId, actualArrival + CREW_TURN_MINUTES);
    crewReasons.set(assignedCrewId, result.reasonChain);
  }

  const connections = network.connections.map((connection) => {
    const inbound = resultsById.get(connection.inboundFlightId);
    const outbound = resultsById.get(connection.outboundFlightId);
    if (!inbound || !outbound) throw new Error(`Connection ${connection.id} references an unknown flight`);
    const broken = inbound.status === "cancelled"
      || outbound.status === "cancelled"
      || inbound.actualArrival + connection.minConnectMinutes > outbound.actualDeparture;
    return { ...connection, broken, strandedPassengers: broken ? connection.passengers : 0 };
  });
  const strandedPassengers = connections.reduce((sum, connection) => sum + connection.strandedPassengers, 0);
  const timeline = results
    .filter((flight) => flight.status !== "cancelled")
    .map((flight) => ({
      time: flight.actualDeparture,
      flightId: flight.id,
      airport: flight.origin,
      delayMinutes: flight.delayMinutes,
    }))
    .sort((a, b) => a.time - b.time);

  return {
    scenarioId,
    closure,
    flights: results,
    connections,
    metrics: metricSummary(results, strandedPassengers),
    timeline,
    appliedActions: actions,
  };
}

function actionTitle(action: RecoveryAction, network: NetworkData): string {
  if (action.type === "hold_connection") {
    const connection = network.connections.find((item) => item.id === action.connectionId);
    const outbound = network.flights.find((item) => item.id === connection?.outboundFlightId);
    return outbound ? `Hold ${outbound.origin} → ${outbound.destination} for a connecting transfer` : "Hold connecting flight";
  }
  const flight = network.flights.find((item) => item.id === action.flightId);
  const route = flight ? `${flight.origin} → ${flight.destination}` : "selected route";
  if (action.type === "cancel_flight") return `Cancel the ${route} service`;
  if (action.type === "swap_spare_aircraft") return `Use a reserve aircraft for ${route}`;
  if (action.type === "swap_crew") return `Swap reserve crew onto ${route}`;
  return "Hold connecting flight";
}

export function recommendRecoveries(
  network: NetworkData,
  baseline: SimulationResult,
): RecoveryCandidate[] {
  const options: RecoveryAction[] = [];
  const usedFlights = baseline.flights.filter((flight) => flight.status === "delayed" || flight.crewViolation);
  const usedSpares = new Set(baseline.appliedActions
    .filter((action) => action.type === "swap_spare_aircraft")
    .map((action) => action.spareId));
  const usedReserveCrews = new Set(baseline.appliedActions
    .filter((action) => action.type === "swap_crew")
    .map((action) => action.replacementCrewId));
  const changedFlights = new Set(baseline.appliedActions
    .filter((action) => action.type !== "hold_connection")
    .map((action) => action.flightId));
  const heldConnections = new Set(baseline.appliedActions
    .filter((action) => action.type === "hold_connection")
    .map((action) => action.connectionId));
  for (const flight of usedFlights.filter((item) => !changedFlights.has(item.id))) {
    if (flight.status === "delayed") {
      options.push({ type: "cancel_flight", flightId: flight.id });
      for (const spare of network.spares.filter((item) => item.base === flight.origin && !usedSpares.has(item.id))) {
        options.push({ type: "swap_spare_aircraft", flightId: flight.id, spareId: spare.id });
      }
    }
    for (const replacement of network.crews.filter((item) =>
      item.reserve && item.base === flight.origin && !usedReserveCrews.has(item.id),
    )) {
      options.push({ type: "swap_crew", flightId: flight.id, replacementCrewId: replacement.id });
    }
  }
  for (const connection of baseline.connections.filter((item) => item.broken && !heldConnections.has(item.id))) {
    options.push({ type: "hold_connection", connectionId: connection.id });
  }

  const candidates = options.map((action, index) => {
    const after = simulateNetwork(
      network,
      baseline.closure,
      [...baseline.appliedActions, action],
      `${baseline.scenarioId}-candidate-${index}`,
    );
    const inbound = action.type === "hold_connection"
      ? network.connections.find((item) => item.id === action.connectionId)
      : undefined;
    const flight = action.type !== "hold_connection"
      ? network.flights.find((item) => item.id === action.flightId)
      : undefined;
    const rationale = action.type === "hold_connection"
      ? `Protect a transfer at ${inbound?.outboundFlightId ? network.flights.find((item) => item.id === inbound.outboundFlightId)?.origin : "the connecting airport"}.`
      : action.type === "swap_spare_aircraft"
        ? `Use an available reserve based at ${network.spares.find((item) => item.id === action.spareId)?.base ?? "the origin"}.`
        : action.type === "swap_crew"
          ? "Replace the assigned crew with a reserve crew."
          : `Remove ${flight?.callsign ?? action.flightId} from the operating plan.`;
    return {
      id: `REC-${String(index + 1).padStart(2, "0")}`,
      action,
      title: actionTitle(action, network),
      rationale,
      before: baseline.metrics,
      after: after.metrics,
    };
  });

  const score = (metrics: Metrics) => metrics.totalDelayMinutes
    + metrics.delayedFlights * 45
    + metrics.cancelledFlights * 120
    + metrics.strandedPassengers * 2
    + metrics.crewViolations * 180;
  return candidates
    .filter((candidate) => score(candidate.after) < score(candidate.before))
    .sort((a, b) => score(a.after) - score(b.after))
    .slice(0, 8);
}
