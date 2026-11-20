import uploaded from "../flight_network.json";
import type { Airport, Flight, NetworkData } from "../shared/types";

interface UploadedAirport {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
}

interface UploadedFlight {
  flight_id: string;
  tail_id: string;
  origin: string;
  destination: string;
  dep: string;
  block_minutes: number;
  pax: number;
  turnaround_before_min: number | null;
}

interface UploadedCrew {
  crew_id: string;
  tail_id: string;
  base: string;
  duty_start: string;
  max_duty_mins: number;
}

interface UploadedSpare {
  tail_id: string;
  base: string;
  seats: number;
}

interface UploadedConnection {
  connection_id: string;
  from_flight: string;
  to_flight: string;
  passengers: number;
  min_connect_minutes: number;
}

interface UploadedNetwork {
  meta: {
    min_turnaround_minutes: number;
  };
  airports: UploadedAirport[];
  flights: UploadedFlight[];
  crews: UploadedCrew[];
  spare_aircraft: UploadedSpare[];
  connections: UploadedConnection[];
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function buildUploadedNetwork(seed: UploadedNetwork): NetworkData {
  const airports: Airport[] = seed.airports.map((airport) => ({
    code: airport.id,
    name: airport.name,
    city: airport.city,
    lat: airport.lat,
    lng: airport.lng,
  }));

  const crewByTail = new Map(seed.crews.map((crew) => [crew.tail_id, crew]));
  const aircraft = [...new Set(seed.flights.map((flight) => flight.tail_id))].map((tailId) => {
    const crew = crewByTail.get(tailId);
    return {
      id: tailId,
      label: tailId,
      base: crew?.base ?? seed.flights.find((flight) => flight.tail_id === tailId)?.origin ?? "",
      turnaroundMinutes: seed.meta.min_turnaround_minutes,
    };
  });

  const crews = seed.crews.map((crew) => ({
    id: crew.crew_id,
    label: crew.crew_id,
    maxDutyMinutes: crew.max_duty_mins,
    reportMinutes: 45,
    reserve: false,
    base: crew.base,
    dutyStartMinutes: toMinutes(crew.duty_start),
  }));

  const spares = seed.spare_aircraft.map((spare, index) => ({
    id: `S${String(index + 1).padStart(2, "0")}`,
    label: `${spare.tail_id} reserve`,
    base: spare.base,
    turnaroundMinutes: seed.meta.min_turnaround_minutes,
  }));

  seed.spare_aircraft.forEach((spare, index) => {
    crews.push({
      id: `RC${index + 1}`,
      label: `Reserve crew ${index + 1}`,
      maxDutyMinutes: 600,
      reportMinutes: 45,
      reserve: true,
      base: spare.base,
      dutyStartMinutes: 300,
    });
  });

  const crewIdByTail = new Map(seed.crews.map((crew) => [crew.tail_id, crew.crew_id]));
  const flights: Flight[] = seed.flights.map((flight) => ({
    id: flight.flight_id,
    callsign: flight.flight_id,
    origin: flight.origin,
    destination: flight.destination,
    scheduledDeparture: toMinutes(flight.dep),
    blockMinutes: flight.block_minutes,
    aircraftId: flight.tail_id,
    crewId: crewIdByTail.get(flight.tail_id) ?? `CR-${flight.tail_id}`,
    passengers: flight.pax,
    turnaroundBeforeMin: flight.turnaround_before_min ?? undefined,
  }));

  return {
    airports,
    flights,
    aircraft,
    crews,
    connections: seed.connections.map((connection) => ({
      id: connection.connection_id,
      inboundFlightId: connection.from_flight,
      outboundFlightId: connection.to_flight,
      passengers: connection.passengers,
      minConnectMinutes: connection.min_connect_minutes,
    })),
    spares,
    demoPreset: { airport: "BOM", closeStart: 840, duration: 90 },
  };
}

export const network = buildUploadedNetwork(uploaded as UploadedNetwork);
