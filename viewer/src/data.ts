// Data handling: read the config, fetch the CSV the poller writes, parse it,
// and shape it for the chart. Both files are served by the small API in
// viewer/vite-plugin-bluebikes.js, which reads them from the project folder.

// Which stations to track, and which feed to read. Stations are station codes
// (short_name in the GBFS feed), like S32009.
export interface Config {
  gbfsBaseUrl: string;
  stations: string[];
  dataDir: string;
}

export async function loadConfig(): Promise<Config> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`Could not read the config (${res.status})`);
  const cfg = await res.json();
  return {
    gbfsBaseUrl: cfg.gbfsBaseUrl ?? "",
    stations: cleanCodes(cfg.stations),
    dataDir: cfg.dataDir ?? "",
  };
}

export interface SaveResult {
  stations: string[];
  unknown: string[]; // codes the feed does not have, so they were not saved
  names: Record<string, string>;
}

export async function saveStations(stations: string[]): Promise<SaveResult> {
  const res = await fetch("/api/stations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stations }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Could not save (${res.status})`);
  return {
    stations: cleanCodes(body.stations),
    unknown: cleanCodes(body.unknown),
    names: body.names ?? {},
  };
}

export interface StationMatch {
  shortName: string;
  name: string;
  capacity: number | null;
  region: string | null; // town, from the feed's region list
  lat: number | null;
  lon: number | null;
  bikes: number | null; // bikes there right now
  docksFree: number | null;
}

export interface SearchResult {
  matches: StationMatch[]; // capped by the server
  total: number; // how many matched in total
}

// Search the feed by station name, to look up a station code.
export async function searchStations(query: string): Promise<SearchResult> {
  const res = await fetch(`/api/stations/search?q=${encodeURIComponent(query)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Search failed (${res.status})`);
  const matches: StationMatch[] = body.matches ?? [];
  return { matches, total: body.total ?? matches.length };
}

// Trim, upper-case, and de-duplicate station codes, keeping their order.
export function cleanCodes(values: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== "string") continue;
    const code = v.trim().toUpperCase();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

// Split what someone typed into codes: commas, spaces, and newlines all work.
export function parseCodeInput(text: string): string[] {
  return cleanCodes(text.split(/[\s,;]+/));
}

// One raw reading from the CSV.
export interface Reading {
  timestamp: Date;
  shortName: string;
  name: string;
  bikes: number;
  ebikes: number;
  docks: number;
  capacity: number | null;
  isRenting: boolean;
}

// One row for Recharts: a time point with one field per station (keyed by
// station code) holding bikes available, plus a companion "<code> spots" field
// holding the open docks at that same moment, used in the hover tooltip.
export interface ChartRow {
  time: number; // epoch ms, used for the x-axis
  [key: string]: number | null;
}

export function spotsKey(shortName: string): string {
  return `${shortName} spots`;
}

export interface EmptyStat {
  shortName: string;
  name: string;
  empties: number;
  total: number;
  rate: number; // percent, 0-100
}

export interface DataSet {
  rows: ChartRow[];
  stations: string[]; // station codes with data, in stable order
  names: Record<string, string>; // code -> station name from the feed
  capacity: Record<string, number | null>; // code -> total dock spots
  readingCount: number;
}

// Settings for the "how often was it empty" number. Every reading counts, at
// any hour of the day.
export interface EmptyOptions {
  threshold: number; // bikes at or below this counts as empty
}

export const DEFAULT_EMPTY_OPTIONS: EmptyOptions = {
  threshold: 0,
};

// Split one CSV line, honouring the quotes Python's csv writer adds around
// values that contain a comma (some station names do).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

function toNumberOrNull(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const n = Number(text);
  return isNaN(n) ? null : n;
}

// Parse the CSV, keeping only readings for the stations passed in. An empty
// station list means "keep everything".
export function parseCsv(text: string, keep: string[] = []): Reading[] {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iTime = col("timestamp");
  const iShort = col("short_name");
  const iName = col("name");
  const iBikes = col("num_bikes_available");
  const iEbikes = col("num_ebikes_available");
  const iDocks = col("num_docks_available");
  const iCapacity = col("capacity");
  const iRenting = col("is_renting");
  const wanted = keep.length ? new Set(keep) : null;

  const out: Reading[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    if (c.length < header.length) continue;
    const shortName = (c[iShort] ?? "").trim().toUpperCase();
    if (wanted && !wanted.has(shortName)) continue;
    const t = new Date(c[iTime]);
    const bikes = Number(c[iBikes]);
    if (isNaN(t.getTime()) || isNaN(bikes)) continue;
    const docks = toNumberOrNull(c[iDocks]);
    out.push({
      timestamp: t,
      shortName,
      name: (iName >= 0 ? c[iName] : "")?.trim() || shortName,
      bikes,
      ebikes: toNumberOrNull(c[iEbikes]) ?? 0,
      docks: docks ?? 0,
      // Older readings have no capacity column; bikes plus open docks is the
      // same number in practice.
      capacity: (iCapacity >= 0 ? toNumberOrNull(c[iCapacity]) : null) ??
        (docks === null ? null : bikes + docks),
      isRenting: c[iRenting] === "1",
    });
  }
  return out;
}

// Group readings by timestamp into rows Recharts can plot directly.
function toChartRows(readings: Reading[]) {
  const codes: string[] = [];
  const names: Record<string, string> = {};
  const capacity: Record<string, number | null> = {};
  const byTime = new Map<number, ChartRow>();

  for (const r of readings) {
    if (!codes.includes(r.shortName)) codes.push(r.shortName);
    names[r.shortName] = r.name;
    if (r.capacity !== null) capacity[r.shortName] = r.capacity;
    const key = r.timestamp.getTime();
    let row = byTime.get(key);
    if (!row) {
      row = { time: key };
      byTime.set(key, row);
    }
    row[r.shortName] = r.bikes;
    row[spotsKey(r.shortName)] = r.docks;
  }

  const rows = [...byTime.values()].sort((a, b) => a.time - b.time);
  codes.sort((a, b) => (names[a] ?? a).localeCompare(names[b] ?? b));
  return { rows, stations: codes, names, capacity };
}

export interface CurrentStatus {
  shortName: string;
  name: string;
  bikes: number;
  openSpots: number; // docks free right now
  totalDocks: number | null;
  at: Date; // time of this reading
}

// The most recent reading for each station.
export function currentStatus(readings: Reading[]): CurrentStatus[] {
  const latest = new Map<string, Reading>();
  for (const r of readings) {
    const prev = latest.get(r.shortName);
    if (!prev || r.timestamp > prev.timestamp) latest.set(r.shortName, r);
  }
  return [...latest.values()]
    .map((r) => ({
      shortName: r.shortName,
      name: r.name,
      bikes: r.bikes,
      openSpots: r.docks,
      totalDocks: r.capacity,
      at: r.timestamp,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function computeEmptyStats(
  readings: Reading[],
  opts: EmptyOptions = DEFAULT_EMPTY_OPTIONS,
): EmptyStat[] {
  const byStation = new Map<string, Reading[]>();
  for (const r of readings) {
    if (!byStation.has(r.shortName)) byStation.set(r.shortName, []);
    byStation.get(r.shortName)!.push(r);
  }

  const stats: EmptyStat[] = [];
  for (const [shortName, list] of byStation) {
    const empties = list.filter((r) => r.bikes <= opts.threshold).length;
    const total = list.length;
    stats.push({
      shortName,
      name: list[list.length - 1].name,
      empties,
      total,
      rate: total ? (empties / total) * 100 : 0,
    });
  }
  return stats.sort((a, b) => a.name.localeCompare(b.name));
}

// Read the CSV for the given stations. Cache-bust so the newest readings come
// back rather than a stale browser copy.
export async function loadData(
  stations: string[],
): Promise<{ data: DataSet; readings: Reading[] }> {
  const res = await fetch(`/api/dock_status.csv?t=${Date.now()}`);
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Could not load the readings (${res.status})`);
  }
  const readings = parseCsv(await res.text(), stations);
  const { rows, stations: codes, names, capacity } = toChartRows(readings);
  return {
    readings,
    data: { rows, stations: codes, names, capacity, readingCount: readings.length },
  };
}
