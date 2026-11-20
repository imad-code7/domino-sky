# Domino Sky

Domino Sky is a full-stack, deterministic airline-disruption simulator. The API owns all schedule, delay, connection, passenger, crew-duty, and recovery calculations. The browser only renders the returned results.

## Important dataset note

No organiser dataset or existing project was present in the supplied workspace. This project therefore includes an **illustrative demo dataset**, not an operational airline timetable and not the organisers' data. Airport codes, names, and coordinates are based on the public [airport-codes dataset](https://github.com/datasets/airport-codes). Flight rotations, times, passenger loads, connections, crew rosters, and reserve assignments are demonstrator assumptions and are marked as such in the interface.

The demo network has 16 airports, 70 generated flight legs, 16 active aircraft, 16 active crews, 2 reserve aircraft, 2 reserve crews, and 16 passenger connections. `server/data/network.json` is the single source for the demo network. It stores airport reference records, aircraft/crew resources, flight rotation paths, connection records, reserve bases, and the 90-minute Mumbai preset. The server loads it at startup and deterministically derives each flight's block time and passenger count.

### Assumptions made for fields absent from the source

| Field | Demo assumption |
|---|---|
| Scheduled times | Each rotation starts at its declared `startAt`. A leg's block time is great-circle distance at 760 km/h plus 30 minutes, with a 50-minute minimum; legs in a rotation are separated by 55 minutes. All times are IST. |
| Passengers | Illustrative per-flight loads are generated deterministically from the flight sequence. Connection passenger counts are separately listed in the JSON. |
| Connections | The demo lists 16 transfer links with a 35-minute minimum connect time. They are illustrative, not sourced airline bookings. |
| Aircraft turnaround | Rotation aircraft specify a 45- or 50-minute minimum. |
| Crew limits | Each demo crew has a 720-minute duty limit, 45-minute report buffer, and 30-minute between-leg readiness buffer. Reserve crews start at BOM and HYD. These values are assumptions, not a legal-compliance determination. |
| Cancellation positioning | A cancelled service is removed from passenger operations; the rotation is assumed to reposition on its scheduled block for subsequent legs. The simulator does not model deadhead capacity, aircraft maintenance, curfews, weather recovery outside the chosen airport closure, or airline-specific crew regulations. |
| Recovery ranking | Candidates are evaluated by the same simulator and ranked using a transparent weighted score: delay minutes + 45 × delayed flights + 120 × cancellations + 2 × stranded passengers + 180 × crew violations. The AI does not calculate this score or any metric. |

Replace the illustrative `chains`, `connections`, crew, aircraft, and passenger data in `server/data/network.json` with the organisers' records to use their network. Airport and flight identifiers are validated against that dataset; the simulator does not invent additional airports or flights at runtime.

## Requirements

- Node.js 20+ and npm
- Internet access for OpenStreetMap tiles and Google Fonts. The app darkens the public OSM basemap in the browser; the API and offline dispatcher work without an LLM key.

## Setup and run

```bash
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). The Express API runs on `http://localhost:5174`.

To enable an OpenAI-compatible dispatcher, set `LLM_API_KEY`, and optionally `LLM_BASE_URL` and `LLM_MODEL`, in `.env`. The backend sends the model only structured computed metrics, ranked action types, and before/after results—never the raw schedule or passenger records. It buffers and validates the complete response before streaming it to the browser; unsupported numeric claims are rejected in favor of a deterministic offline explanation.

## Validation

```bash
npm test
npm run build
```

The engine tests cover aircraft delay propagation, broken passenger connections, and crew duty limits. A `GET /api/health` endpoint reports API readiness and loaded flight count.

## API

- `GET /api/network` — airports, derived flights, aircraft, crews, connections, and spare aircraft.
- `POST /api/simulate` — accepts `{ "airport": "BOM", "closeStart": 840, "closeEnd": 930, "actions": [] }`; times are minute offsets from midnight IST.
- `POST /api/recover` — accepts `{ "scenarioId": "..." }`; returns ranked, engine-evaluated actions with exact before/after metrics.
- `POST /api/ai/explain` — accepts `{ "scenarioId": "..." }`; streams validated Server-Sent Events, with an offline fallback.
