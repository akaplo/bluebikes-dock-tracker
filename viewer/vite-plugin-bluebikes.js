// A tiny API for the viewer, run inside Vite's own server.
//
// The browser cannot read or write files on its own, so these three routes do
// it: read the config, save a new station list, and serve the CSV the poller
// writes. Everything points at the project folder one level up, or at
// BLUEBIKES_DIR if that environment variable is set.
//
//   GET  /api/config          -> { gbfsBaseUrl, stations, dataDir }
//   PUT  /api/stations        <- { stations: ["S32009", ...] }
//                             -> { stations, unknown, names }
//   GET  /api/stations/search?q=teele -> { matches: [{ shortName, name, capacity }] }
//   GET  /api/dock_status.csv -> the raw CSV
//
// Nothing here is meant to face the open internet. It binds to localhost and
// writes only to stations.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GBFS_BASE_URL = "https://gbfs.lyft.com/gbfs/1.1/bos/en";

export function dataDir() {
  return path.resolve(process.env.BLUEBIKES_DIR || path.join(HERE, ".."));
}

function configPath() {
  return path.join(dataDir(), "stations.json");
}

function csvPath() {
  return path.join(dataDir(), "dock_status.csv");
}

// Trim, upper-case, and de-duplicate station codes, keeping their order.
function cleanCodes(values) {
  const out = [];
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== "string") continue;
    const code = v.trim().toUpperCase();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

function readConfig() {
  const cfg = { gbfsBaseUrl: DEFAULT_GBFS_BASE_URL, stations: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  } catch {
    return cfg; // missing or unreadable: defaults
  }
  if (typeof raw.gbfs_base_url === "string" && raw.gbfs_base_url.trim()) {
    cfg.gbfsBaseUrl = raw.gbfs_base_url.trim().replace(/\/+$/, "");
  }
  cfg.stations = cleanCodes(raw.stations);
  return cfg;
}

function writeConfig(cfg) {
  const body = JSON.stringify(
    { gbfs_base_url: cfg.gbfsBaseUrl, stations: cfg.stations },
    null,
    2,
  );
  fs.writeFileSync(configPath(), body + "\n");
}

// { SHORTNAME: { name, capacity } } for every station in the feed.
async function feedStations(gbfsBaseUrl) {
  const res = await fetch(`${gbfsBaseUrl}/station_information.json`, {
    headers: { "User-Agent": "bluebikes-tracker" },
  });
  if (!res.ok) throw new Error(`station_information returned ${res.status}`);
  const list = (await res.json())?.data?.stations ?? [];
  const out = new Map();
  for (const s of list) {
    const short = (s.short_name || "").trim().toUpperCase();
    if (short) {
      out.set(short, {
        stationId: s.station_id,
        name: s.name || "",
        capacity: s.capacity ?? null,
        regionId: s.region_id ?? null,
        lat: s.lat ?? null,
        lon: s.lon ?? null,
      });
    }
  }
  return out;
}

// { region_id: "Somerville" }. Optional feed, so an empty map is fine.
async function regionNames(gbfsBaseUrl) {
  const out = new Map();
  try {
    const res = await fetch(`${gbfsBaseUrl}/system_regions.json`, {
      headers: { "User-Agent": "bluebikes-tracker" },
    });
    if (!res.ok) return out;
    for (const r of (await res.json())?.data?.regions ?? []) {
      if (r.region_id != null) out.set(String(r.region_id), r.name || "");
    }
  } catch {
    // No region feed, or it's down. Results just won't name a town.
  }
  return out;
}

// { station_id: { bikes, docksFree } } as of right now.
async function liveCounts(gbfsBaseUrl) {
  const out = new Map();
  try {
    const res = await fetch(`${gbfsBaseUrl}/station_status.json`, {
      headers: { "User-Agent": "bluebikes-tracker" },
    });
    if (!res.ok) return out;
    for (const s of (await res.json())?.data?.stations ?? []) {
      out.set(s.station_id, {
        bikes: s.num_bikes_available ?? null,
        docksFree: s.num_docks_available ?? null,
      });
    }
  } catch {
    // Status feed is down. Results just won't show current counts.
  }
  return out;
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
      if (text.length > 100_000) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(text));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/config" && req.method === "GET") {
    sendJson(res, 200, { ...readConfig(), dataDir: dataDir() });
    return true;
  }

  if (url.pathname === "/api/stations" && req.method === "PUT") {
    const cfg = readConfig();
    let wanted;
    try {
      wanted = cleanCodes(JSON.parse(await readBody(req)).stations);
    } catch (e) {
      sendJson(res, 400, { error: `Could not read the station list: ${e.message}` });
      return true;
    }

    // Check the codes against the feed so a typo does not silently collect
    // nothing. If the feed is unreachable, save the list unchecked.
    let names = {};
    let unknown = [];
    let keep = wanted;
    try {
      const feed = await feedStations(cfg.gbfsBaseUrl);
      unknown = wanted.filter((c) => !feed.has(c));
      keep = wanted.filter((c) => feed.has(c));
      for (const c of keep) names[c] = feed.get(c).name;
    } catch (e) {
      res.setHeader("X-Feed-Warning", e.message);
    }

    cfg.stations = keep;
    try {
      writeConfig(cfg);
    } catch (e) {
      sendJson(res, 500, { error: `Could not write stations.json: ${e.message}` });
      return true;
    }
    sendJson(res, 200, { stations: cfg.stations, unknown, names });
    return true;
  }

  if (url.pathname === "/api/stations/search" && req.method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase();
    if (!q) {
      sendJson(res, 200, { matches: [] });
      return true;
    }
    try {
      const base = readConfig().gbfsBaseUrl;
      // Region names and live counts are extras: if either feed fails, the
      // results still list the stations.
      const [feed, regions, live] = await Promise.all([
        feedStations(base),
        regionNames(base),
        liveCounts(base),
      ]);
      const matches = [];
      for (const [shortName, meta] of feed) {
        if (meta.name.toLowerCase().includes(q) || shortName.toLowerCase().includes(q)) {
          const now = live.get(meta.stationId);
          matches.push({
            shortName,
            name: meta.name,
            capacity: meta.capacity,
            region: meta.regionId == null ? null : regions.get(String(meta.regionId)) ?? null,
            lat: meta.lat,
            lon: meta.lon,
            bikes: now?.bikes ?? null,
            docksFree: now?.docksFree ?? null,
          });
        }
      }
      matches.sort((a, b) => a.name.localeCompare(b.name));
      // Cap what gets sent, but say how many there really were so the page
      // can tell people their search was too broad.
      sendJson(res, 200, { matches: matches.slice(0, 25), total: matches.length });
    } catch (e) {
      sendJson(res, 502, { error: `Could not reach the feed: ${e.message}` });
    }
    return true;
  }

  if (url.pathname === "/api/dock_status.csv" && req.method === "GET") {
    let text;
    try {
      text = fs.readFileSync(csvPath(), "utf8");
    } catch {
      sendJson(res, 404, {
        error: `No readings file at ${csvPath()}. Run \`python3 bluebikes.py poll\` first.`,
      });
      return true;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(text);
    return true;
  }

  return false;
}

export default function bluebikesApi() {
  const middleware = (server) => {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/api/")) return next();
      handle(req, res).then(
        (handled) => {
          if (!handled) next();
        },
        (e) => sendJson(res, 500, { error: e.message }),
      );
    });
  };

  return {
    name: "bluebikes-api",
    configureServer: middleware,
    configurePreviewServer: middleware,
  };
}
