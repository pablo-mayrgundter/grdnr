# 🌿 Grdnr

Grdnr is a small app for the gardener, about the work rather than the plot: a map of the whole yard, what's planted in each cell and row, when to water, thin, feed, transplant and harvest, plus notes, photos, a calendar and an AI garden assistant.

It's a static site (Vite + React) hosted on GitHub Pages at **https://pablo-mayrgundter.github.io/grdnr/**. **No garden data is built into the app.** Every garden lives only in the browser that created it (IndexedDB). It starts empty, from a garden file, or from the sample garden, and you can download it as a file at any time.

The sample garden (`public/samples/herb-garden.json`) is our own herb garden: the seed packets, the seed tray from our plan with its first photos, and the map. It's an ordinary garden file, published next to the app and loaded only when someone picks *Explore the sample garden* on the first-visit screen. To refresh it, download a garden file from Settings, remove the `chats`, and replace the file.

## Features

- **Home**: the garden map, with two tabs beside it. *Today* lists everything that needs doing, grouped so one tap waters a whole planter or records a sprinkler zone's run. *Coming up* shows the next two weeks and your own reminders. Under the tabs are the irrigation zones, the latest photos and recent notes. Tap something on the map to edit it right there.
- **Garden map**: the whole lot in an isometric drawing, like an illustrated garden plan, or as a flat plan. It's the home page, and the *Map* page adds the tools for building it: adding things, layers, the lot's size and location, watering, pets and the 3D export.
  - **What's on it:** the house (stories, roof, and doors and windows you can add and drag along the walls), front and back yards, fences, paths, pools and a hot tub, beds with their rows of plants, trees (height, clear trunk and spread), water and power on the house, irrigation and future robots.
  - **Editing:** pan, zoom and turn it, and drag, resize and turn things. A bed's rows can face their real compass heading. Edit things in the side panel.
  - **Sun and weather:** the sun casts shadows for the real time, or any time and date you scrub to. Set the garden's location (pick a city or paste coordinates from Google Maps) and drag the compass to point at true north. The week's forecast runs under the map (NOAA in the US, Open-Meteo elsewhere): tap a day to see its sun, clouds, rain or snow.
  - **Wildlife:** trees sway, birds come and go, butterflies and hummingbirds find flowering beds, squirrels forage under the trees, and now and then a neighborhood cat drops by. Add your dog, and it comes out the back door to chase them off, sniffs around the yard, and lies out on the patio on sunny days.
  - **3D export:** download it as a building model (IFC) to walk around the house and yard in [Bldrs](https://share.bldrs.ai) or any BIM viewer.
  - See [docs/MAP.md](docs/MAP.md).
- **Watering**:
  - **Rain** is recorded day by day, from the weather service for your location or your own rain gauge (which wins). It's kept in the garden file and counts as watering for the beds outdoors, so a rainy day doesn't look like a missed watering.
  - **Sprinklers, sprinkler lines and drip lines** on the map belong to irrigation zones. A sprinkler line is small sprinklers on stakes along a hose. A zone's run, from its timer or tapped in, counts as watering for every bed it covers, so Today asks for one run rather than a watering per bed.
  - **The map's Watering panel** runs a whole zone or just one line. Lines are drawn on their beds, and sprinklers spray on the map while their timer runs.
- **Calendar**: a month view with one short line per entry: what was done (care log, sowings), what's planned (schedule steps), what's overdue, and reminders. Tap a day for the full list. It also shows the week's forecast, the rain, and your average frost and hard-freeze dates, worked out from 30 years of weather history once the garden's location is set.
- **Planters**: each one is drawn cell by cell from a small markdown table (rows are letters, columns are numbers, each cell names a plant). Outdoor beds use the same table with one row per planted row, like `Beet (Detroit Golden) x 18`. See below.
- **Plant checks**: every plant in a bed gets its own spot. Tap some (or check a whole row) and record what you see (healthy, pests, disease, nutrients, water, weeds, damage, missing). Each plant is ringed in the color of its latest check.
- **Care schedule per plant**: built from the packet info in the seed library: daily misting while seedlings are in a planter, the germination window, then thinning, first feeding, pinching, potting up, transplanting and harvest windows. Logging the matching event checks a step off.
- **Plant pages**: care log, notes, photo gallery (shrunk on the device before saving), front and back seed packet photos, packet facts, and a Wikipedia summary with a link to the full article.
- **Garden assistant**: a chat panel on every page that knows which page you're on, and what's selected on the map. It can log care, plant checks and sprinkler runs, save notes, set reminders, fix sow dates, rewrite planter layouts, edit the map and look at photos. Run it with **Claude** (your API key) or a **local model through Ollama**.
- **Garden file**: Settings → *Download garden file* saves everything, including photos and assistant chats, as one JSON file. *Open a garden file* loads it on another device or another copy of the app. It also works from the first-visit screen.

### Planters as markdown

```markdown
# Seed tray

16-cell seed tray with humidity dome

|   | 1           | 2        | 3              | 4       |
|---|-------------|----------|----------------|---------|
| A | Rosemary    | Thyme    | Dill           | Basil   |
| B | Oregano     | Cilantro | Parsley        | Sage    |
| C | Lavender    | Lavender | Mint           | Mint    |
| D | Cauliflower | Broccoli | Bunching Onion | Lettuce |
```

- The `#` heading is the planter's name, and the next line describes it.
- The same name in neighboring cells of a row is one planting spanning them (lavender in 1–2C).
- Leave a cell blank (or `-`) when it's empty.
- Names are matched against the seed library, and unknown names are added to it.

For outdoor beds planted in rows, write each row as `Name (Variety) x Count`:

```markdown
# Bed 1

Raised bed, 8 × 4 ft

|   | 1                          |
|---|----------------------------|
| A | Beet (Detroit Golden) x 18 |
| B | Beet (Chioggia) x 12       |
| C | Carrot (Nantes) x 24       |
| D |                            |
```

- A table with one column, or any cell with `x N`, is a bed of rows. The bed's page draws it to scale from above: rows spread evenly across the bed, each row's plants spaced evenly along it (24 plants in a 6 ft row are 3 in apart), colored by crop. The map draws the same layout.
- Set the bed's real size with *Change size* on its page. A bed placed on the map takes its size from there, and changing it on either side changes both.
- `(Variety)` is optional. Each variety gets its own seed library entry, with its own packet photos.
- Changing just a count (`x 18` → `x 16`) keeps the planting and its history.
- On the map, *Create a planter for this bed* starts one of these for a bed you've drawn.

On a planter's page, *Edit layout as a table* shows the current layout in this format. When you save it, the app works out what changed:

- Plantings that are still there are kept.
- Plantings that shifted within their row are moved, with their history.
- New ones are added as *planned*.
- Removed ones are deleted if they have no history. If they do have care-log entries, notes or photos, they're kept outside the planter.

### Using a local model (Ollama)

The browser talks to Ollama directly, so no extra server is needed.

1. Allow this site's address in Ollama, then start it:
   ```bash
   OLLAMA_ORIGINS="https://pablo-mayrgundter.github.io" ollama serve
   # Mac app instead: launchctl setenv OLLAMA_ORIGINS "https://pablo-mayrgundter.github.io", then restart Ollama
   ollama pull gemma4:12b
   ```
2. In **Settings → Garden assistant**, choose *Local model (Ollama)*. The server defaults to `http://localhost:11434` and the model to `gemma4:12b`. Press *Test connection*.
3. Use Chrome, Edge or Firefox on the same computer as Ollama. Chrome may ask to let the site reach your local network; allow it. Safari won't let a secure site call `http://localhost`; there, run the app locally with `npm run dev`.

The app asks Ollama for a 16k-token context and sends a shorter history than it does to Claude. If the model can't call tools, the app falls back to plain chat and says so.

A phone can't reach `localhost` on your computer. Using a local model from a phone would need the Ollama server exposed over HTTPS (for example with `tailscale serve`), with that address entered in Settings.

## GitHub Pages and PR previews

- `.github/workflows/pages.yml`: on push to `main`, builds and publishes to the root of the `gh-pages` branch, keeping `pr-preview/`.
- `.github/workflows/pr-preview.yml`: builds each PR into `…/grdnr/pr-preview/pr-N/` with [`rossjrw/pr-preview-action`](https://github.com/rossjrw/pr-preview-action) and removes it when the PR closes.
- `.github/actions/build`: the shared install → test → build step.

Each preview runs at its own address, but on the same site (`pablo-mayrgundter.github.io`), and browser storage belongs to the site, not the address. **A preview opens your real garden**, which is handy for trying a change on real data. Anything you change in a preview changes the real garden too, so download a garden file first before trying anything risky.

## Development

Requires Node ≥ 22.18.

```bash
npm install
npm run dev     # http://localhost:5173
npm test        # schedule, storage, planters, beds, map, irrigation, weather, wildlife, 3D export and calendar tests (node:test, fake-indexeddb, web-ifc)
npm run build   # typecheck + static build into dist/ (BASE_PATH=/grdnr/ mimics Pages)
```

- `src/lib/store.ts`: IndexedDB storage, garden files, and the one-time photo migration.
- `src/lib/actions.ts`: every change to a garden, used by both the UI and the assistant. Planter layouts are applied here.
- `src/lib/trayMarkdown.ts`: parses and writes planter tables.
- `src/lib/schedule.ts` and `src/lib/calendar.ts`: the care schedule, and the calendar entries built from it.
- `src/lib/irrigation.ts`: irrigation zones, what each waters, timers and runs.
- `src/lib/weather/`: the forecast, recorded rain, and frost dates from the climate history.
- `src/lib/assistant/`: `core.ts` (context, tools), `claude.ts` and `ollama.ts` (backends).
- `src/lib/map/`: the garden map: data model, kinds of things, projection, drawing, sun, visitors and pets, the starting template, and the IFC export. See [docs/MAP.md](docs/MAP.md).
- `src/pages/`: one file per page. `Map.tsx` is the map page, and `Home.tsx` puts the same map on the home page beside today's care.
- `src/components/Logo.tsx`: the Grdnr wordmark, drawn from Bagel Fat One (SIL Open Font License), with a flower for each r.
