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
  });

  it("tests a hold action and returns exact before/after metrics", () => {
    const before = demoResult();
    const candidates = recommendRecoveries(network, before);
    expect(candidates.length).toBeGreaterThanOrEqual(0);
    for (const candidate of candidates) {
      expect(candidate.before).toEqual(before.metrics);
    }
  });

  it("can relieve a projected crew-duty limit with a based reserve crew", () => {
    const before = demoResult();
    const flight = before.flights.find((item) => item.origin === "DEL");
    expect(flight).toBeDefined();
    const reserveCrew = network.crews.find((item) => item.reserve && item.base === flight?.origin);
    expect(reserveCrew).toBeDefined();
    if (!flight || !reserveCrew) return;
    const after = simulateNetwork(network, before.closure, [
      { type: "swap_crew", flightId: flight.id, replacementCrewId: reserveCrew.id },
    ]);
    expect(after.flights.find((item) => item.id === flight.id)?.assignedCrewId).toBe(reserveCrew.id);
  });

  it("supports cancellation and a spare-aircraft substitution", () => {
    const before = demoResult();
    const flight = before.flights[0];
    const cancelled = simulateNetwork(network, before.closure, [
      { type: "cancel_flight", flightId: flight.id },
    ]);
    expect(cancelled.flights.find((item) => item.id === flight.id)?.status).toBe("cancelled");
    expect(cancelled.metrics.cancelledFlights).toBe(1);

    const spare = network.spares.find((item) => item.base === flight.origin);
    if (!spare) return;
    const substituted = simulateNetwork(network, before.closure, [
      { type: "swap_spare_aircraft", flightId: flight.id, spareId: spare.id },
    ]);
    expect(substituted.flights.find((item) => item.id === flight.id)?.assignedAircraftId).toBe(spare.id);
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
