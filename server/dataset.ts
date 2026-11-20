import raw from "./data/network.json";
import type { Airport, Flight, NetworkData } from "../shared/types";

interface ChainSeed {
  aircraftId: string;
  crewId: string;
  startAt: string;
  path: string[];
}

interface RawNetwork {
  demoPreset: NetworkData["demoPreset"];
  airports: Airport[];
  aircraft: NetworkData["aircraft"];
  spares: NetworkData["spares"];
  crews: NetworkData["crews"];
  chains: ChainSeed[];
  connections: NetworkData["connections"];
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function distanceKm(origin: Airport, destination: Airport): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat1 = radians(origin.lat);
  const lat2 = radians(destination.lat);
  const deltaLat = radians(destination.lat - origin.lat);
  const deltaLng = radians(destination.lng - origin.lng);
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function blockMinutes(origin: Airport, destination: Airport): number {
  return Math.max(50, Math.ceil(distanceKm(origin, destination) / 760 * 60 + 30));
}

function buildNetwork(seed: RawNetwork): NetworkData {
  const airports = new Map(seed.airports.map((airport) => [airport.code, airport]));
  const flights: Flight[] = [];
  let flightNumber = 1;

  for (const chain of seed.chains) {
    let departure = toMinutes(chain.startAt);
    for (let index = 0; index < chain.path.length - 1; index += 1) {
      const originCode = chain.path[index];
      const destinationCode = chain.path[index + 1];
      const origin = airports.get(originCode);
      const destination = airports.get(destinationCode);
      if (!origin || !destination) {
        throw new Error(`Unknown airport in flight chain: ${originCode} -> ${destinationCode}`);
      }

      flights.push({
        id: `F${String(flightNumber).padStart(3, "0")}`,
        callsign: `DS${String(100 + flightNumber)}`,
        origin: originCode,
        destination: destinationCode,
        scheduledDeparture: departure,
        blockMinutes: blockMinutes(origin, destination),
        aircraftId: chain.aircraftId,
        crewId: chain.crewId,
        passengers: 95 + (flightNumber * 47 % 115),
      });
      departure += flights[flights.length - 1].blockMinutes + 55;
      flightNumber += 1;
    }
  }

  return {
    airports: seed.airports,
    flights,
    aircraft: seed.aircraft,
    crews: seed.crews,
    connections: seed.connections,
    spares: seed.spares,
    demoPreset: seed.demoPreset,
  };
}

export const network = buildNetwork(raw as RawNetwork);
