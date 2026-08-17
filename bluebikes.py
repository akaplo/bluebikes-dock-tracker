#!/usr/bin/env python3
"""Track bike-share dock availability for the stations you choose.

Usage:
    python3 bluebikes.py poll              # fetch once, append rows to the CSV
    python3 bluebikes.py watch             # poll now, then every 5 minutes forever
    python3 bluebikes.py chart             # build an SVG/HTML time-series chart
    python3 bluebikes.py stations          # list the stations being tracked
    python3 bluebikes.py stations add S32009 S32011
    python3 bluebikes.py stations remove S32009
    python3 bluebikes.py find "teele"      # search the feed for a station code

Which stations get tracked lives in stations.json, next to this script. The
chart viewer in viewer/ reads and writes that same file, so a change made in
either place applies to both.

Stations are identified by their short_name, like S32009 -- shown as "Site ID"
when you click a station on bluebikes.com/map. GBFS keys its status feed on an
internal UUID instead, so the UUIDs get looked up from station_information on
every run.

The default feed is Bluebikes (Boston). Any GBFS 1.1 feed works: point
"gbfs_base_url" in stations.json at another city's directory.
"""

import csv
import json
import os
import sys
import time
import urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "stations.json")
CSV_PATH = os.path.join(HERE, "dock_status.csv")
CHART_PATH = os.path.join(HERE, "dock_chart.html")

DEFAULT_GBFS_BASE_URL = "https://gbfs.lyft.com/gbfs/1.1/bos/en"

POLL_SECONDS = 300  # 5 minutes

# --- "empty rate" settings (used by the chart) --------------------------
# A reading counts as "empty" when bikes available is at or below this. Every
# reading counts, at any hour of the day.
EMPTY_THRESHOLD = 0

CSV_FIELDS = [
    "timestamp",         # when we polled (local ISO)
    "short_name",
    "name",
    "num_bikes_available",
    "num_ebikes_available",
    "num_docks_available",
    "capacity",          # total dock spots at the station
    "is_renting",
    "last_reported",     # station's own last update (unix)
]


# ---------------------------------------------------------------------------
# Config: which stations to track, and which feed to read.
# ---------------------------------------------------------------------------

def clean_station_list(values):
    """Trim, upper-case, and de-duplicate station codes, keeping their order."""
    out = []
    for v in values if isinstance(values, list) else []:
        if not isinstance(v, str):
            continue
        code = v.strip().upper()
        if code and code not in out:
            out.append(code)
    return out


def load_config():
    """Read stations.json. A missing or broken file falls back to defaults."""
    cfg = {"gbfs_base_url": DEFAULT_GBFS_BASE_URL, "stations": []}
    try:
        with open(CONFIG_PATH) as f:
            raw = json.load(f)
    except FileNotFoundError:
        return cfg
    except (json.JSONDecodeError, OSError) as e:
        print(f"warning: could not read {CONFIG_PATH} ({e}); using defaults",
              file=sys.stderr)
        return cfg

    base = raw.get("gbfs_base_url")
    if isinstance(base, str) and base.strip():
        cfg["gbfs_base_url"] = base.strip().rstrip("/")
    cfg["stations"] = clean_station_list(raw.get("stations", []))
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump({"gbfs_base_url": cfg["gbfs_base_url"],
                   "stations": cfg["stations"]}, f, indent=2)
        f.write("\n")


def info_url(cfg):
    return f"{cfg['gbfs_base_url']}/station_information.json"


def status_url(cfg):
    return f"{cfg['gbfs_base_url']}/station_status.json"


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "bluebikes-tracker"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def resolve_stations(cfg):
    """Return {short_name: {station_id, name, capacity}} for tracked stations."""
    info = fetch_json(info_url(cfg))["data"]["stations"]
    wanted = set(cfg["stations"])
    out = {}
    for s in info:
        short = (s.get("short_name") or "").strip().upper()
        if short in wanted:
            out[short] = {
                "station_id": s["station_id"],
                "name": s.get("name", ""),
                "capacity": s.get("capacity", ""),
            }
    missing = wanted - set(out)
    if missing:
        print(f"warning: could not find stations {sorted(missing)}", file=sys.stderr)
    return out


# ---------------------------------------------------------------------------
# Polling
# ---------------------------------------------------------------------------

def ensure_csv_header():
    """Bring an older CSV up to the current columns, once, in place.

    Early versions had no `capacity` column. Appending new rows to such a file
    would shift every value out of line, so the file gets rewritten with the
    current header and blanks for the columns it never recorded.
    """
    if not os.path.exists(CSV_PATH):
        return
    with open(CSV_PATH, newline="") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or reader.fieldnames == CSV_FIELDS:
            return
        rows = list(reader)

    tmp = CSV_PATH + ".tmp"
    with open(tmp, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: (r.get(k) or "") for k in CSV_FIELDS})
    os.replace(tmp, CSV_PATH)
    print(f"updated {CSV_PATH} to the current columns ({len(rows)} rows kept)")


