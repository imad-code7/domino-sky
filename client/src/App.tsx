import { AnimatePresence, motion } from "framer-motion";
import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip } from "react-leaflet";
import type {
  Airport,
  FlightResult,
  Metrics,
  NetworkData,
  RecoveryAction,
  RecoveryCandidate,
  SimulationResult,
} from "../../shared/types";
import { getNetwork, recover, simulate, streamExplanation } from "./api";

const fmtTime = (minutes: number) => {
  const time = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`;
};
const fmtNumber = (value: number) => value.toLocaleString("en-IN");

function Counter({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValue = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const from = previousValue.current;
    previousValue.current = value;
    const duration = 650;
    let frame = 0;
    const animateCount = (time: number) => {
      const progress = Math.min(1, (time - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setDisplayValue(Math.round(from + (value - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(animateCount);
    };
    frame = requestAnimationFrame(animateCount);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <motion.span>{displayValue.toLocaleString("en-IN")}</motion.span>;
}

function airportIcon(code: string, closed: boolean, selected: boolean) {
  return L.divIcon({
    className: "",
    html: `<span class="airport-pin ${closed ? "airport-pin-closed" : ""} ${selected ? "airport-pin-selected" : ""}"><i></i><b>${code}</b></span>`,
    iconSize: [42, 42],
    iconAnchor: [21, 21],
  });
}

function planeIcon(delayed: boolean) {
  return L.divIcon({
    className: "",
    html: `<span class="plane-marker ${delayed ? "plane-marker-delayed" : ""}">✈</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function curve(from: Airport, to: Airport): [number, number][] {
  const dx = to.lng - from.lng;
  const dy = to.lat - from.lat;
  const bend = Math.min(3.2, Math.max(0.7, Math.hypot(dx, dy) * 0.1));
  const midX = (from.lng + to.lng) / 2 + Math.sign(dy || 1) * bend;
  const midY = (from.lat + to.lat) / 2 - Math.sign(dx || 1) * bend * 0.28;
  return Array.from({ length: 11 }, (_, i) => {
    const t = i / 10;
    const inverse = 1 - t;
    const lng = inverse * inverse * from.lng + 2 * inverse * t * midX + t * t * to.lng;
    const lat = inverse * inverse * from.lat + 2 * inverse * t * midY + t * t * to.lat;
    return [lat, lng];
  });
}

function interpolate(from: Airport, to: Airport, progress: number): [number, number] {
  const arc = curve(from, to);
  return arc[Math.min(arc.length - 1, Math.max(0, Math.round(progress * (arc.length - 1))))];
}

function MapView({
  network,
  result,
  selectedAirport,
  currentTime,
  onAirportSelect,
  playing,
}: {
  network: NetworkData;
  result: SimulationResult | null;
  selectedAirport: string;
  currentTime: number;
  onAirportSelect: (code: string) => void;
  playing: boolean;
}) {
  const airportByCode = useMemo(() => new Map(network.airports.map((airport) => [airport.code, airport])), [network.airports]);
  const routes = useMemo(() => {
    if (!result) return [];
    const byRoute = new Map<string, FlightResult[]>();
    for (const flight of result.flights) {
      const key = `${flight.origin}-${flight.destination}`;
      const group = byRoute.get(key) ?? [];
      group.push(flight);
      byRoute.set(key, group);
    }
    return [...byRoute.values()].map((flights) => {
      const visible = flights.filter((flight) => flight.status === "cancelled"
        ? currentTime >= flight.scheduledDeparture
        : currentTime >= flight.actualDeparture);
      const representative = (visible.length ? visible : flights).reduce(
        (best, flight) => flight.delayMinutes > best.delayMinutes ? flight : best,
        (visible.length ? visible : flights)[0],
      );
      return {
        representative,
        allCancelled: visible.length > 0 && visible.every((flight) => flight.status === "cancelled"),
        hasDeparted: visible.length > 0,
      };
    });
  }, [currentTime, result]);
  const active = result?.flights.filter((flight) =>
    flight.status !== "cancelled"
    && currentTime >= flight.actualDeparture
    && currentTime <= flight.actualArrival,
  ) ?? [];
  const ripples = result?.flights.filter((flight) =>
    flight.delayMinutes > 0 && currentTime >= flight.actualDeparture && currentTime - flight.actualDeparture < 25,
  ) ?? [];

  return (
    <div className="map-frame">
      <MapContainer center={[21.2, 79.4]} zoom={4.5} minZoom={4} maxZoom={7} scrollWheelZoom className="network-map">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {routes.map(({ representative, allCancelled, hasDeparted }) => {
          const from = airportByCode.get(representative.origin);
          const to = airportByCode.get(representative.destination);
          if (!from || !to) return null;
          const color = allCancelled ? "#728092" : !hasDeparted ? "#38d5c3" : representative.delayMinutes >= 45 ? "#ff5869" : representative.delayMinutes > 0 ? "#f8b44a" : "#38d5c3";
          return (
            <Polyline
              key={`${representative.origin}-${representative.destination}`}
              positions={curve(from, to)}
              pathOptions={{
                color,
                opacity: allCancelled ? 0.36 : 0.74,
                weight: Math.min(4, 1.4 + representative.delayMinutes / 35),
                dashArray: allCancelled ? "7 9" : undefined,
              }}
            >
              <Tooltip sticky>{representative.origin} → {representative.destination} · {representative.delayMinutes ? `+${representative.delayMinutes} min` : "on time"}</Tooltip>
            </Polyline>
          );
        })}
        {network.airports.map((airport) => (
          <Marker
            key={airport.code}
            position={[airport.lat, airport.lng]}
            icon={airportIcon(airport.code, result?.closure.airport === airport.code, selectedAirport === airport.code)}
            eventHandlers={{ click: () => onAirportSelect(airport.code) }}
          >
            <Tooltip direction="top" offset={[0, -13]}>{airport.city} · {airport.code}</Tooltip>
          </Marker>
        ))}
        {active.map((flight) => {
          const origin = airportByCode.get(flight.origin);
          const destination = airportByCode.get(flight.destination);
          if (!origin || !destination) return null;
          const progress = (currentTime - flight.actualDeparture) / Math.max(1, flight.actualArrival - flight.actualDeparture);
          return (
            <Marker key={`plane-${flight.id}`} position={interpolate(origin, destination, progress)} icon={planeIcon(flight.delayMinutes > 0)} interactive={false} />
          );
        })}
        {ripples.map((flight) => {
          const origin = airportByCode.get(flight.origin);
          if (!origin) return null;
          return (
            <CircleMarker
              key={`ripple-${flight.id}`}
              center={[origin.lat, origin.lng]}
              radius={playing ? 15 : 9}
              pathOptions={{ color: flight.delayMinutes >= 45 ? "#ff5869" : "#f8b44a", fillOpacity: 0.02, opacity: 0.55, weight: 1.5 }}
            />
          );
        })}
        {result && (
          <CircleMarker
            center={airportByCode.get(result.closure.airport) ? [airportByCode.get(result.closure.airport)!.lat, airportByCode.get(result.closure.airport)!.lng] : [19.08, 72.87]}
            radius={playing ? 25 : 16}
            pathOptions={{ color: "#ff5869", fillColor: "#ff5869", fillOpacity: 0.07, opacity: 0.5, weight: 1.5 }}
          />
        )}
      </MapContainer>
      <div className="map-status glass">
        <span className="live-dot" />
        <span>{result ? `${result.flights.length} flight legs · ${result.closure.airport} disruption` : "Awaiting network"}</span>
        <span className="status-divider" />
        <span className="mono">{fmtTime(currentTime)} IST</span>
      </div>
      <div className="map-legend glass">
        <span><i className="legend-dot green" /> On time</span>
        <span><i className="legend-dot amber" /> Delayed</span>
        <span><i className="legend-dot red" /> 45+ min</span>
        <span><i className="legend-line dashed" /> Cancelled</span>
      </div>
    </div>
  );
}

function MetricCard({ label, value, unit, tone, icon }: { label: string; value: number; unit?: string; tone: string; icon: string }) {
  return (
    <motion.div className={`metric-card metric-${tone}`} layout>
      <div className="metric-top">
        <span className="metric-icon">{icon}</span>
        <span className="metric-value"><Counter value={value} />{unit && <small>{unit}</small>}</span>
      </div>
      <div className="metric-label">{label}</div>
    </motion.div>
  );
}

function formatDelta(before: number, after: number) {
  const diff = before - after;
  return diff > 0 ? `−${fmtNumber(diff)}` : diff < 0 ? `+${fmtNumber(Math.abs(diff))}` : "—";
}

function App() {
  const [network, setNetwork] = useState<NetworkData | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>([]);
  const [selectedAirport, setSelectedAirport] = useState("");
  const [closeStart, setCloseStart] = useState(0);
  const [duration, setDuration] = useState(90);
  const [currentTime, setCurrentTime] = useState(6 * 60);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(true);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState<"time" | "delay">("time");
  const [selectedFlight, setSelectedFlight] = useState<string | null>(null);
  const [explanation, setExplanation] = useState("");
  const [explanationSource, setExplanationSource] = useState<"ai" | "offline" | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [comparison, setComparison] = useState<{ before: Metrics; after: Metrics } | null>(null);

  const runScenario = async (actions: RecoveryAction[] = [], closure = {
    airport: selectedAirport,
    closeStart,
    closeEnd: closeStart + duration,
  }) => {
    setLoading(true);
    setError("");
    setCandidates([]);
    setExplanation("");
    setExplanationSource(null);
    try {
      const next = await simulate({ ...closure, actions });
      setResult(next);
      setCurrentTime(Math.min(next.closure.closeStart, 6 * 60));
      setComparison(actions.length && result ? { before: result.metrics, after: next.metrics } : null);
      if (!actions.length) setComparison(null);
      if (network) {
        setRecovering(true);
        const options = await recover(next.scenarioId);
        setCandidates(options);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The simulation could not be completed.");
    } finally {
      setLoading(false);
      setRecovering(false);
    }
  };

  useEffect(() => {
    let active = true;
    getNetwork().then((data) => {
      if (!active) return;
      setNetwork(data);
      setSelectedAirport(data.demoPreset.airport);
      setCloseStart(data.demoPreset.closeStart);
      setDuration(data.demoPreset.duration);
    }).catch((caught: unknown) => {
      if (active) {
        setError(caught instanceof Error ? caught.message : "Could not load the network.");
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (network && !result) {
      const preset = network.demoPreset;
      void runScenario([], {
        airport: preset.airport,
        closeStart: preset.closeStart,
        closeEnd: preset.closeStart + preset.duration,
      });
    }
  }, [network, result]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setCurrentTime((time) => {
        if (time >= 1439) {
          setPlaying(false);
          return 1439;
        }
        return Math.min(1439, time + 5 * speed);
      });
    }, 350);
    return () => window.clearInterval(timer);
  }, [playing, speed]);

  const visibleFlights = useMemo(() => {
    if (!result) return [];
    return [...result.flights]
      .filter((flight) => filter === "all" || flight.status === filter)
      .sort((a, b) => sortBy === "delay"
        ? b.delayMinutes - a.delayMinutes || a.scheduledDeparture - b.scheduledDeparture
        : a.scheduledDeparture - b.scheduledDeparture);
  }, [filter, result, sortBy]);

  const selectedFlightData = result?.flights.find((flight) => flight.id === selectedFlight);
  const airport = network?.airports.find((item) => item.code === selectedAirport);
  const maxPlaybackTime = Math.max(1439, ...(result?.flights.map((flight) => flight.actualArrival) ?? []));

  const runRecovery = (candidate: RecoveryCandidate) => {
    const action = candidate.action;
    if (!result) return;
    const closure = result.closure;
    setSelectedAirport(closure.airport);
    setCloseStart(closure.closeStart);
    setDuration(closure.closeEnd - closure.closeStart);
    setSelectedFlight(action.type === "hold_connection"
      ? network?.connections.find((item) => item.id === action.connectionId)?.outboundFlightId ?? null
      : action.flightId);
    void runScenario(
      [...result.appliedActions, action],
      { airport: closure.airport, closeStart: closure.closeStart, closeEnd: closure.closeEnd },
    );
  };

  const getExplanation = async () => {
    if (!result) return;
    setExplanation("");
    setExplanationSource(null);
    setExplaining(true);
    try {
      await streamExplanation(result.scenarioId, (chunk) => setExplanation((text) => text + chunk), setExplanationSource);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The dispatcher explanation failed.");
    } finally {
      setExplaining(false);
    }
  };

  const reset = () => {
    const preset = network?.demoPreset;
    if (!preset) return;
    setSelectedAirport(preset.airport);
    setCloseStart(preset.closeStart);
    setDuration(preset.duration);
    setCurrentTime(6 * 60);
    setPlaying(false);
    setSelectedFlight(null);
    setComparison(null);
    void runScenario([], { airport: preset.airport, closeStart: preset.closeStart, closeEnd: preset.closeStart + preset.duration });
  };

  const chooseAirport = (code: string) => setSelectedAirport(code);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Domino Sky home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span className="brand-name">DOMINO<span>SKY</span></span>
        </a>
        <div className="header-center">
          <span className="eyebrow">NETWORK CONTROL</span>
          <span className="header-date">MONSOON OPERATIONS <b>·</b> INDIA</span>
        </div>
        <div className="header-right">
          <span className="environment-badge"><i /> DEMO SCENARIO</span>
          <button className="reset-button" type="button" onClick={reset} disabled={loading}><span>↺</span> Reset</button>
        </div>
      </header>

      <main>
        <section className="workspace">
          <div className="map-column">
            {network ? (
              <MapView
                network={network}
                result={result}
                selectedAirport={selectedAirport}
                currentTime={currentTime}
                onAirportSelect={chooseAirport}
                playing={playing}
              />
            ) : (
              <div className="map-loading"><span className="spinner" /><p>Loading network data…</p></div>
            )}
            <div className="timeline glass">
              <div className="timeline-head">
                <div className="timeline-title"><span className="play-indicator" /> NETWORK PLAYBACK <small>IST · 24H</small></div>
                <div className="timeline-controls">
                  <button type="button" className="icon-button" aria-label={playing ? "Pause playback" : "Play playback"} onClick={() => setPlaying((value) => !value)}>{playing ? "Ⅱ" : "▶"}</button>
                  <button type="button" className="speed-button" onClick={() => setSpeed((value) => value === 1 ? 2 : value === 2 ? 4 : 1)}>{speed}×</button>
                  <span className="timeline-clock">{fmtTime(currentTime)}</span>
                </div>
              </div>
              <input
                aria-label="Playback timeline"
                className="timeline-range"
                type="range"
                min={0}
                max={maxPlaybackTime}
                step={5}
                value={currentTime}
                onChange={(event) => setCurrentTime(Number(event.target.value))}
              />
              <div className="timeline-ticks"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
            </div>
            <AnimatePresence>
              {selectedFlightData && (
                <motion.div className="flight-drawer glass" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }}>
                  <button className="drawer-close" aria-label="Close flight details" type="button" onClick={() => setSelectedFlight(null)}>×</button>
                  <span className="eyebrow">DOMINO TRACE</span>
                  <h3>{selectedFlightData.callsign} <span>{selectedFlightData.origin} → {selectedFlightData.destination}</span></h3>
                  {selectedFlightData.reasonChain.length ? (
                    <ol className="reason-chain">
                      {selectedFlightData.reasonChain.map((reason, index) => <li key={`${reason}-${index}`}><i />{reason}</li>)}
                    </ol>
                  ) : <p className="muted-copy">No upstream delay. This leg is operating to schedule.</p>}
                  <div className="drawer-meta">{selectedFlightData.assignedAircraftId} <b>·</b> {selectedFlightData.assignedCrewId} <b>·</b> {selectedFlightData.passengers} pax</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <aside className="control-panel">
            <div className="panel-heading">
              <div><span className="eyebrow">DISRUPTION LAB</span><h1>Close an airport</h1></div>
              <span className="panel-counter">01 <i>/ 04</i></span>
            </div>
            <label className="field-label" htmlFor="airport-select">Affected airport</label>
            <div className="airport-select-wrap">
              <span className="field-code">{selectedAirport}</span>
              <select id="airport-select" value={selectedAirport} onChange={(event) => setSelectedAirport(event.target.value)} disabled={!network}>
                {network?.airports.map((item) => <option key={item.code} value={item.code}>{item.city} · {item.code}</option>)}
              </select>
              <span className="select-chevron">⌄</span>
            </div>
            <div className="airport-info">{airport?.name ?? "Airport selected on network map"}</div>
            <div className="range-field">
              <div className="range-label"><label htmlFor="close-start">Closure start</label><strong>{fmtTime(closeStart)} <small>IST</small></strong></div>
              <input id="close-start" type="range" min={0} max={1439} step={15} value={closeStart} onChange={(event) => setCloseStart(Number(event.target.value))} />
              <div className="range-bounds"><span>00:00</span><span>24:00</span></div>
            </div>
            <div className="range-field duration-field">
              <div className="range-label"><label htmlFor="closure-duration">Closure duration</label><strong>{duration}<small> min</small></strong></div>
              <input id="closure-duration" type="range" min={30} max={240} step={15} value={duration} onChange={(event) => setDuration(Number(event.target.value))} />
              <div className="range-bounds"><span>30 min</span><span>4 hours</span></div>
            </div>
            <button className="simulate-button" type="button" disabled={loading || !network} onClick={() => void runScenario()}>
              {loading ? <><span className="button-spinner" /> Calculating cascade</> : <><span>Run simulation</span><b>↗</b></>}
            </button>
            <button className="preset-button" type="button" disabled={loading} onClick={() => {
              const preset = network?.demoPreset;
              if (!preset) return;
              setSelectedAirport(preset.airport);
              setCloseStart(preset.closeStart);
              setDuration(preset.duration);
              void runScenario([], { airport: preset.airport, closeStart: preset.closeStart, closeEnd: preset.closeStart + preset.duration });
            }}>
              <span>⛈</span><span><b>Mumbai monsoon preset</b><small>90-minute closure · BOM</small></span><i>Use scenario</i>
            </button>

            <div className="panel-rule" />
            <div className="section-title"><span>NETWORK IMPACT</span><span className="live-tag"><i /> LIVE MODEL</span></div>
            {loading && !result ? (
              <div className="metric-grid">
                {[1, 2, 3, 4].map((item) => <div key={item} className="metric-skeleton" />)}
              </div>
            ) : (
              <div className="metric-grid">
                <MetricCard label="Delayed flights" value={result?.metrics.delayedFlights ?? 0} tone="amber" icon="◷" />
                <MetricCard label="Total delay" value={result?.metrics.totalDelayMinutes ?? 0} unit="min" tone="cyan" icon="↗" />
                <MetricCard label="Stranded pax" value={result?.metrics.strandedPassengers ?? 0} tone="red" icon="⌁" />
                <MetricCard label="Crew violations" value={result?.metrics.crewViolations ?? 0} tone="violet" icon="◈" />
              </div>
            )}

            {comparison && (
              <div className="comparison-card">
                <div className="comparison-title"><span>RECOVERY RESULT</span><button type="button" onClick={() => setComparison(null)} aria-label="Close recovery result">×</button></div>
                <div className="compare-row"><span>Delay minutes</span><b>{fmtNumber(comparison.before.totalDelayMinutes)} <i>→</i> {fmtNumber(comparison.after.totalDelayMinutes)}</b><em>{formatDelta(comparison.before.totalDelayMinutes, comparison.after.totalDelayMinutes)}</em></div>
                <div className="compare-row"><span>Stranded pax</span><b>{fmtNumber(comparison.before.strandedPassengers)} <i>→</i> {fmtNumber(comparison.after.strandedPassengers)}</b><em>{formatDelta(comparison.before.strandedPassengers, comparison.after.strandedPassengers)}</em></div>
                <div className="compare-row"><span>Delayed flights</span><b>{comparison.before.delayedFlights} <i>→</i> {comparison.after.delayedFlights}</b><em>{formatDelta(comparison.before.delayedFlights, comparison.after.delayedFlights)}</em></div>
                <div className="compare-row"><span>Cancelled flights</span><b>{comparison.before.cancelledFlights} <i>→</i> {comparison.after.cancelledFlights}</b><em>{formatDelta(comparison.before.cancelledFlights, comparison.after.cancelledFlights)}</em></div>
                <div className="compare-row"><span>Crew violations</span><b>{comparison.before.crewViolations} <i>→</i> {comparison.after.crewViolations}</b><em>{formatDelta(comparison.before.crewViolations, comparison.after.crewViolations)}</em></div>
              </div>
            )}

            <div className="recovery-heading">
              <div className="section-title"><span>DISPATCHER OPTIONS</span><span className="ai-chip">AI</span></div>
              <p>Engine-tested recovery actions, ranked by network impact.</p>
            </div>
            <div className="recovery-list">
              {recovering ? <div className="recovery-loading"><span className="spinner" /> Evaluating recovery options…</div>
                : candidates.length ? candidates.map((candidate, index) => (
                  <motion.article key={candidate.id} className="recovery-card" initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.04 }}>
                    <div className="recovery-card-top"><span className="rank">0{index + 1}</span><span className="recovery-kind">{candidate.action.type.replaceAll("_", " ")}</span></div>
                    <h3>{candidate.title}</h3>
                    <p>{candidate.rationale}</p>
                    <div className="recovery-impact">
                      <span>Delay <b>{formatDelta(candidate.before.totalDelayMinutes, candidate.after.totalDelayMinutes)} min</b></span>
                      <span>Stranded <b>{formatDelta(candidate.before.strandedPassengers, candidate.after.strandedPassengers)}</b></span>
                      <span>Delayed <b>{formatDelta(candidate.before.delayedFlights, candidate.after.delayedFlights)}</b></span>
                      <span>Cancelled <b>{formatDelta(candidate.before.cancelledFlights, candidate.after.cancelledFlights)}</b></span>
                      <span>Crew <b>{formatDelta(candidate.before.crewViolations, candidate.after.crewViolations)}</b></span>
                    </div>
                    <button className="apply-button" type="button" onClick={() => runRecovery(candidate)} disabled={loading}>Apply action <span>→</span></button>
                  </motion.article>
                )) : <div className="empty-recovery">Run a simulation to calculate recovery options.</div>}
            </div>

            <div className="dispatcher-box">
              <div className="dispatcher-head"><span className="dispatcher-avatar">✳</span><div><b>AI DISPATCHER</b><small>{explaining ? "Composing from engine results…" : explanationSource === "ai" ? "Connected · validated" : "Offline-ready · engine verified"}</small></div><i className="dispatcher-live" /></div>
              {explanation ? <p className="dispatcher-text">{explanation}{explaining && <span className="typing-caret" />}</p>
                : <p className="dispatcher-placeholder">Ask the dispatcher to explain the cascade and rank the tested recovery actions.</p>}
              <button type="button" className="explain-button" onClick={() => void getExplanation()} disabled={!result || explaining || loading}>
                {explaining ? "Generating explanation…" : "Explain this scenario"} <span>↗</span>
              </button>
            </div>
            <div className="panel-footnote">All operational metrics are calculated by the deterministic engine.<br />AI receives computed results only.</div>
          </aside>
        </section>

        <section className="flight-section">
          <div className="flight-section-head">
            <div><span className="eyebrow">OPERATIONS FEED</span><h2>Flight ledger <small>{result ? `${result.flights.length} legs` : ""}</small></h2></div>
            <div className="table-actions">
              <div className="filter-tabs" role="group" aria-label="Filter flights">
                {["all", "delayed", "cancelled", "on-time"].map((item) => <button key={item} type="button" className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item.replace("-", " ")}</button>)}
              </div>
              <button type="button" className="sort-button" onClick={() => setSortBy((value) => value === "time" ? "delay" : "time")}>Sort: {sortBy === "time" ? "departure" : "delay"} <span>↕</span></button>
            </div>
          </div>
          <div className="flight-table-wrap">
            <table className="flight-table">
              <thead><tr><th>Flight</th><th>Route</th><th>STD / ATD · IST</th><th>Aircraft</th><th>Passengers</th><th>Delay</th><th>Status</th><th /></tr></thead>
              <tbody>
                {visibleFlights.map((flight) => (
                  <tr
                    key={flight.id}
                    className={selectedFlight === flight.id ? "row-selected" : ""}
                    tabIndex={0}
                    aria-label={`${flight.callsign}, ${flight.origin} to ${flight.destination}, ${flight.status}`}
                    onClick={() => setSelectedFlight(flight.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedFlight(flight.id);
                      }
                    }}
                  >
                    <td><b className="flight-number">{flight.callsign}</b><small>{flight.id}</small></td>
                    <td><span className="route-text">{flight.origin}<i>→</i>{flight.destination}</span></td>
                    <td><span className="time-pair">{fmtTime(flight.scheduledDeparture)}<i>{fmtTime(flight.actualDeparture)}</i></span></td>
                    <td className="muted-cell">{flight.assignedAircraftId}</td>
                    <td className="muted-cell">{flight.passengers}</td>
                    <td className={flight.delayMinutes >= 45 ? "delay-high" : flight.delayMinutes > 0 ? "delay-medium" : "delay-none"}>{flight.status === "cancelled" ? "—" : flight.delayMinutes ? `+${flight.delayMinutes}m` : "—"}</td>
                    <td><span className={`status-pill status-${flight.status}`}>{flight.status === "on-time" ? "ON TIME" : flight.status.toUpperCase()}</span></td>
                    <td><button className="why-button" type="button" onClick={(event) => { event.stopPropagation(); setSelectedFlight(flight.id); }}>Why? <span>↗</span></button></td>
                  </tr>
                ))}
                {!visibleFlights.length && <tr><td className="no-rows" colSpan={8}>No flights match this filter.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </main>
      <footer className="page-footer"><span>DOMINO SKY <b>·</b> DISRUPTION SIMULATOR</span><span>Schedule and crew values are illustrative demo data. Airport identities and coordinates: <a href="https://github.com/datasets/airport-codes" target="_blank" rel="noreferrer">public airport-codes dataset</a>.</span><span>IST UTC+05:30</span></footer>
      <AnimatePresence>
        {error && <motion.div className="error-toast" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} role="alert">
          <span>!</span><p>{error}</p><button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button>
        </motion.div>}
      </AnimatePresence>
    </div>
  );
}

export default App;
