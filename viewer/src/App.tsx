import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import stationCodeOnMap from "./assets/station-code-on-map.png";
import { card, color, fullnessColor, mono, sans, seriesColor, tabular } from "./theme";
import {
  computeEmptyStats,
  computeFullStats,
  currentStatus,
  DEFAULT_EMPTY_OPTIONS,
  DEFAULT_FULL_OPTIONS,
  loadConfig,
  loadData,
  parseCodeInput,
  saveStations,
  searchStations,
  spotsKey,
  type ChartRow,
  type Config,
  type CurrentStatus,
  type DataSet,
  type Reading,
  type RateStat,
  type StationMatch,
} from "./data";

const REFRESH_MS = 60_000; // re-read the CSV every minute, no reload needed

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The usual gap between readings, in minutes, taken from the readings rather
// than assumed. Falls back to the collector's own 5 minutes.
function typicalGapMinutes(rows: ChartRow[]): number {
  if (rows.length < 3) return 5;
  const gaps: number[] = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].time - rows[i - 1].time);
  gaps.sort((a, b) => a - b);
  return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / 60_000));
}

// "Last 4 days · one reading every 5 minutes", worked out from the readings
// themselves rather than assumed.
function describeSpan(rows: ChartRow[]): string {
  if (rows.length < 2) return "not enough readings yet to draw a range";
  const hours = (rows[rows.length - 1].time - rows[0].time) / 3_600_000;
  const range =
    hours < 48 ? `Last ${Math.round(hours)} hours` : `Last ${Math.round(hours / 24)} days`;
  const typical = typicalGapMinutes(rows);
  const every =
    typical <= 1 ? "about one reading a minute" : `one reading every ${typical} minutes`;
  return `${range} · ${every}`;
}

interface TooltipEntry {
  name: string;
  dataKey: string;
  value: number;
  color: string;
  payload: ChartRow;
}

// Custom hover box: shows bikes AND open spots for each station at that time.
function PointTooltip(props: {
  active?: boolean;
  label?: number;
  payload?: TooltipEntry[];
  capacity?: Record<string, number | null>;
}) {
  const { active, label, payload, capacity = {} } = props;
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        background: color.card,
        border: `1px solid ${color.borderStrong}`,
        borderRadius: 10,
        padding: "10px 12px",
        fontSize: 12,
        color: color.ink,
        boxShadow: "0 4px 16px rgba(26,24,21,0.10)",
      }}
    >
      <div style={{ fontFamily: mono, fontSize: 11, color: color.faint, marginBottom: 6 }}>
        {fmtTime(Number(label))}
      </div>
      {payload.map((p) => {
        const spots = p.payload[spotsKey(p.dataKey)];
        const total = capacity[p.dataKey];
        return (
          <div key={p.dataKey} style={{ marginTop: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <span
                style={{
                  width: 14,
                  height: 3,
                  borderRadius: 2,
                  background: p.color,
                  flex: "none",
                }}
              />
              <span style={{ color: color.ink2 }}>{p.name}</span>
            </div>
            <div style={{ ...tabular, color: color.muted, paddingLeft: 21 }}>
              <b style={{ color: color.ink }}>{p.value}</b>
              {total ? `/${total}` : ""} bikes · {spots ?? "?"} docks free
            </div>
          </div>
        );
      })}
    </div>
  );
}

