export interface Airport {
  code: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
}

export interface Aircraft {
  id: string;
  label: string;
  base: string;
  turnaroundMinutes: number;
}

export interface Crew {
  id: string;
  label: string;
  maxDutyMinutes: number;
  reportMinutes: number;
  reserve: boolean;
  base?: string;
}

export interface Flight {
  id: string;
  callsign: string;
  origin: string;
  destination: string;
  scheduledDeparture: number;
  blockMinutes: number;
  aircraftId: string;
  crewId: string;
  passengers: number;
}

export interface PassengerConnection {
  id: string;
  inboundFlightId: string;
  outboundFlightId: string;
  passengers: number;
  minConnectMinutes: number;
}

export interface NetworkData {
  airports: Airport[];
  flights: Flight[];
  aircraft: Aircraft[];
  crews: Crew[];
  connections: PassengerConnection[];
  spares: Aircraft[];
  demoPreset: { airport: string; closeStart: number; duration: number };
}

export interface Closure {
  airport: string;
  closeStart: number;
  closeEnd: number;
}

export type RecoveryAction =
  | { type: "cancel_flight"; flightId: string }
  | { type: "swap_spare_aircraft"; flightId: string; spareId: string }
  | { type: "swap_crew"; flightId: string; replacementCrewId: string }
  | { type: "hold_connection"; connectionId: string };

export interface FlightResult extends Flight {
  scheduledArrival: number;
  actualDeparture: number;
  actualArrival: number;
  delayMinutes: number;
  status: "on-time" | "delayed" | "cancelled";
  reasonChain: string[];
  crewViolation: boolean;
  assignedAircraftId: string;
  assignedCrewId: string;
}

export interface ConnectionResult extends PassengerConnection {
  broken: boolean;
  strandedPassengers: number;
}

export interface Metrics {
  totalDelayMinutes: number;
  delayedFlights: number;
  cancelledFlights: number;
  strandedPassengers: number;
  crewViolations: number;
}

export interface SimulationResult {
  scenarioId: string;
  closure: Closure;
  flights: FlightResult[];
  connections: ConnectionResult[];
  metrics: Metrics;
  timeline: Array<{ time: number; flightId: string; airport: string; delayMinutes: number }>;
  appliedActions: RecoveryAction[];
}

export interface RecoveryCandidate {
  id: string;
  action: RecoveryAction;
  title: string;
  rationale: string;
  before: Metrics;
  after: Metrics;
}
