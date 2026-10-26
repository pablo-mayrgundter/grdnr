# Garden map

The map is "Google Maps for your garden", and the app's home page: one drawing of the whole lot (house, front and back yards, the side yard where water and power come out of the house) that you can pan, zoom and turn, and edit both on the drawing and in the side panel. It's drawn in the style of an illustrated garden plan (isometric, shaded line art) with a flat plan view for precise layout.

This document is the spec: the data model, how drawing works, and where new features plug in.

## Code

| File | What it holds |
|---|---|
| `src/lib/map/model.ts` | Types: `Site`, `MapEntity`, `MapLinks`, and the `LAYERS` list. |
| `src/lib/map/kinds.ts` | The kinds registry: every kind of thing that can go on the map, as plain data. |
| `src/lib/map/geometry.ts` | Projection (iso and plan, four rotations), unprojection for dragging, face ordering, snapping, free-spot search. No DOM. |
| `src/lib/map/render.tsx` | SVG patterns and one drawer per kind. |
| `src/lib/map/bedPlants.ts` | Where a bed's plants stand on the map (shared by the drawing and the 3D export). |
| `src/lib/irrigation.ts` | Irrigation zones: what each waters, timers, and runs that count as watering. |
| `src/lib/map/ifc.ts` | The map as a 3D building model (IFC4), for Bldrs and other BIM viewers. |
| `src/lib/map/template.ts` | The starting lot ("Start from a typical lot"). |
| `src/lib/actions.ts` | `setSite`, `applySiteTemplate`, `addMapEntity`, `updateMapEntity`, `deleteMapEntity`, `createPlanterForEntity`. The UI and the assistant both go through these. |
| `src/pages/Map.tsx` | The map page: viewport, pointer and keyboard handling, panels. With `home`, the same map is the home page, with the home page's column (`src/pages/Home.tsx`) in place of the map tools; selecting something still puts its editor in that column. |
| `test/map.test.ts` | Projection round trips, ordering, kinds, template, actions, garden-file round trip. |
| `test/ifc.test.ts` | The 3D export opens in web-ifc (the IFC reader Bldrs uses) with a shape for every kind. |

## World coordinates

- Units are **feet**.
- The origin is the lot's **north-west corner**. **x** grows east, **y** grows south, **z** grows up.
- `Site` (stored on the garden as `garden.site`) gives the lot's `width` (east–west) and `depth` (north–south), `northDeg` (degrees clockwise from the top of the plan to true north; a lot that isn't square to the compass still draws square), and `gridFt` (snapping step; 0 turns it off).
- "North" in the coordinates means the top of the plan. True north is only used for the compass today, and later for sun and shade.

## Entities

Everything on the map is a `MapEntity`: a box, optionally turned about its center.

```ts
type MapEntity = {
  id: string;
  kind: string;              // key into the kinds registry
  name: string;
  x: number; y: number;      // north-west corner of the footprint
  w: number; d: number;      // east–west and north–south size
  h: number;                 // height
  z: number;                 // base height (netting over a bed, an outlet on a wall)
  rot?: number;              // turn about the center, degrees clockwise on the plan (0 = square to the lot)
  props: Record<string, string | number | boolean | null>;  // kind-specific settings
  links: { trayId?, speciesId?, entityId? };                 // ties to the rest of the garden
  openings?: Opening[];      // doors and windows, for buildings (absent: the kind's defaults)
  notes: string | null;
  createdAt: string; updatedAt: string;
};
```