// The note behind the "?" in the code field: where the codes come from.
function CodeHelp(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const box = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else, or on Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      ref={box}
      style={{
        position: "absolute",
        zIndex: 20,
        top: "calc(100% + 10px)",
        right: 0,
        width: "min(420px, calc(100vw - 60px))",
        background: color.card,
        border: `1px solid ${color.border}`,
        borderRadius: 14,
        boxShadow: "0 12px 32px rgba(26,24,21,0.14)",
        padding: 18,
        fontSize: 13,
        lineHeight: 1.55,
        color: color.ink2,
        textAlign: "left",
      }}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        className="chip-x"
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          border: "none",
          background: color.chipButton,
          borderRadius: 999,
          width: 22,
          height: 22,
          lineHeight: "20px",
          cursor: "pointer",
          color: color.faint,
        }}
      >
        ×
      </button>

      <p style={{ margin: "0 0 8px", paddingRight: 22 }}>
        Open the map at{" "}
        <a href="https://bluebikes.com/map" target="_blank" rel="noreferrer">
          bluebikes.com/map
        </a>{" "}
        and click a station. The code is the <b>Site ID</b> in the popup, and that is
        what goes in the box.
      </p>
      <p style={{ margin: "0 0 12px" }}>The phone app does not show it, so use the website.</p>
      <img
        src={stationCodeOnMap}
        alt="A station popup on the Bluebikes map, showing 4 bikes, 15 docks, and Site ID M32025"
        style={{
          display: "block",
          maxWidth: "100%",
          maxHeight: 250,
          margin: "0 auto",
          borderRadius: 10,
          border: `1px solid ${color.border}`,
        }}
      />
      <p style={{ margin: "12px 0 0", color: color.faint }}>
        You can add several at once: separate them with commas or spaces. The
        collector picks up changes on its next reading.
      </p>
    </div>
  );
}

const fieldStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 14,
  color: color.ink,
  background: color.bg,
  border: `1px solid ${color.borderStrong}`,
  borderRadius: 10,
  padding: "12px 14px",
  outline: "none",
};

const addButtonStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: color.card,
  background: color.ink,
  border: "none",
  borderRadius: 10,
  padding: "12px 26px",
  cursor: "pointer",
};

