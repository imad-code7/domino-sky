import { describe, expect, it } from "vitest";
import { network } from "./dataset";
import { numericClaimsMatch } from "./ai";
import { recommendRecoveries, simulateNetwork } from "./engine";

const demoResult = () => simulateNetwork(network, {
  airport: network.demoPreset.airport,
  closeStart: network.demoPreset.closeStart,
  closeEnd: network.demoPreset.closeStart + network.demoPreset.duration,
});

describe("demo network integration", () => {
  it("uses the declared network and the Mumbai closure creates delays and broken transfers", () => {
    const result = demoResult();
    expect(network.airports).toHaveLength(16);
    expect(result.flights).toHaveLength(70);
    expect(result.metrics.delayedFlights).toBeGreaterThan(0);
    expect(result.connections.find((connection) => connection.id === "X09")?.broken).toBe(true);
    expect(result.metrics.strandedPassengers).toBeGreaterThanOrEqual(58);
  });

  it("tests a hold action and returns exact before/after metrics", () => {
    const before = demoResult();
    const candidate = recommendRecoveries(network, before).find(
      (item) => item.action.type === "hold_connection" && item.action.connectionId === "X09",
    );
    expect(candidate).toBeDefined();
    expect(candidate?.before).toEqual(before.metrics);
    expect(candidate?.after.strandedPassengers).toBeLessThan(before.metrics.strandedPassengers);
    expect(candidate?.after.totalDelayMinutes).toBeGreaterThan(before.metrics.totalDelayMinutes);
  });

  it("can relieve a projected crew-duty limit with a based reserve crew", () => {
    const before = demoResult();
    const flight = before.flights.find((item) => item.id === "F008");
    expect(flight?.crewViolation).toBe(true);
    const after = simulateNetwork(network, before.closure, [
      { type: "swap_crew", flightId: "F008", replacementCrewId: "RC2" },
    ]);
    expect(after.flights.find((item) => item.id === "F008")?.assignedCrewId).toBe("RC2");
    expect(after.metrics.crewViolations).toBe(0);
  });

  it("supports cancellation and a spare-aircraft substitution", () => {
    const before = demoResult();
    const cancelled = simulateNetwork(network, before.closure, [
      { type: "cancel_flight", flightId: "F016" },
    ]);
    expect(cancelled.flights.find((item) => item.id === "F016")?.status).toBe("cancelled");
    expect(cancelled.metrics.cancelledFlights).toBe(1);

    const substituted = simulateNetwork(network, before.closure, [
      { type: "swap_spare_aircraft", flightId: "F016", spareId: "S01" },
    ]);
    expect(substituted.flights.find((item) => item.id === "F016")?.assignedAircraftId).toBe("S01");
    expect(substituted.metrics.totalDelayMinutes).toBeLessThan(before.metrics.totalDelayMinutes);
  });

  it("accepts only numeric claims present in the engine payload", () => {
    const metrics = demoResult().metrics;
    const allowed = new Set(Object.values(metrics));
    expect(numericClaimsMatch(`The network has ${metrics.delayedFlights} delayed flights.`, allowed)).toBe(true);
    expect(numericClaimsMatch("The network has 999 delayed flights.", allowed)).toBe(false);
    expect(numericClaimsMatch("The network has two delayed flights.", allowed)).toBe(false);
    expect(numericClaimsMatch("Flight 7 will be two hours late.", allowed)).toBe(false);
  });
});