A box is enough for beds, buildings, slabs, fences, hedges, tree canopies, pipes and rails, and it keeps snapping, resizing and drawing simple. Things with an inherent direction (fences, paths, drip lines, gantries, a bed's rows) run along the box's **long side**.

`x`, `y`, `w` and `d` describe the box before it's turned; `rot` then turns it about its center. Drawers never deal with the turn themselves: `drawEntity` hands each one `entityProjector(pj, e)`, a projector that turns points about the entity's center before projecting, so a drawer written for a square box draws correctly at any angle, and so does everything inside it (a bed's rows of plants, a building's walls and windows). The rest of the geometry helpers work on turned boxes too: `footprintCorners` gives a footprint's corners, `footprintBounds` the square box around it (used when placing new things), and `resizeFromCorner` resizes from the turned corner while the opposite corner stays put. A bed's rows run along its long side, so `longSideBearing` and `rotForBearing` convert between a turn and the rows' true compass heading, using the lot's `northDeg`.

Entities live in their own IndexedDB store, `mapEntities` (database version 2), and travel in the garden file like every other record. An entity whose kind this version doesn't know still loads, edits and draws as a plain box, so a garden file from a newer version is safe to open.

### Links

- `trayId`: a planter. A bed linked to a planter draws its rows: rows run along the bed's long side and are spread evenly across it, and each row's plants are spaced evenly along it. The positions come from `layoutBed` in `src/lib/bedLayout.ts`, the same layout the planter page draws, so the two always agree. Plants are colored by crop (`src/lib/plantColors.ts`), drawn by growth stage, and tinted by their latest check. The bed's size on the map is the planter's size: changing it on the planter page resizes the map bed, and linking a planter that already has a size resizes the bed to match. A seed station linked to a tray draws its cells.
- `speciesId`: a plant from the seed library, e.g. the variety of a fruit tree.
- `entityId`: another map entity this one belongs to: netting over a bed, a drip line or sensor in a bed, a valve feeding a zone, a gantry over a bed. Removing an entity clears links that point to it.

## Kinds

`KINDS` in `kinds.ts` is pure data:

```ts
{
  kind: "raised-bed", label: "Raised bed", icon: "🟤", layer: "growing",
  description: "Raised bed; link a planter to show its rows and plants.",
  defaults: { name: "Raised bed", w: 8, d: 4, h: 1 },
  fields: [...],     // extra settings, edited in the panel, stored in props
  links: ["tray"],   // which link pickers the panel shows
  flat: false,       // ground covers draw beneath everything else
  resizable: true,   // points (outlet, spigot) keep their size
}
```

Layers group kinds for drawing order, the add palette and show/hide: ground & paths, house & structures, beds & plants, water & power, irrigation, automation, areas & labels.

Today's kinds: lawn, path (pavers, stepping stones, gravel, mulch, concrete), patio, driveway, mulch bed; house (stories, story height, roof rise), shed, fence (privacy, picket, wire), gate, trellis, netting, in-ground pool, above-ground pool, hot tub (rounded rectangles with a corner radius); raised bed, in-ground bed, herb garden, seed station, fruit tree, tree, shrub, hedge, container, compost; water spigot, power outlet, meter, AC unit, rain barrel; irrigation valve, sprinkler (spray radius, zone), drip line; robot gantry (planned or installed), robot dock, sensor; area (a named region such as "Front yard").

A kind can also say:

- `round`: round in plan, like a tree's canopy. The panel shows one *Spread* instead of width and depth, and resizing keeps it round.
- `derive`: geometry that follows from its settings, applied on every change. A house's wall height is stories × story height, so the panel shows the walls and ridge instead of a height field. A house drawn before stories existed keeps its height: its story height falls back to height ÷ stories.
- `openings`: it has doors and windows (house, shed).
- A field's `value`: what to show when the setting isn't stored. A tree's *Clear trunk* (where the canopy starts, used for drawing and shadows) defaults to a share of its height (`treeTrunk`).

### Doors and windows

`src/lib/map/openings.ts`. Each opening is `{ id, type: "window" | "door" | "garage", wall: "n" | "e" | "s" | "w", offset, width, height, bottom }`. These are in feet, in the building's own unturned frame. `offset` runs from the wall's west end (n and s walls) or north end (e and w walls), and `bottom` is the height above the ground.

- **Defaults:** a building without `openings` gets `defaultOpenings`. On a house that's a front door centered on the south wall, a back door on the north wall, and windows about every 8 ft on every story, kept clear of the doors. A shed gets a door. The first edit stores the list, and from then on it's yours.
- **Drawing:** openings are drawn on the walls facing the viewer, with floor lines between stories. From above, they're marked along the eaves.
- **Editing:** selecting a building shows a W, D or G tab on the ground outside each opening. Dragging a tab slides it to the nearest spot on the nearest wall (`placeOpening`), round corners too. Delete removes the selected opening. The panel lists them by wall (named by the compass), with position, width, height and height off the ground, and adds new ones in the widest free stretch of a wall (`newOpening`).

### Adding a kind

1. Add an entry to `KINDS`. That's enough for it to appear in the palette, be placed, edited, saved and drawn as a box.
2. Optionally add a drawer to `DRAWERS` in `render.tsx` for a better picture.
3. If it has settings, list them in `fields`. The panel builds number, text, select and checkbox inputs from them.

## Drawing

- `makeProjector(mode, rot, site)` maps world points to **scene** coordinates. Iso is a 2:1 dimetric projection (`sx = (rx − ry)·cos 30°`, `sy = (rx + ry)·½ − z·0.82`). Plan is top-down. `rot` turns the lot in quarter turns about its center, so you can look at it from any side.
- Zoom and pan are a single SVG transform over the scene, so panning never redraws. Strokes use `vector-effect: non-scaling-stroke` and patterns are in scene units, so the drawing scales like ink on paper.
- Order: flat kinds first (by layer, then largest first), then the sun's shadows, then solids back to front with `paintOrder`. In the isometric view one solid goes before another when its footprint lies wholly behind the other's along either ground axis (as the view sees them), so a long fence along the front covers the beds behind it even though its middle is far away; overlapping footprints (netting over a bed) fall back to center depth. The plan view draws lowest tops first. Inside a drawer, `Faces` sorts a solid's faces by depth.
- Drawers get `{ pj, data, today, zoom }`. They work in world feet and project through `pj`, so the same code draws both views and all rotations. Pins (`Pin`) and the selection handle divide by `zoom` to keep a constant size on screen.
- Labels are drawn in screen space on top, so text stays crisp. They stay out of the way: hovering something shows its name in a light label, and the selected thing's name shows in full weight.

## Sun and shadows

`src/lib/map/sun.ts` works out where the sun is (`sunPosition`, standard low-precision solar formulas, good to a fraction of a degree) from the time and the garden's location (`site.lat`, `site.lon`). Until the location is set, `gardenLocation` guesses one from the time zone's standard offset at 40°N, so the sun rises, peaks and sets about right.

- **Shadows** are cast straight onto the ground: each solid's footprint and top are pushed away from the sun by height ÷ tan(altitude) (capped for a sun at the horizon), and the shadow is the outline around both (`entityShadow`). Kinds choose a shape: boxes; buildings add the roof ridge; trees and shrubs cast a canopy on a trunk; ground covers and areas cast none. Turned entities cast turned shadows. All shadows are one path clipped to the lot, drawn between the ground covers and the solids, so overlaps don't double up.
- **The sun** is drawn at the edge of the map in the direction of its real place in the sky (out past the lot, raised by its altitude), with its altitude. Below the horizon the scene is shaded for night, fading in through twilight.
- **The clock** follows the real time by default. Drag through the day or pick a date to move the sun; *Now* goes back to live. The ☀️ box turns sun and shadows off.
- **Location** (lot settings): pick a city from the list (`src/lib/map/places.ts`), paste coordinates (`parseLatLng` reads Google Maps' `@30.1836998,-97.7891487`, whole Google Maps links, preferring a dropped pin's `!3d…!4d…` over the view's center, `30.18, -97.78`, and `30.18° N, 97.78° W`), type latitude and longitude, or use this device's location. It's kept to four decimals (about 10 m).
- **North**: drag the compass on the map until its N points at true north on your lot (the screen direction is turned back into a ground direction with `unprojectDelta`, so it works in every view and rotation). The sun, shadows and bed headings follow as you drag; it's saved when you let go. The lot settings have the same angle as a number.

## Weather

`src/lib/weather/`. Nothing here is part of the garden: results are cached in the viewer's browser (the forecast for an hour, frost dates for good) and the location is rounded to about a kilometer before it's sent.

- **Forecast** (`forecast.ts`): NOAA's api.weather.gov for US locations (`/points/{lat},{lon}`, then its forecast). Open-Meteo is used elsewhere, or if NOAA fails. Both answer browsers directly with no key. NOAA's day and night periods become days: the high and summary come from the day, the low from that night. Each day gets a sky (`sun`, `cloud`, `rain`, `snow`), an icon, the chance of rain and the highest wind. Temperatures are kept in °F and shown in the viewer's units.
- **On the map:** the week runs along under the map. Tapping a day sets the clock to that day and simulates its sky. Clouds dim the scene and send soft cloud shadows drifting over, and sun shadows fade. Rain and snow fall in screen space, so they look the same at any zoom. Snow whitens the ground, and rain and wind make the trees sway harder. Tap the day again, or *Now*, to go back to live.
- **Frost dates** (`climate.ts`): 30 full years of daily lows from Open-Meteo's historical weather (ERA5 reanalysis, about a 10 km grid). For each year it finds the last freezing night of spring and the first of autumn, at 32°F (frost) and 28°F (hard freeze), then averages them. Spring and autumn swap in the southern hemisphere. A threshold reached in fewer than half the years reads "rarely".
- **Calendar:** the week's forecast icons with highs and lows, and the four frost dates marked every year, with a summary card.
- **Rain** (`rain.ts`): rain that fell in the garden is part of the garden. It's kept in the `rain` store, one record per day, and travels in the garden file.
  - Where amounts come from: Open-Meteo's daily precipitation for the location. That's the forecast service's past days for the last two weeks, and its archive for older days. While the app is open (`RainSync`), it fills in missing days up to 120 days back and refreshes today every hour.
  - Today: counts as *expected* when the forecast chance is at least 60%, and is replaced by the recorded amount once the day is over.
  - Your own gauge: a reading entered on the calendar always wins.
  - Watering: a day with 0.1 in or more counts as watering, but only for outdoor plantings. That means a bed planted in rows, or a planter linked to a bed or container on the map (`rainReaches`); a seed tray on the seed station never gets rained on. It shows in the planting's watering status and history, on the calendar, and in the assistant's context.

## Irrigation

`src/lib/irrigation.ts`. Sprinklers, sprinkler lines, drip lines and valves each have a *zone* setting (default "1"). Everything on the same zone runs together, and a run counts as watering for every planting in the beds the zone waters, the same way rain does. One sprinkler run then covers the beets in one bed and the radishes and spinach in the next, and the home page's Today tab asks for one run instead of a watering per bed.

- **What a zone waters** (`bedsWatered`), worked out from the map (raised beds, in-ground beds, herb gardens and containers):
  - a sprinkler: the beds most of which lie inside its spray radius (at least 5 of 9 points over the bed);
  - a sprinkler line (small sprinklers on stakes along a hose, one every 18 in by default, `sprinklerHeads`): the bed it's linked to, else the beds it runs through or most of which its heads' sprays cover;
  - a drip line: the bed it's linked to under *Belongs to*, else the beds it runs through;
  - a valve: the bed it's linked to. A valve is mostly there to show where the controls are.
- **Settings** (`garden.zones`, in the garden file): a name ("Back beds") and a timer, set in the zone panel that shows when a sprinkler, sprinkler line, drip line or valve is selected. A timer is the days of the week, a start time in the garden's time zone, how long it runs (20 minutes if not set), and a paused switch.
- **A line's span:** a drip line or sprinkler line is a rectangle: its length (between its end knobs) and its *span*, the width it waters, set with the ↔ knob on its side. A sprinkler line's heads throw to the span's edges, 15% past so neighbors overlap and the bed soaks evenly (`sprayRadius`), unless a spray radius is set. The zone panel switches a line between drip line and sprinkler line in place, keeping where it is, its span and its zone.
- **Runs** (the `irrigation` store, in the garden file): one record per zone per day, and one per line per day for a line run on its own. A single drip line or sprinkler can run by itself (`head` on the run: a hand-opened line, or a valve per line); that run waters only that line's beds.
  - *timer*: recorded by `IrrigationSync` as the start time passes, and for missed days since the timer was set (up to a month back), while the app is open.
  - *manual*: someone tapped *Ran* (on the home page, or in the zone panel), or told the assistant.
  - *skipped*: the timer's run that day didn't happen (*Didn't run* on the home page); it doesn't count, and the timer won't fill the day in again.
  - Changing a timer takes effect from that day, so earlier runs stay as they were.
- **Watering:** the care schedule takes the latest of a hand watering, a zone run and rain (`careSchedule`'s `irrigation` input). A run shows as "Zone 1 sprinklers ran today, which counts" and in the planting's history.
- **Watering panel** (map side panel, with nothing selected): each zone with its timer and last run, and a *Run whole zone* button. Under it, each of the zone's drip lines and sprinklers, the beds it waters, and a *Ran* button for just that one. Tap a line's name to select it on the map. Buttons there add a drip line or a sprinkler.
- **Spraying:** sprinklers and sprinkler lines spray while they run: jets arc out from each head to its spray radius, drawn as dashes flowing outward over a mist on the ground they wet. Drip emitters pulse. A zone is running while the map's clock (live, or scrubbed to a time) is within its timer's run, unless that day's run was skipped (`zonesRunning`). After *Run whole zone* or a line's *Ran*, or with *▶ Watch it run* (which records nothing), it sprays for 20 seconds.
- **Drawing:** a sprinkler line is a green hose with a gray stake and a yellow head at each sprinkler, up on a bed where it runs over one. A drip line that runs over a bed (or is linked to one) is drawn on top of the bed, not under it on the ground. It shows as the bed's drip system, over just the part of the bed the line's span covers (`lineArea`; the whole bed for a line with no span set): a header across the end of that area nearest where the tubing comes in, and a lateral beside each of the bed's rows within it (or about one per 1¼ ft) with emitters every foot. Running, only those emitters drip. The tubing and header have a wide invisible edge, so they're easy to click.
- **Placing runs:** drip lines, fences and trellises are *runs* (`line` in the kinds registry). When one is selected, a big knob at each end (white at the start, blue at the end) drags that end while the other stays put, so a line can be laid across a bed at any angle (`lineEnds`, `lineFromEnds`). Other things keep the corner (resize) and ⟳ (turn) knobs, now larger, with a white halo so they show on any ground.
- **Home page:** in the Today tab, due watering is grouped by zone ("Run the Zone 1 sprinklers", or "…run at 6:00 AM" when the timer still has to run today), with one *Ran* button. Plantings no zone waters are grouped by planter as before. An *Irrigation* card under the tabs lists each zone that waters beds: its timer, when it last ran, and *Ran today* / *Didn't run*.
- **Assistant:** its context lists the zones, their lines (with IDs) and the beds each waters, their timers, and the last 10 days of runs. `irrigation_ran` records a zone's run, or one line's with `line_id`, or that one didn't happen. `edit_map` can set a sprinkler's zone and spray radius when it adds the irrigation to the map.
- Seedlings in outdoor beds are kept moist, not misted: "mist" is for trays.

## Animation

All of it can be turned off with the 🐦 box in the clock, and it stays still for people who prefer reduced motion.

- **Trees and shrubs sway** from the bottom of the canopy, each at its own pace. It's a CSS animation whose `--sway` grows with rain and wind.
- **Visitors** (`src/lib/map/wildlife.ts` decides who comes and where; `src/components/Critters.tsx` runs the motion in its own animation-frame loop, re-rendering only itself; the drawings are in `src/components/CritterSprites.tsx`):
  - **Songbirds** (cardinals, jays, sparrows, goldfinches, robins, chickadees) fly in to perch in trees, shrubs and hedges and on fence tops. They hop about, sometimes move to another tree, then leave. There are more by day and fewer in rain.
  - **Butterflies** come to beds with flowering plants, and **hummingbirds** to tubular flowers. The plants are matched by name in the seed library (`BUTTERFLY_PLANTS`, `HUMMINGBIRD_PLANTS`), or by a seed library category of "flower". This is the start of making plant choices show up as visitors.
  - **Cats** (Mochi, Pepper, Marmalade, Tux, Calico, Smokey, Biscuit, Snowball) wander in now and then from the nearest edge. Each sits on open ground with a swishing tail and the odd blink, then wanders off. They stay in when it's wet.
  - **Squirrels** (gray and fox) come by day. They forage under trees in short dashes, sit up now and then, and run up a trunk into the canopy (`climbTrees`: trees and fruit trees with at least 2 ft of clear trunk, not shrubs). After a while up a tree they come down to forage some more, or leave.
- **Your dog** (`src/lib/map/pets.ts`). The garden's pets are kept with the garden (`garden.pets`, so they travel in the garden file) and added in the map's *Pets* panel: a name and a coat (red or blue heeler, black, yellow, golden, chocolate and more, in `DOG_COATS`). A dog lives in the house and comes out the back door (`backDoor`: the house door nearest the patio, else one on the plan-top wall). No house, no dog.
  - It comes out for a look around every few minutes, and sooner when a cat or squirrel is in the yard (about 15 s on average).
  - Out in the yard it spots cats and squirrels on the ground within a second or two (a few seconds when lying down) and gives chase. Once it's within 14 ft, a cat bolts for the fence, and a squirrel makes for the nearest tree within 35 ft and goes up it (or over the fence if there's none). The dog runs them to the fence or to the trunk, barks ("Woof!"), and goes on.
  - Between chases it makes the rounds: one to three spots of open ground near the door (`patrolSpot`), sniffing at each.
  - Then, if it's nice out (`niceOut`: sunny, with the sun at least 8° up), it lies on the patio for a few minutes, and gets up and goes in if the weather turns. Otherwise it goes straight back in.
  - In real life it might be 10–20 outings a day. The map runs on the real clock, so it's sped up to a few an hour, and the cats, squirrels and birds come more often than they would too, so there's something to watch.
- To add a visitor or make a plant attract one, add to `VISITORS` and `attractors()`, and give it a sprite in `CritterSprites.tsx`.

## 3D model (IFC)

*Download IFC model* (map side panel, with nothing selected) saves the map as an IFC4 building model, the open format BIM tools share. Open it in [Bldrs](https://share.bldrs.ai) or any IFC viewer to walk around the house and yard in 3D. `exportIfc` in `src/lib/map/ifc.ts` writes the ISO 10303-21 text itself, with no library.

- **Structure:** an `IfcProject` holds one `IfcSite`: the lot, with the garden's latitude and longitude and true north from the compass. Each house and shed is an `IfcBuilding` with an `IfcBuildingStorey` per floor. Each storey has four `IfcWall`s, named by the way they face ("SSE wall"), and a floor `IfcSlab`. Each door and window is an `IfcOpeningElement` cut through its wall and filled by an `IfcDoor` or `IfcWindow`, and the top storey has the gable `IfcRoof` and gable ends. Everything else is contained in the site under a fitting class:
  - `IfcGeographicElement`: lawn, trees, shrubs, hedges, and each planting in a bed, plus the ground itself
  - `IfcSlab`: patios, paths and driveways
  - `IfcRailing`: fences
  - `IfcDoor` (gate): gates
  - `IfcValve`, `IfcOutlet`, `IfcFlowMeter`, `IfcTank`, `IfcUnitaryEquipment`, `IfcPipeSegment`, `IfcSensor`: water and power fittings
  - `IfcBuildingElementProxy`: the rest
  - Areas are notes on the plan and are left out.
- **Shapes** follow the drawing: same sizes, roof (with its overhang), fence posts, pools (in-ground ones are dug out of the ground, with translucent water) and plants. A bed's plants are the same spots as on the map (`bedPlants`), one element per planting, sized by growth stage; planned and just-sown ones don't show yet. Colors come from the map's palette.
- **Properties:** each element has a "Garden" property set: its kind, size in feet, kind settings (stories, roof rise, fence style…), linked planter, plant and owner, and notes. Plantings carry their plant, bed, status, count and sow date.
- **Units and axes:** metres. The map's y runs south and IFC's Y runs north, so y flips. Each element is placed at its footprint's center and turned (`IfcLocalPlacement`), so a turned shed is a turned building.
- **GlobalIds** are hashed from the entity's ID, so exporting again gives every element the same ID and viewers can match it up.
- To export a new kind: give it a class in `CLASSES` (it defaults to a proxy) and a shape in `SHAPES` (it defaults to its box).

## Interaction

- Drag the background, or anything that isn't selected, to **pan**. That way a lawn can't be dragged away by accident.
- Tap or click something to **select** it (`/map?e=<id>`, so a selection can be linked to). Drag the selected thing to **move** it, its corner handle to **resize** it, or the ⟳ handle off the end of its long side to **turn** it (5° steps, 1° with shift). Moves snap to the site grid. The panel shows the turn, and which way the long side runs by the compass ("Rows run 25° from north, NNE–SSW" for a bed); typing a heading turns the bed to match.
- Scroll, pinch, or the − / + buttons to **zoom**. The buttons zoom in on the selection. *Fit* shows the whole lot.
- *Iso* / *Plan* switch views and ⟲ / ⟳ turn the lot; the ground in the middle of the screen stays put.
- Keyboard (when the map has focus): arrows nudge the selection by the grid step (shift: 1 ft), `[` and `]` turn it 5° (shift: 1°), Delete removes it, Escape clears the selection.
- The side panel edits the selection live (name, position, size, kind settings, links, notes, duplicate, remove). With nothing selected it shows the add palette, layer toggles, a list of everything on the map, and the lot's settings.
- New things land in the nearest clear spot to the middle of the view (`freeSpot`).
- The view (mode, rotation, zoom, center) is remembered per browser in localStorage. It isn't part of the garden.

## Assistant

On the map page, the assistant's context lists the lot and every entity with its ID, kind, position, size, settings and links (plus which one is selected). Its `edit_map` tool adds, updates and removes entities in a batch, so "add a 4×8 bed east of Bed 3 and run a drip line along it" works in one message.

## Where it's headed

The model is meant to grow without migrations: new kinds are data, new settings go in `props`, new relationships in `links`.

- **Irrigation zones.** Valves (`props.zone`) feed sprinklers and drip lines with the same zone. Next: a zone record with a schedule and flow rate, coverage shading from sprinkler radii and drip lines, and checking that every bed is covered. A controller kind (on the house wall, near the outlet) would own the zones and could later be driven from the app.
- **Sensors.** `sensor` entities linked to a bed. Readings would be a new store keyed by sensor ID, shown on the map as badges and fed to the assistant.
- **Robotic cultivation.** `gantry` covers a bed on rails, FarmBot style. Plant positions already come from `bedPlants`, so a gantry can be given exact seeding, watering and weeding coordinates per plant, and per-plant checks (pests, weeds) can become jobs. A `robot-dock` and paths between beds would serve a rover.
- **Sun and shade.** Shadows are drawn for any date and time. Next: shadows falling on raised things (beds, roofs) rather than only the ground, and adding up the hours of direct sun each bed gets over a day or a season, from the same `entityShadow` polygons.
- **Plants on the map.** Tapping a plant dot in a bed could open that plant's check form directly, as on the bed's page.
- **Shapes.** If a box stops being enough (curved beds, a winding path), add an optional `outline` polygon to an entity, used for drawing and hit-testing, with the box kept as its bounding box.
- **Sync.** Entities have `updatedAt` and stable IDs, ready for a future sync or merge between devices.