function Tab(props: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  const { on, onClick, children } = props;
  return (
    <button
      className={on ? undefined : "tab"}
      onClick={onClick}
      aria-pressed={on}
      style={{
        fontSize: 13,
        fontWeight: on ? 700 : 600,
        color: on ? color.ink : color.faint,
        background: on ? color.card : "transparent",
        border: `1px solid ${on ? color.borderStrong : "transparent"}`,
        borderRadius: 7,
        padding: "7px 14px",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// Search results, in a plain box over the page. Nothing is tracked until you
// press Track on one of the rows.
function SearchResults(props: {
  query: string;
  matches: StationMatch[];
  total: number;
  tracked: string[];
  busy: boolean;
  onTrack: (m: StationMatch) => void;
  onClose: () => void;
}) {
  const { query, matches, total, tracked, busy, onTrack, onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "rgba(26,24,21,0.28)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Search results"
        style={{
          width: "min(520px, 100%)",
          maxHeight: "min(560px, 80vh)",
          display: "flex",
          flexDirection: "column",
          background: color.card,
          border: `1px solid ${color.border}`,
          borderRadius: 16,
          boxShadow: "0 20px 50px rgba(26,24,21,0.22)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "14px 16px",
            borderBottom: `1px solid ${color.border}`,
          }}
        >
          <span style={{ fontSize: 13, color: color.muted }}>
            {total > matches.length
              ? `First ${matches.length} of ${total} stations matching "${query}". Narrow the search to see the rest`
              : `${total} ${total === 1 ? "station matches" : "stations match"} "${query}"`}
          </span>
          <button
            className="chip-x"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 22,
              height: 22,
              borderRadius: "50%",
              border: "none",
              background: color.chipButton,
              color: color.faint,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ overflowY: "auto" }}>
          {matches.map((m) => {
            const already = tracked.includes(m.shortName);
            return (
              <div
                key={m.shortName}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 16px",
                  borderBottom: `1px solid ${color.grid}`,
                  fontSize: 13,
                }}
              >
                <span style={{ fontFamily: mono, fontSize: 12, color: color.accent, flex: "none" }}>
                  {m.shortName}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", color: color.ink2 }}>{m.name}</span>
                  <span style={{ ...tabular, display: "block", fontSize: 12, color: color.faint }}>
                    {[
                      m.region,
                      m.capacity ? `${m.capacity} docks` : null,
                      m.bikes === null ? null : `${m.bikes} ${m.bikes === 1 ? "bike" : "bikes"} now`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {m.lat !== null && m.lon !== null && (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${m.lat},${m.lon}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 12, flex: "none" }}
                    title={`${m.lat}, ${m.lon}`}
                  >
                    map
                  </a>
                )}
                {already ? (
                  <span style={{ fontSize: 12, color: color.faint }}>tracked</span>
                ) : (
                  <button
                    className="btn-add"
                    onClick={() => onTrack(m)}
                    disabled={busy}
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: color.card,
                      background: color.ink,
                      border: "none",
                      borderRadius: 8,
                      padding: "6px 14px",
                      cursor: "pointer",
                    }}
                  >
                    Track
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// The station list: chips for what's tracked, and one field to add more,
// either by code, or by name when you don't know the code.
function StationEditor(props: {
  stations: string[];
  names: Record<string, string>;
  onSave: (stations: string[]) => Promise<void>;
}) {
  const { stations, names, onSave } = props;
  const [mode, setMode] = useState<"code" | "name">("code");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [matches, setMatches] = useState<StationMatch[] | null>(null);
  const [query, setQuery] = useState("");
  const [total, setTotal] = useState(0);

  const commit = async (next: string[], message: string) => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await onSave(next);
      setNote(message);
      setMatches(null);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addByCode = async () => {
    const codes = parseCodeInput(text);
    if (!codes.length) {
      setProblem("Type at least one station code, like S32009.");
      return;
    }
    setText("");
    await commit([...stations, ...codes], `Saved. Now tracking ${codes.join(", ")}.`);
  };

  // Searching by name never adds anything on its own. It opens the results
  // and you pick from them.
  const searchByName = async () => {
    const q = text.trim();
    if (!q) {
      setProblem("Type part of a station name, like Teele Square.");
      return;
    }
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const hits = await searchStations(q);
      if (hits.matches.length === 0) {
        setMatches(null);
        setProblem(`No station name contains "${q}".`);
      } else {
        setQuery(q);
        setMatches(hits.matches);
        setTotal(hits.total);
      }
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => (mode === "code" ? addByCode() : searchByName());

  const switchTo = (next: "code" | "name") => {
    setMode(next);
    setMatches(null);
    setProblem(null);
  };

  return (
    <section style={{ ...card, padding: "24px 26px", display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, letterSpacing: "0.02em" }}>
        Stations to track
      </h2>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {stations.length === 0 && (
          <span style={{ color: color.faint, fontSize: 13 }}>
            None yet. Add one below.
          </span>
        )}
        {stations.map((code) => (
          <span
            key={code}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 10,
              background: color.chip,
              border: `1px solid ${color.chipBorder}`,
              borderRadius: 999,
              padding: "6px 8px 6px 12px",
              fontSize: 13,
            }}
          >
            <span style={{ fontFamily: mono, fontSize: 12, color: color.accent }}>{code}</span>
            {names[code] && <span style={{ color: color.ink2 }}>{names[code]}</span>}
            <button
              className="chip-x"
              onClick={() => commit(stations.filter((c) => c !== code), `Stopped tracking ${code}.`)}
              disabled={busy}
              title={`Stop tracking ${code}`}
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                border: "none",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: color.faint,
                background: color.chipButton,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div
          style={{
            display: "inline-flex",
            background: color.chip,
            border: `1px solid ${color.chipBorder}`,
            borderRadius: 10,
            padding: 3,
            gap: 3,
          }}
        >
          <Tab on={mode === "code"} onClick={() => switchTo("code")}>
            Station code
          </Tab>
          <Tab on={mode === "name"} onClick={() => switchTo("name")}>
            Station name
          </Tab>
        </div>

        <div
          style={{
            flex: "1 1 240px",
            position: "relative",
            display: "flex",
            alignItems: "center",
          }}
        >
          <input
            className="field"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={mode === "code" ? "ex. S32009" : "ex. Teele Square"}
            disabled={busy}
            style={{
              ...fieldStyle,
              fontFamily: mode === "code" ? mono : sans,
              paddingRight: mode === "code" ? 44 : 14,
            }}
          />
          {mode === "code" && (
            <button
              className="qmark"
              onClick={() => setHelpOpen((v) => !v)}
              aria-expanded={helpOpen}
              title="How do I find station codes?"
              style={{
                position: "absolute",
                right: 11,
                width: 22,
                height: 22,
                border: `1px solid ${color.borderStrong}`,
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 700,
                color: color.faint,
                background: color.card,
                cursor: "pointer",
                padding: 0,
              }}
            >
              ?
            </button>
          )}
          <CodeHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        </div>

        <button className="btn-add" onClick={submit} disabled={busy} style={addButtonStyle}>
          {mode === "code" ? "Add" : "Search"}
        </button>
      </div>

      {matches && (
        <SearchResults
          query={query}
          matches={matches}
          total={total}
          tracked={stations}
          busy={busy}
          onTrack={(m) => {
            setText("");
            commit([...stations, m.shortName], `Saved. Now tracking ${m.shortName}, ${m.name}.`);
          }}
          onClose={() => setMatches(null)}
        />
      )}

      {note && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: color.liveText }}>
          <span style={{ width: 5, height: 5, borderRadius: "50%", background: color.live }} />
          {note}
        </div>
      )}
      {problem && <div style={{ fontSize: 13, color: color.warn }}>{problem}</div>}
    </section>
  );
}

// A round badge that fills from the bottom with the share of docks holding a
// bike, coloured the way the Bluebikes map colours its pins.
function DockFill(props: { bikes: number; capacity: number | null; label: string }) {
  const { bikes, capacity, label } = props;
  const frac = capacity ? Math.min(1, Math.max(0, bikes / capacity)) : 0;
  const fill = fullnessColor(frac);
  const D = 40; // circle box, in SVG units
  const r = D / 2 - 2; // leaves room for the ring
  const top = 2 + (D - 4) * (1 - frac); // waterline
  const id = label.replace(/\W/g, "").slice(0, 40);

  // The bike sits across the waterline, so it gets drawn twice: dark above
  // the fill, white below it. Each copy is clipped to its own half.
  const bike = (
    <>
      <circle cx="14.5" cy="24.5" r="4" />
      <circle cx="25.5" cy="24.5" r="4" />
      <path d="M14.5 24.5 L19.5 16 L25.5 24.5" />
      <path d="M19.5 16 L24 16" />
      <path d="M17 24.5 L23 24.5" />
    </>
  );
  const strokes = {
    fill: "none" as const,
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
  };

  return (
    <svg
      viewBox={`0 0 ${D} ${D}`}
      style={{ width: 40, height: 40, flex: "none" }}
      role="img"
      aria-label={label}
    >
      <defs>
        <clipPath id={`dry-${id}`}>
          <rect x="0" y="0" width={D} height={top} />
        </clipPath>
        <clipPath id={`wet-${id}`}>
          <rect x="0" y={top} width={D} height={D - top} />
        </clipPath>
        <clipPath id={`disc-${id}`}>
          <circle cx={D / 2} cy={D / 2} r={r} />
        </clipPath>
      </defs>

      {/* Empty part: a pale wash of the same colour, so the level shows. */}
      <circle cx={D / 2} cy={D / 2} r={r} fill={fill} opacity="0.16" />
      <rect
        x="0"
        y={top}
        width={D}
        height={D - top}
        fill={fill}
        clipPath={`url(#disc-${id})`}
      />
      <circle cx={D / 2} cy={D / 2} r={r} fill="none" stroke={fill} strokeWidth="2" />

      <g {...strokes} stroke={color.ink} strokeOpacity="0.75" clipPath={`url(#dry-${id})`}>
        {bike}
      </g>
      <g {...strokes} stroke="#FFFDFA" clipPath={`url(#wet-${id})`}>
        {bike}
      </g>
    </svg>
  );
}

// One compact row: how full each dock is right now.
function RightNowBar(props: { current: CurrentStatus[] }) {
  const { current } = props;
  const at = current.reduce<Date | null>(
    (newest, c) => (!newest || c.at > newest ? c.at : newest),
    null,
  );

  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        alignItems: "center",
        gap: "0 26px",
        padding: "14px 20px",
        background: color.card,
        border: `1px solid ${color.border}`,
        borderRadius: 12,
      }}
    >
      <span
        style={{
          fontFamily: mono,
          fontSize: 11,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: color.faint,
        }}
      >
        bikes now
        <br />
        {at ? fmtClock(at) : "--"}
      </span>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: "14px 26px",
        }}
      >
        {current.map((c) => (
            <div key={c.shortName} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <DockFill
                bikes={c.bikes}
                capacity={c.totalDocks}
                label={`${c.name}: ${c.bikes} bikes`}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: color.ink2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={c.name}
                >
                  {c.name}
                </div>
                <div style={{ ...tabular, whiteSpace: "nowrap" }}>
                  <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.01em" }}>
                    {c.bikes}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: color.faint }}>
                    {c.totalDocks ? `/${c.totalDocks}` : ""} bikes
                  </span>
                </div>
                <div style={{ ...tabular, fontSize: 11, color: color.muted }}>
                  {c.openSpots} {c.openSpots === 1 ? "dock" : "docks"} free
                </div>
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}

function ChartCard(props: { data: DataSet; names: Record<string, string> }) {
  const { data, names } = props;
  return (
    <section
      style={{ ...card, padding: "28px 30px 22px", display: "flex", flexDirection: "column", gap: 20 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 24,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.015em" }}>
            Bikes available over time
          </h2>
          <div style={{ fontSize: 13, color: color.faint }}>{describeSpan(data.rows)}</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, fontSize: 13, color: color.ink2 }}>
          {data.stations.map((code, i) => (
            <span key={code} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              <span
                style={{ width: 14, height: 3, borderRadius: 2, background: seriesColor(i) }}
              />
              {names[code] ?? code}
            </span>
          ))}
        </div>
      </div>

      <div style={{ width: "100%", height: 400 }}>
        <ResponsiveContainer>
          <LineChart data={data.rows} margin={{ top: 8, right: 52, bottom: 4, left: 4 }}>
            <CartesianGrid stroke={color.grid} vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={fmtTime}
              tick={{ fontSize: 11, fill: color.muted, fontFamily: mono }}
              tickLine={false}
              axisLine={{ stroke: color.grid }}
              minTickGap={70}
            />
            <YAxis
              allowDecimals={false}
              width={44}
              tick={{ fontSize: 11, fill: color.muted, fontFamily: mono }}
              tickLine={false}
              axisLine={false}
              label={{
                value: "bikes available",
                angle: -90,
                position: "insideLeft",
                style: { fill: color.muted, fontSize: 12, fontFamily: sans },
              }}
            />
            <Tooltip content={<PointTooltip capacity={data.capacity} />} />
            {data.stations.map((code, i) => (
              <Line
                key={code}
                type="monotone"
                dataKey={code}
                name={names[code] ?? code}
                stroke={seriesColor(i)}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                dot={{ r: 2 }}
                activeDot={{ r: 5 }}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function RateTable(props: {
  title: string;
  caption: string;
  stats: RateStat[];
  order: string[];
}) {
  const { title, caption, stats, order } = props;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{title}</h2>
        <span style={{ fontSize: 12, color: color.muted }}>{caption}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {stats.map((s) => {
          const i = order.indexOf(s.shortName);
          return (
            <div
              key={s.shortName}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 120px 52px 150px",
                alignItems: "center",
                gap: 16,
                padding: "8px 2px",
                borderBottom: `1px solid ${color.grid}`,
                fontSize: 13,
              }}
            >
              <span style={{ color: color.ink2 }}>{s.name}</span>
              <span
                style={{
                  height: 5,
                  borderRadius: 3,
                  background: color.grid,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    // Out of 100%, so a low rate reads as a low rate.
                    width: `${s.rate}%`,
                    height: "100%",
                    background: seriesColor(i < 0 ? 0 : i),
                  }}
                />
              </span>
              <span style={{ ...tabular, fontWeight: 700, textAlign: "right" }}>
                {s.rate.toFixed(0)}%
              </span>
              <span style={{ ...tabular, fontSize: 12, color: color.muted }}>
                {s.hits} of {s.total} readings
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [data, setData] = useState<DataSet | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Names for stations added just now, before the first reading arrives.
  const [freshNames, setFreshNames] = useState<Record<string, string>>({});

  // Kept in a ref so the refresh timer always reads the current station list
  // without being torn down and rebuilt on every change.
  const stationsRef = useRef<string[]>([]);
  stationsRef.current = config?.stations ?? [];

  const refresh = useCallback(async () => {
    try {
      const { data, readings } = await loadData(stationsRef.current);
      setData(data);
      setReadings(readings);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await loadConfig();
        if (!alive) return;
        stationsRef.current = cfg.stations;
        setConfig(cfg);
        await refresh();
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    const id = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [refresh]);

  const onSaveStations = useCallback(
    async (next: string[]) => {
      const result = await saveStations(next);
      stationsRef.current = result.stations;
      setFreshNames((n) => ({ ...n, ...result.names }));
      setConfig((c) => (c ? { ...c, stations: result.stations } : c));
      await refresh();
      if (result.unknown.length) {
        throw new Error(`Not in the feed, so not saved: ${result.unknown.join(", ")}`);
      }
    },
    [refresh],
  );

  const emptyStats: RateStat[] = useMemo(() => computeEmptyStats(readings), [readings]);
  const fullStats: RateStat[] = useMemo(() => computeFullStats(readings), [readings]);
  const current: CurrentStatus[] = useMemo(() => currentStatus(readings), [readings]);

  const page: React.CSSProperties = {
    fontFamily: sans,
    color: color.ink,
    minHeight: "100vh",
    padding: "56px 40px 96px",
    display: "flex",
    justifyContent: "center",
  };
  const inner: React.CSSProperties = {
    width: "100%",
    maxWidth: 1120,
    display: "flex",
    flexDirection: "column",
    gap: 40,
  };

  if (!config) {
    return (
      <div style={page}>
        <div style={inner}>
          {error ? (
            <p style={{ color: color.warn }}>Error: {error}</p>
          ) : (
            <p style={{ color: color.faint }}>Loading…</p>
          )}
        </div>
      </div>
    );
  }

  const names = { ...freshNames, ...(data?.names ?? {}) };
  const newestReading = current.reduce<Date | null>(
    (newest, c) => (!newest || c.at > newest ? c.at : newest),
    null,
  );
  const feedHost = config.gbfsBaseUrl.replace(/^https?:\/\//, "").split("/")[0];

  return (
    <div style={page}>
      <div style={inner}>
        <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 44,
              lineHeight: 1.05,
              fontWeight: 800,
              letterSpacing: "-0.025em",
            }}
          >
            Bluebikes dock availability
          </h1>
          <div
            style={{
              ...tabular,
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 14,
              color: color.muted,
            }}
          >
            <span>
              {data ? `${data.readingCount} readings · ` : ""}
              {newestReading ? `last reading ${fmtClock(newestReading)}` : "no readings yet"}
            </span>
          </div>
        </header>

        <StationEditor stations={config.stations} names={names} onSave={onSaveStations} />

        {error && (
          <div style={{ fontSize: 13, color: color.warn }}>
            Error: {error}
            <div style={{ color: color.faint, marginTop: 4 }}>
              Readings are read from {config.dataDir}/dock_status.csv
            </div>
          </div>
        )}

        {config.stations.length === 0 ? (
          <p style={{ color: color.faint }}>Add a station above to start seeing a chart.</p>
        ) : !data ? (
          <p style={{ color: color.faint }}>Loading readings…</p>
        ) : data.rows.length === 0 ? (
          <p style={{ color: color.faint }}>
            No readings yet for these stations. The collector writes one every five minutes.
          </p>
        ) : (
          <>
            <RightNowBar current={current} />
            <ChartCard data={data} names={names} />
            <RateTable
              title="How often the dock was empty"
              caption={`"empty" = ${DEFAULT_EMPTY_OPTIONS.threshold} bikes, counting every reading`}
              stats={emptyStats}
              order={data.stations}
            />
            <RateTable
              title="How often the dock was full"
              caption={`"full" = ${DEFAULT_FULL_OPTIONS.threshold} open spots, counting every reading`}
              stats={fullStats}
              order={data.stations}
            />
          </>
        )}

        <footer
          style={{
            fontFamily: mono,
            fontSize: 12,
            color: color.muted,
            display: "flex",
            gap: 18,
            flexWrap: "wrap",
            paddingTop: 8,
          }}
        >
          <span>data: GBFS feed · {feedHost}</span>
        </footer>
      </div>
    </div>
  );
}
