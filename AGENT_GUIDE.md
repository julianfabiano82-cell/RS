# SLC Demand Board — Agent Guide

You maintain the data behind `index.html`. **Never edit `index.html`.** Each run you rewrite **one file**: `data/zones.json`. Then commit and push. Cloudflare Pages redeploys on its own.

## Daily run
1. Read every folder in `Ridesharing/` (Airport Flights, Conventions, Event Tickets, Hotel Occupancy, Hospital Shifts, UTA Real-Time Transit, Local Weather, Road Closures, Surge History, My Shift Data, …).
2. Compute a 24-hour forecast (index 0 = 12 AM … 23 = 11 PM, America/Denver) for every item below.
3. Write `data/zones.json`. Validate it (checklist at the bottom), commit as `data: forecast YYYY-MM-DD`, then push.

## Scale and colors (the page applies these, so don't store colors)
- **Demand score** (0–100): ≥70 High (green) · 45–69 Moderate (amber) · <45 Low (gray)
- **Return chance** (avoid[] only): <25 Very low (red) · 25–44 Low (amber) · ≥45 OK (green)

## zones.json shape
```json
{
  "generated_at": "2026-10-09T05:30:00-06:00",
  "timezone": "America/Denver",
  "sample": false,
  "loops": [], "avoid": [], "areas": [], "venues": [],
  "routes": [], "neighborhoods": [], "alerts": []
}
```
Set `"sample": false` once the data is real. While it is `true`, the page shows "Sample data".

### loops[] — the core of the site (Loops tab)
`{ id, zone, from, to, miles, minutes, hourly[24], back?[24], note? }`
- `hourly` = **Out**: demand for trips from `from` to `to`.
- `back` = **Back**: demand for trips from `to` back to `from`. Leave it out when `from === to` (an in-zone loop, shown with ↻).
- **Loop score** (computed by the page) = round((out + back) / 2), or out alone for in-zone loops.
- `zone` must match an `areas[].id` that has a `direction`. It places the loop in the "Best loop by direction" compass and in its zone group.
- Aim for at least 3 loops per zone.

### avoid[] — Places to avoid
`{ id, name, dir?, miles, minutes, hourly[24], note? }`
- `hourly` = **chance of getting a trip back out** from that destination (0–100), not demand to go there.
- `miles` and `minutes` are measured from Temple Square. `dir` is one of N, NE, E, SE, S, SW, W, NW.
- The page sorts these worst first.

### areas[] — the Areas tab and the compass
`{ id, name, short?, direction?, drive?, hourly[24], reasons[], sources[] }`
- A `direction` (C, N, NE, E, SE, S, SW, W, NW) places the area on the compass around Temple Square. C is Downtown. Leave `direction` out for category areas (Hotels, Restaurants, Hospitals, Stadiums & Events).
- `drive` is the drive-time text from Temple Square, for example "5–15 min".
- `short` is the compass label (one or two words).
- Suggested area score = 0.6 × hottest venue + 0.4 × average of its top 3 venues.
- `reasons` are 2–3 plain-English lines. `sources` lists the folder names the reasons came from.

### venues[] — the places inside each area
`{ area: [ids], name, type, hourly[24], note? }`. A venue can belong to several areas, for example `["east","hospitals"]`.

### routes[] (Routes tab) and neighborhoods[]
- routes: `{ id, from, to, miles, minutes, hourly[24], note?, reverse? }`. `reverse` is the id of the opposite-direction route.
- neighborhoods: `{ id, name, hourly[24], note? }`

### alerts[]
`{ type, title, detail }`. Types include Road, Weather, Transit and Airport. Keep 0–5 alerts, current ones only.

## Which folders drive which signals
| Signal | Folders |
|---|---|
| Airport loops and areas | Airport Flights, Airport Flight Status, Flight Disruptions, TSA Wait Times, Airport Queue, Rental Car Availability |
| Event exits | Events, Event Tickets, Event Overlap, Event Parking, Conventions, City Events & Permits |
| Hotels | Hotel Occupancy, Hotel ADR, Booking Pace, City Compression Index, Airbnb Downtown |
| Hospitals | Hospital Shifts |
| Transit stations | UTA Real-Time Transit, UTA Ridership |
| Nightlife | Nightlife & Bar Close, Payday Effect, Prime Time Restaurants |
| Modifiers | Local Weather, Air Quality, Road Closures, Valley Road Closures, Downtown Construction, Holidays, School & University Calendars |
| Calibration | Surge History, Daily Rideshare Reports, My Shift Data |

## Checklist before committing
- Every `hourly`, `back` and avoid `hourly` has exactly 24 integers between 0 and 100.
- Every `loops[].zone` exists in `areas[]` and has a `direction`.
- Every `venues[].area` id exists in `areas[]`.
- Every `id` is unique within its list.
- Venues are still open (closed ones are removed). Miles and minutes come from a routing service.
- The file parses as JSON and is under 1 MB.

## "Now" tab (added 2026-10-08)
`index.html` has a 4th tab, **Now**, that shows what people are doing downtown right now. It is rendered
client-side by grouping `venues[]` — no schema change needed:
- Only venues whose `area` includes `"downtown"` appear.
- Categories: Bars ← `Nightlife`, Cinemas ← `Cinema`, Theaters ← `Theater`,
  Live events ← `Arena`/`Stadium`/`Venue`/`Convention`, Dining ← `Dining`.
- Each venue is a dial ranked by the selected hour's score, greens first; tapping opens the venue detail.
Rules for your daily run: always include the downtown cinemas (`type: "Cinema"`) with hourly curves
built from that day's real showtimes (evening blocks 6:30–10:30pm are the peak); keep downtown
`Nightlife`/`Theater`/`Dining`/`Arena` venues fresh from real events; bar demand with no live source is
estimated from day-of-week pattern + nearby events and its `note` must say so.
- `event` (optional string): tonight's/today's verified event at the venue (e.g. "Garth Brooks", "eXpcon").
  The Now tab dial shows the event name + venue; empty when no verified event. Never invent one.
