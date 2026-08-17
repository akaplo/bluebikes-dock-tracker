# Bike dock tracker

Records how many bikes are available at the bike-share stations you pick, and
shows the numbers on a chart over time.

Everything runs on your own computer. There is nothing to sign up for, no
account, no key, and no service anyone hosts for you. You clone this, run it,
and your readings stay in a CSV file on your disk. The only thing it talks to
is the bike-share system's own public feed.

It ships pointed at Bluebikes in Boston, but reads any
[GBFS](https://github.com/MobilityData/gbfs) 1.1 feed, so it works for most
North American bike-share systems.

There are two separate parts:

1. **The collector**: runs in the background all the time and saves a new
   reading every 5 minutes to `dock_status.csv`.
2. **The viewer**: a small web page you start only when you want to look at
   the data. It reads the same CSV file, and it's also where you choose which
   stations to track.

You can leave the collector running for weeks. You only start the viewer when
you want to see the chart.

Needs Python 3.9+ (no packages) and Node 18+ for the viewer.

---

## Setting up

```
git clone <this repo> bluebikes
cd bluebikes
cp stations.example.json stations.json
cd viewer && npm install
```

---

## Choosing stations

Stations are identified by their **station code**, like `S32009`.

To find one, open the map at [bluebikes.com/map](https://bluebikes.com/map) and
click a station. The code is the **Site ID** in the popup. The phone app does
not show it, so use the website.

In the feed this is `short_name`. (The feed also has a `station_id`, but that's
an internal UUID that nothing shows you, so the code is what gets used
everywhere here.)

The list lives in `stations.json`. You can edit it three ways, and they all
change the same file:

- **In the viewer**: type codes into the box at the top of the page and press
  Add. There's also a search box if you only know the station's street name.
- **From the command line:**

  ```
  python3 bluebikes.py stations              # list what's tracked
  python3 bluebikes.py stations add S32009 S32011
  python3 bluebikes.py stations remove S32011
  python3 bluebikes.py find "teele"          # look up a code by name
  ```

- **By hand**: open `stations.json` in a text editor.

The collector picks up changes on its next reading, within 5 minutes. No
restart needed.

Removing a station stops new readings and hides it from the chart. Its old
readings stay in the CSV; add the station back and they reappear.

### Tracking a different city

Change `gbfs_base_url` in `stations.json` to another system's GBFS directory,
the folder holding `station_information.json`. For example, Citi Bike in New
York is `https://gbfs.lyft.com/gbfs/1.1/bkn/en`.

---

## The collector

### Run it once, right now

```
python3 bluebikes.py poll
```

### Run it in the background forever

On macOS, use the launchd template in `launchd/`. Replace `PROJECT_DIR` in it
with the path to this folder, save the result to
`~/Library/LaunchAgents/com.bluebikes.tracker.plist`, then:

```
launchctl load ~/Library/LaunchAgents/com.bluebikes.tracker.plist    # start
launchctl list | grep bluebikes                                      # is it running?
launchctl unload ~/Library/LaunchAgents/com.bluebikes.tracker.plist  # stop
```

It takes one reading right away, then one every 5 minutes.

On Linux, use the cron line at the top of that same template file.

Or, if you'd rather just leave a terminal window open:

```
python3 bluebikes.py watch
```

### See the most recent readings

```
tail dock_status.csv
tail poll.log
```

---

## The viewer

Start it when you want to look at the data, and stop it when you're done. The
collector keeps running either way.

```
cd viewer
npm run dev
```

Then open **http://localhost:5273**.

The chart updates by itself once a minute. Hover over any point to see the
exact number of bikes and open spots at that time.

Press **Control + C** in that terminal to stop it.

The page reads the CSV and edits the station list by asking the same `npm run
dev` process to touch those files, since a browser cannot open files on its
own. That runs on localhost only and stops when you press Control + C. Do not
put it on the open internet: it writes to `stations.json` with no login.

By default it reads the CSV and config from the folder above `viewer/`. Set
`BLUEBIKES_DIR` to point it somewhere else:

```
BLUEBIKES_DIR=~/my-bike-data npm run dev
```

### A chart without Node

If you would rather not run the web viewer, this writes a plain HTML file with
the same chart in it:

```
python3 bluebikes.py chart      # writes dock_chart.html
```

---

## Files

| File / folder     | What it is                                            |
| ----------------- | ----------------------------------------------------- |
| `bluebikes.py`    | The collector, and the no-dependency chart.           |
| `stations.json`   | Which stations to track, and which feed to read.      |
| `dock_status.csv` | All recorded readings. This is your permanent data.   |
| `poll.log`        | Notes from the collector about each reading.          |
| `viewer/`         | The chart web app.                                    |
| `launchd/`        | Template for running the collector in the background. |

`dock_status.csv` only grows; nothing is ever overwritten. It is safe to copy
anywhere as a record.

---

## Notes

- The chart's "how often the dock was empty" number counts every reading, at
  any hour. To change what counts as "empty", edit `DEFAULT_EMPTY_OPTIONS` near
  the top of `viewer/src/data.ts` and refresh the page. The command-line chart
  has the same setting at the top of `bluebikes.py`.
- Readings are timestamped in your computer's local time.
- Feeds are public and need no API key. Please be a decent citizen about how
  often you poll.

---

## License

MIT. See [LICENSE](LICENSE).