def poll():
    cfg = load_config()
    if not cfg["stations"]:
        sys.exit("No stations configured. Add one: "
                 "python3 bluebikes.py stations add S32009")

    stations = resolve_stations(cfg)
    by_id = {v["station_id"]: (short, v) for short, v in stations.items()}
    status = fetch_json(status_url(cfg))["data"]["stations"]

    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    for s in status:
        if s["station_id"] in by_id:
            short, meta = by_id[s["station_id"]]
            rows.append({
                "timestamp": now,
                "short_name": short,
                "name": meta["name"],
                "num_bikes_available": s.get("num_bikes_available", ""),
                "num_ebikes_available": s.get("num_ebikes_available", ""),
                "num_docks_available": s.get("num_docks_available", ""),
                "capacity": meta["capacity"],
                "is_renting": s.get("is_renting", ""),
                "last_reported": s.get("last_reported", ""),
            })

    ensure_csv_header()
    new_file = not os.path.exists(CSV_PATH)
    with open(CSV_PATH, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if new_file:
            w.writeheader()
        for r in rows:
            w.writerow(r)

    summary = ", ".join(f"{r['short_name']}={r['num_bikes_available']} bikes" for r in rows)
    print(f"[{now}] logged {len(rows)} stations -> {CSV_PATH} ({summary})")
    return rows


def watch():
    print(f"Polling every {POLL_SECONDS//60} min. Ctrl-C to stop.")
    while True:
        try:
            poll()
        except Exception as e:  # keep the loop alive across network hiccups
            print(f"poll error: {e}", file=sys.stderr)
        time.sleep(POLL_SECONDS)


# ---------------------------------------------------------------------------
# Managing the station list from the command line
# ---------------------------------------------------------------------------

def stations_cmd(args):
    cfg = load_config()
    action = args[0] if args else "list"
    codes = clean_station_list(args[1:])

    if action == "list":
        if not cfg["stations"]:
            print("No stations configured.")
            return
        print(f"Feed: {cfg['gbfs_base_url']}")
        try:
            found = resolve_stations(cfg)
        except Exception as e:
            print(f"(could not reach the feed for names: {e})", file=sys.stderr)
            found = {}
        for code in cfg["stations"]:
            meta = found.get(code)
            print(f"  {code}  {meta['name'] if meta else 'not in the feed'}")
        return

    if action not in ("add", "remove"):
        sys.exit("usage: python3 bluebikes.py stations [list|add|remove] [CODE ...]")
    if not codes:
        sys.exit(f"usage: python3 bluebikes.py stations {action} CODE [CODE ...]")

    if action == "add":
        cfg["stations"] = clean_station_list(cfg["stations"] + codes)
    else:
        drop = set(codes)
        cfg["stations"] = [c for c in cfg["stations"] if c not in drop]

    save_config(cfg)
    print(f"Tracking {len(cfg['stations'])} stations: "
          f"{', '.join(cfg['stations']) or '(none)'}")


def find_cmd(args):
    """Search the feed by station name, to look up a station code."""
    if not args:
        sys.exit('usage: python3 bluebikes.py find "part of the station name"')
    needle = " ".join(args).lower()
    cfg = load_config()
    info = fetch_json(info_url(cfg))["data"]["stations"]
    hits = [s for s in info if needle in s.get("name", "").lower()]
    if not hits:
        print(f"No station name contains {needle!r}.")
        return
    for s in sorted(hits, key=lambda s: s.get("name", "")):
        print(f"  {s.get('short_name', '?'):>8}  {s.get('name', '')} "
              f"({s.get('capacity', '?')} docks)")


# ---------------------------------------------------------------------------
# Charting: build a small SVG line chart, no third-party libraries.
# ---------------------------------------------------------------------------

COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c"]


def read_rows():
    if not os.path.exists(CSV_PATH):
        sys.exit(f"No data yet at {CSV_PATH}. Run `python3 bluebikes.py poll` first.")
    with open(CSV_PATH, newline="") as f:
        return list(csv.DictReader(f))


def chart():
    cfg = load_config()
    tracked = set(cfg["stations"])
    rows = read_rows()
    # series[short_name] = list of (datetime, bikes)
    series = {}
    labels = {}
    for r in rows:
        short = (r.get("short_name") or "").strip().upper()
        if tracked and short not in tracked:
            continue  # not tracked any more; leave its history out of the chart
        try:
            t = datetime.fromisoformat(r["timestamp"])
            v = int(r["num_bikes_available"])
        except (ValueError, TypeError):
            continue
        series.setdefault(short, []).append((t, v))
        labels[short] = f"{short}: {r.get('name') or short}"

    if not series:
        sys.exit("No usable data points found in the CSV for the tracked stations.")

    # Empty rate per station, across every reading.
    empty_stats = {}
    for short, pts in series.items():
        vals = [v for _, v in pts]
        n = len(vals)
        empties = sum(1 for v in vals if v <= EMPTY_THRESHOLD)
        rate = (empties / n * 100) if n else 0.0
        empty_stats[short] = (empties, n, rate)

    # Plot geometry.
    W, H = 900, 460
    ML, MR, MT, MB = 60, 200, 30, 60
    plot_w, plot_h = W - ML - MR, H - MT - MB

    all_times = [t for pts in series.values() for t, _ in pts]
    all_vals = [v for pts in series.values() for _, v in pts]
    t_min, t_max = min(all_times), max(all_times)
    v_max = max(max(all_vals), 1)
    span = (t_max - t_min).total_seconds() or 1

    def x(t):
        return ML + plot_w * (t - t_min).total_seconds() / span

    def y(v):
        return MT + plot_h * (1 - v / v_max)

    svg = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
           'font-family="system-ui, sans-serif" font-size="12">']
    svg.append(f'<rect x="0" y="0" width="{W}" height="{H}" fill="white"/>')

    # Y grid + labels (integer ticks).
    ticks = min(v_max, 6)
    for i in range(ticks + 1):
        val = round(v_max * i / ticks)
        yy = y(val)
        svg.append(f'<line x1="{ML}" y1="{yy:.1f}" x2="{ML+plot_w}" y2="{yy:.1f}" '
                   'stroke="#e5e7eb"/>')
        svg.append(f'<text x="{ML-8}" y="{yy+4:.1f}" text-anchor="end" fill="#6b7280">{val}</text>')

    # X labels (start, middle, end).
    for frac in (0.0, 0.5, 1.0):
        tt = t_min.timestamp() + frac * span
        dt = datetime.fromtimestamp(tt)
        xx = ML + plot_w * frac
        svg.append(f'<line x1="{xx:.1f}" y1="{MT}" x2="{xx:.1f}" y2="{MT+plot_h}" stroke="#f3f4f6"/>')
        svg.append(f'<text x="{xx:.1f}" y="{MT+plot_h+20}" text-anchor="middle" fill="#6b7280">'
                   f'{dt.strftime("%m/%d %H:%M")}</text>')

    svg.append(f'<text x="{ML}" y="18" fill="#111827" font-weight="600" font-size="15">'
               'Available bikes over time</text>')
    svg.append(f'<text x="16" y="{MT+plot_h/2}" fill="#6b7280" transform="rotate(-90 16 {MT+plot_h/2})" '
               'text-anchor="middle">bikes available</text>')

    # Lines + points + legend.
    for i, (short, pts) in enumerate(sorted(series.items())):
        pts.sort()
        color = COLORS[i % len(COLORS)]
        d = " ".join(f"{x(t):.1f},{y(v):.1f}" for t, v in pts)
        svg.append(f'<polyline points="{d}" fill="none" stroke="{color}" stroke-width="2"/>')
        for t, v in pts:
            svg.append(f'<circle cx="{x(t):.1f}" cy="{y(v):.1f}" r="2.5" fill="{color}"/>')
        empties, n, rate = empty_stats[short]
        ly = MT + 10 + i * 40
        svg.append(f'<rect x="{ML+plot_w+15}" y="{ly-9}" width="12" height="12" fill="{color}"/>')
        svg.append(f'<text x="{ML+plot_w+32}" y="{ly+1}" fill="#374151" font-weight="600">{short}</text>')
        svg.append(f'<text x="{ML+plot_w+32}" y="{ly+17}" fill="#dc2626" font-size="11">'
                   f'empty {rate:.0f}% ({empties}/{n})</text>')

    svg.append("</svg>")
    svg_str = "\n".join(svg)

    npoints = sum(len(p) for p in series.values())
    stat_lines = "".join(
        f"<li><b>{labels[s]}</b>: empty {empty_stats[s][2]:.0f}% of readings "
        f"({empty_stats[s][0]} of {empty_stats[s][1]})</li>"
        for s in sorted(series)
    )
    html = f"""<!doctype html>
<meta charset="utf-8">
<title>Dock availability</title>
<body style="margin:24px;font-family:system-ui,sans-serif;color:#111827">
<h1 style="font-size:18px">Dock availability</h1>
<p style="color:#6b7280">{npoints} data points · updated {datetime.now().isoformat(timespec="seconds")}</p>
{svg_str}
<h2 style="font-size:15px;margin-top:20px">How often the dock was empty</h2>
<p style="color:#6b7280;margin-top:0">"empty" = {EMPTY_THRESHOLD} or fewer bikes, counting every reading.</p>
<ul style="line-height:1.6">{stat_lines}</ul>
</body>
"""
    with open(CHART_PATH, "w") as f:
        f.write(html)
    print(f"Wrote chart -> {CHART_PATH} ({npoints} points across {len(series)} stations)")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "poll"
    args = sys.argv[2:]
    if cmd == "poll":
        poll()
    elif cmd == "watch":
        watch()
    elif cmd == "chart":
        chart()
    elif cmd == "stations":
        stations_cmd(args)
    elif cmd == "find":
        find_cmd(args)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
