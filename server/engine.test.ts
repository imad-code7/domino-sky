import { describe, expect, it } from "vitest";
import type { NetworkData } from "../shared/types";
import { simulateNetwork } from "./engine";

const airport = (code: string, lng: number) => ({
  code, name: code, city: code, lat: 19, lng,
});

function testNetwork(): NetworkData {
  return {
    airports: [airport("BOM", 72), airport("DEL", 77), airport("BLR", 78)],
    aircraft: [{ id: "A1", label: "Aircraft 1", base: "BOM", turnaroundMinutes: 45 }],
    spares: [],
    crews: [{ id: "C1", label: "Crew 1", maxDutyMinutes: 720, reportMinutes: 45, reserve: false }],
    flights: [
      { id: "F1", callsign: "T1", origin: "BOM", destination: "DEL", scheduledDeparture: 600, blockMinutes: 90, aircraftId: "A1", crewId: "C1", passengers: 100 },
      { id: "F2", callsign: "T2", origin: "DEL", destination: "BOM", scheduledDeparture: 735, blockMinutes: 90, aircraftId: "A1", crewId: "C1", passengers: 100 },
      { id: "F3", callsign: "T3", origin: "BOM", destination: "BLR", scheduledDeparture: 870, blockMinutes: 90, aircraftId: "A1", crewId: "C1", passengers: 100 },
    ],
    connections: [
      { id: "X1", inboundFlightId: "F1", outboundFlightId: "F2", passengers: 30, minConnectMinutes: 45 },
    ],
    demoPreset: { airport: "BOM", closeStart: 840, duration: 90 },
  };
}

describe("deterministic disruption engine", () => {
  it("propagates an airport closure delay along an aircraft rotation", () => {
    const result = simulateNetwork(testNetwork(), { airport: "BOM", closeStart: 800, closeEnd: 870 });
    const first = result.flights.find((flight) => flight.id === "F1");
    const second = result.flights.find((flight) => flight.id === "F2");
    const third = result.flights.find((flight) => flight.id === "F3");
    expect(first?.delayMinutes).toBe(0);
    expect(second?.delayMinutes).toBe(45);
    expect(third?.delayMinutes).toBe(45);
    expect(third?.reasonChain.join(" ")).toContain("prior leg");
  });

  it("counts a transfer as stranded when the inbound misses minimum connection time", () => {
    const network = testNetwork();
    network.flights[1].aircraftId = "A2";
    network.aircraft.push({ id: "A2", label: "Aircraft 2", base: "DEL", turnaroundMinutes: 45 });
    network.flights[2].aircraftId = "A3";
    network.aircraft.push({ id: "A3", label: "Aircraft 3", base: "BOM", turnaroundMinutes: 45 });
    network.connections = [{ id: "X2", inboundFlightId: "F2", outboundFlightId: "F3", passengers: 30, minConnectMinutes: 45 }];
    const result = simulateNetwork(network, { airport: "BOM", closeStart: 800, closeEnd: 870 });
    expect(result.connections[0].broken).toBe(true);
    expect(result.metrics.strandedPassengers).toBe(30);
  });

  it("flags a crew once its accumulated duty exceeds the legal limit", () => {
    const network = testNetwork();
    network.crews[0].maxDutyMinutes = 180;
    const result = simulateNetwork(network, { airport: "BOM", closeStart: 0, closeEnd: 1 });
    expect(result.flights.at(-1)?.crewViolation).toBe(true);
    expect(result.metrics.crewViolations).toBe(1);
  });
});
