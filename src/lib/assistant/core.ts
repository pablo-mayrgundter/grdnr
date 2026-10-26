// What every assistant backend shares: the system prompt, the per-turn context
// built from the page the user is on, and the garden tools with their handlers.

import { z } from "zod";
import { addMapEntity, addNote, addTask, applyTrayLayout, deleteMapEntity, logCare, setZoneRun, trayMarkdown, updateMapEntity, updatePlanting, type ActionCtx } from "../actions.ts";
import { describeTimer, irrigationZones, lineLabel, runId, zoneLabel } from "../irrigation.ts";
import { compassPoint, longSideBearing } from "../map/geometry.ts";
import { KINDS, kindDef } from "../map/kinds.ts";
import { buildingOpenings } from "../map/openings.ts";
import { DEFAULT_SITE, type MapEntity } from "../map/model.ts";
import { addDays, formatDate, isDate } from "../dates.ts";
import { RAIN_WATERS_IN } from "../weather/rain.ts";
import { cellRange, eventsFor, notesFor, photosFor, plantingLabel, plantStates, plantingViews, sortedTrays, tasksFor, type PlantingView } from "../garden.ts";
import { CONDITION_KEYS, CONDITIONS, EVENT_TYPES, PLANTING_STATUSES } from "../model.ts";
import type { CareItem } from "../schedule.ts";
import { blobToBase64, getPhotoBlob, type GardenDB } from "../store.ts";
import type { GardenData, Photo } from "../types.ts";

export const MAX_TOOL_ROUNDS = 8;

// Kept byte-for-byte stable so Claude can cache it; anything that changes per request goes in the user turn.
export const SYSTEM_PROMPT = `You are the garden assistant inside Grdnr, a small, private garden-tracking web app shared by a household of gardeners.

The app tracks:
- Planters: containers of cells (seed trays, egg cartons, pots). Cells are named column number + row letter (1A is top-left; "1-2C" means a planting spanning cells 1C and 2C). Each planter's layout can be written as a markdown table with letters on rows and numbers on columns.
- Plants (the seed library): one entry per seed packet, with the packet's sowing depth, germination days, spacing, watering and harvest info.
- Plantings: a plant sown in particular cells, with a status (planned, sown, sprouted, growing, transplanted, harvesting, done, failed) and a sow date. Some sow dates are estimates.
- Outdoor beds are planted in rows: a planting there has a count (e.g. 18 beets), and its plants are numbered 1…count along the row.
- A care log of events (watered, sprouted, thinned, pinched, fertilized, potted_up, transplanted, harvested, observed, other), notes, photos, and to-do tasks. "observed" records a check on plants with a condition (healthy, pests, disease, nutrients, water, weeds, damage, missing, other), for the whole planting or specific numbered plants.
- A garden map of the whole lot (house, front and back yards): boxes in feet with x east from the lot's west edge, y south from its north edge, w east–west, d north–south, h tall. Each has a kind (raised-bed, fence, fruit-tree, spigot, sprinkler, gantry, …); beds can link to a planter, whose rows are drawn on them.
- Irrigation zones: sprinklers, sprinkler lines (small sprinklers on stakes every 18 in along a hose), drip lines and valves on the map each belong to a zone (their "zone" setting). A zone waters the beds most of which its sprinklers' spray radius covers, that its drip lines and sprinkler lines run through, or that they and valves are linked to. A line's span (its rectangle's width) is how wide it waters; a sprinkler line's heads throw to the span's edges unless a radius is set. A zone can have a timer (days and start time); timer runs are recorded automatically, and people can say it ran. Each run counts as watering for every planting in the zone's beds, the same way rain does.
- A computed care schedule per planting: daily misting while seedlings are in a planter, the germination window from the packet, and packet-based milestones (thinning, first feeding, pinching, transplanting, harvest). Logging the matching event completes a milestone.

Each user message starts with an <app_context> block describing today's date, the page the user is looking at, and current garden data. Treat it as the source of truth about the garden; it reflects the data at the moment the message was sent. Planting, planter and photo IDs appear there in brackets, like [k3x9p2]. Photos can be inspected with view_photo. When a photo is attached, look at it carefully — seedling color, legginess, damping off, mold, overcrowding — and say what you see.

How to help:
- Answer as a knowledgeable, practical gardener. Be specific to this garden's plants, cells, dates and packet instructions rather than generic. Keep answers short and skimmable; use short lists when listing steps.
- When the user tells you something happened ("we watered the tray", "the parsley came up", "thinned the lettuce"), record it with log_care. When they share an observation or ask you to remember something, save it with add_note. When they want a reminder, use create_task. When a sow date or status is wrong, fix it with update_planting. When they plant, move or clear cells, or set up a new planter, rewrite its layout with update_planter_layout, then mark newly sown plantings with update_planting. When they describe or change the layout of the yard (add a bed, move the fence, plan sprinklers), use edit_map. When they say the sprinklers or drip system ran (or didn't), record it once for the zone with irrigation_ran rather than logging a watering for each planting; if the beds' irrigation isn't on the map yet, offer to add it with edit_map (sprinklers with a zone and a spray radius that covers the beds).
- Only record things the user said happened or asked you to record. Never invent care events. If you're unsure which planting they mean, ask.
- After using a tool, briefly confirm what you recorded.
- Wikipedia links and packet info are in the app; you don't need to repeat them unless asked.`;

// ---------- Context ----------

function careLine(c: CareItem): string {
  const when = c.start === c.end ? formatDate(c.start) : `${formatDate(c.start)}–${formatDate(c.end)}`;
  const status = c.status === "done" ? `done ${c.doneOn ? formatDate(c.doneOn) : ""}`.trim() : c.status;
  return `${c.title} (${when}; ${status})`;
}

function plantingSummary(p: PlantingView): string {
  const where = p.trayName ? `${p.trayName} ${cellRange(p.cells)}` : (p.location ?? "no location");
  const sown = p.sownAt ? `sown ${p.sownAt}${p.sowDateEstimated ? " (estimated)" : ""}` : "not sown yet";
  const open = p.care.filter((c) => c.status !== "done" && c.status !== "upcoming").map(careLine);
  const next = p.care.find((c) => c.status === "upcoming");
  return (
    `- [${p.id}] ${p.name}${p.variety ? ` '${p.variety}'` : ""}${p.count ? ` ×${p.count}` : ""} — ${where} — ${p.status}, ${sown}` +
    (open.length ? ` — needs: ${open.join("; ")}` : "") +
    (next ? ` — next: ${careLine(next)}` : "")
  );
}

/** "pests: 3, 4; healthy: 1, 2" from the latest check of each plant. */
function plantCheckSummary(data: GardenData, p: PlantingView): string {
  const by = new Map<string, number[]>();
  plantStates(data, p.id, p.count ?? 0).forEach((s, i) => {
    const key = s ? `${CONDITIONS[s.condition].label.toLowerCase()} (${s.date})` : "not checked";
    by.set(key, [...(by.get(key) ?? []), i + 1]);
  });
  return [...by].map(([k, ns]) => `${k}: ${ns.length === p.count ? "all" : ns.join(", ")}`).join("; ");
}

export function plantingDetail(data: GardenData, p: PlantingView): string {
  const s = p.species;
  const events = eventsFor(data, p.id).slice(0, 25);
  const notes = notesFor(data, p.id).slice(0, 15);
  const photos = photosFor(data, { plantingId: p.id }).slice(0, 20);
  const tasks = tasksFor(data, { plantingId: p.id });
  return [
    `Planting [${p.id}]: ${plantingLabel(p)} — status ${p.status}, ${p.sownAt ? `sown ${p.sownAt}${p.sowDateEstimated ? " (estimated)" : ""}` : "not sown"}`,
    `Plant: ${s.commonName}${s.variety ? ` '${s.variety}'` : ""} (${s.scientificName ?? "?"}), ${s.lifecycle ?? ""} ${s.category}, packet from ${s.source ?? "unknown"}`,
    `Packet data: sow depth ${s.sowDepth ?? "?"}; germination ${s.germDaysMin ?? "?"}–${s.germDaysMax ?? "?"} days; light ${s.light ?? "?"}; height ${s.height ?? "?"}; spread ${s.spread ?? "?"}; spacing ${s.spacing ?? "?"}; soil ${s.soil ?? "?"}; watering ${s.watering ?? "?"}; harvest ${s.harvestDaysMin ?? "?"}–${s.harvestDaysMax ?? "?"} days`,
    s.packetText ? `Packet text: ${s.packetText}` : "",
    s.tips.length ? `Tips: ${s.tips.join(" | ")}` : "",
    `Schedule:\n${p.care.map((c) => `  - ${careLine(c)}`).join("\n") || "  (none)"}`,
    p.count ? `Plants: ${p.count}, numbered 1–${p.count} along the row. Latest checks: ${plantCheckSummary(data, p)}` : "",
    `Care log (newest first):\n${events.map((e) => `  - ${e.date} ${e.type}${e.condition ? ` ${e.condition}` : ""}${e.plants?.length ? ` (plants ${e.plants.join(", ")})` : ""}${e.note ? `: ${e.note}` : ""}${e.by ? ` (${e.by})` : ""}`).join("\n") || "  (empty)"}`,
    `Notes (newest first):\n${notes.map((n) => `  - ${n.createdAt.slice(0, 10)}${n.by ? ` ${n.by}` : ""}${n.byAssistant ? " (assistant)" : ""}: ${n.body}`).join("\n") || "  (none)"}`,
    `Open tasks:\n${tasks.map((t) => `  - ${t.dueDate}: ${t.title}`).join("\n") || "  (none)"}`,
    `Photos (newest first):\n${photos.map((ph) => `  - photo [${ph.id}], ${ph.takenAt}${ph.caption ? `: ${ph.caption}` : ""}`).join("\n") || "  (none)"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

type PageRef = { kind: "dashboard" | "planting" | "tray" | "plant" | "plants" | "settings" | "calendar" | "map" | "other"; id?: string };

export function parsePath(pathname: string): PageRef {
  const m = pathname.match(/^\/(plantings|trays|plants)\/([^/]+)/);
  if (m && m[2] !== "new") return { kind: ({ plantings: "planting", trays: "tray", plants: "plant" } as const)[m[1] as "plantings"], id: decodeURIComponent(m[2]) };
  if (pathname === "/" || pathname === "") return { kind: "dashboard" };
  if (pathname.startsWith("/plants")) return { kind: "plants" };
  if (pathname.startsWith("/settings")) return { kind: "settings" };
  if (pathname.startsWith("/calendar")) return { kind: "calendar" };
  if (pathname.startsWith("/map")) return { kind: "map" };
  return { kind: "other" };
}

/** The per-turn context block plus at most one photo worth attaching. */
export function buildContext(data: GardenData, userName: string | null, location: string, today: string): { text: string; photoId: string | null } {
  const [pathname, search = ""] = location.split("?");
  const page = parsePath(pathname);
  const all = plantingViews(data, today);
  const parts: string[] = [`Today: ${today} (${formatDate(today, { weekday: true })}), garden timezone ${data.garden.timezone}.`, `User: ${userName ?? "unknown"}.`];
  let photoId: string | null = null;
  const pushOpenTasks = () => {
    const tasks = tasksFor(data);
    if (tasks.length) parts.push(`Open tasks:\n${tasks.map((t) => `- ${t.dueDate}: ${t.title}${t.plantingId ? ` (planting [${t.plantingId}])` : ""}`).join("\n")}`);
  };

  if (page.kind === "planting" && page.id) {
    const p = all.find((x) => x.id === page.id);
    if (p) {
      parts.push(`Viewing: the page for planting [${p.id}] (${plantingLabel(p)}).`, plantingDetail(data, p));
      photoId = photosFor(data, { plantingId: p.id, kind: "progress" })[0]?.id ?? null;
    }
  } else if (page.kind === "tray" && page.id) {
    const tray = data.trays.find((t) => t.id === page.id);
    if (tray) {
      const inTray = all.filter((p) => p.trayId === tray.id);
      const grid = tray.rows
        .map((r) =>
          Array.from({ length: tray.cols }, (_, i) => {
            const cell = `${i + 1}${r}`;
            const p = inTray.find((x) => x.cells.includes(cell));
            return `${cell}: ${p ? `${p.name} [${p.id}], ${p.status}` : "empty"}`;
          }).join(" | "),
        )
        .join("\n");
      parts.push(
        `Viewing: the ${tray.name} planter [${tray.id}] (${tray.kind ?? ""}). ${tray.notes ?? ""}`,
        `Layout:\n${grid}`,
        `Layout as markdown (the format update_planter_layout takes):\n${trayMarkdown(data, tray.id)}`,
      );
      const trayPhoto = photosFor(data, { trayId: tray.id })[0];
      if (trayPhoto) {
        photoId = trayPhoto.id;
        parts.push(`Latest planter photo: [${trayPhoto.id}] (${trayPhoto.takenAt}).`);
      }
    }
  } else if (page.kind === "plant" && page.id) {
    const s = data.species.find((x) => x.id === page.id);
    if (s) {
      parts.push(
        `Viewing: the seed library entry for ${s.commonName}${s.variety ? ` '${s.variety}'` : ""} [${s.id}].`,
        `Packet data: ${JSON.stringify({ ...s, milestones: undefined })}`,
      );
      photoId = photosFor(data, { speciesId: s.id, kind: "packet_back" })[0]?.id ?? null;
    }
  } else if (page.kind === "map" || page.kind === "dashboard") {
    // The home page is the map too, with today's care and what's coming up beside it.
    const sel = new URLSearchParams(search).get("e");
    const e = sel ? data.mapEntities.find((m) => m.id === sel) : undefined;
    parts.push(`Viewing: ${page.kind === "map" ? "the garden map" : "the home page: the garden map, with today's care and what's coming up beside it"}.${e ? ` Selected: ${mapEntitySummary(data, e)}` : ""}`, mapSummary(data));
    if (page.kind === "dashboard") pushOpenTasks();
  } else {
    parts.push(`Viewing: the ${page.kind === "other" ? "app" : page.kind} page.`);
    pushOpenTasks();
  }

  parts.push(`Planters: ${sortedTrays(data).map((t) => `${t.name} [${t.id}]`).join(", ")}`);
  const recentRain = (data.rain ?? []).filter((r) => r.date >= addDays(today, -10) && r.date <= today && r.inches >= 0.01).sort((a, b) => a.date.localeCompare(b.date));
  if (recentRain.length)
    parts.push(
      `Rain at the garden, last 10 days (${RAIN_WATERS_IN} in or more counts as watering for outdoor plantings in beds, not for indoor trays): ${recentRain
        .map((r) => `${r.date} ${r.inches.toFixed(2)} in${r.source === "expected" ? ` (expected, ${r.chance ?? "?"}% chance)` : r.source === "gauge" ? " (rain gauge)" : ""}`)
        .join("; ")}`,
    );
  const zones = irrigationZones(data);
  if (zones.length) {
    const runs = (data.irrigation ?? []).filter((r) => r.date >= addDays(today, -10) && r.date <= today).sort((a, b) => a.date.localeCompare(b.date));
    parts.push(
      `Irrigation zones (a run counts as watering for every planting in the zone's beds):\n${zones
        .map((z) => {
          const beds = z.beds.map((b) => `${b.name}${b.links.trayId ? ` (planter [${b.links.trayId}])` : ""}`).join(", ");
          const lines = z.lines.map((l) => `[${l.head.id}] ${l.head.kind} "${l.head.name}" → ${l.beds.map((b) => b.name).join(", ") || "no beds"}`).join("; ");
          const ran = runs
            .filter((r) => r.zone === z.zone)
            .map((r) => `${r.date} ${r.head ? `${z.lines.find((l) => l.head.id === r.head)?.head.name ?? "a line"} only, ` : ""}${r.source === "timer" ? "timer" : r.source === "skipped" ? "skipped" : "logged"}`);
          return `- zone "${z.zone}": ${zoneLabel(z)} — waters ${beds || "no beds yet"}; lines: ${lines}; ${describeTimer(z.settings.timer)}${ran.length ? `; last 10 days: ${ran.join(", ")}` : "; no runs in the last 10 days"}`;
        })
        .join("\n")}`,
    );
  }
  parts.push(`All plantings:\n${all.map(plantingSummary).join("\n")}`);
  return { text: `<app_context>\n${parts.join("\n\n")}\n</app_context>`, photoId };
}


function mapEntitySummary(data: GardenData, e: MapEntity): string {
  const r = (v: number) => +v.toFixed(2);
  const links = [
    e.links.trayId && `planter ${data.trays.find((t) => t.id === e.links.trayId)?.name ?? "?"} [${e.links.trayId}]`,
    e.links.speciesId && `plant ${data.species.find((s) => s.id === e.links.speciesId)?.commonName ?? "?"}`,
    e.links.entityId && `belongs to [${e.links.entityId}]`,
  ].filter(Boolean);
  const props = Object.entries(e.props).filter(([, v]) => v !== null && v !== "");
  if (kindDef(e.kind).openings) {
    const count = (t: string) => buildingOpenings(e).filter((o) => o.type === t).length;
    props.push(["openings", `${count("door")} doors, ${count("window")} windows${count("garage") ? `, ${count("garage")} garage doors` : ""}`]);
  }
  if (e.links.trayId && data.trays.find((t) => t.id === e.links.trayId)?.layout === "rows") {
    const b = Math.round(longSideBearing(e, (data.garden.site ?? DEFAULT_SITE).northDeg));
    props.push(["rows run", `${b}° from true north (${compassPoint(b)}–${compassPoint(b + 180)})`]);
  }
  return `[${e.id}] ${e.kind} "${e.name}" x ${r(e.x)}, y ${r(e.y)}, ${r(e.w)}×${r(e.d)}×${r(e.h)} ft${e.rot ? `, turned ${r(e.rot)}°` : ""}${e.z ? `, raised ${r(e.z)}` : ""}${props.length ? `, ${props.map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}${links.length ? `, ${links.join(", ")}` : ""}${e.notes ? ` — ${e.notes}` : ""}`;
}

function mapSummary(data: GardenData): string {
  const site = data.garden.site ?? DEFAULT_SITE;
  if (!data.mapEntities.length) return `Map: empty (lot ${site.width}×${site.depth} ft).`;
  return `Map (lot ${site.width} ft east–west × ${site.depth} ft north–south, north ${site.northDeg}° clockwise from up):\n${data.mapEntities.map((e) => `- ${mapEntitySummary(data, e)}`).join("\n")}`;
}

// ---------- Tools ----------

export type ToolSpec = { name: string; description: string; properties: Record<string, unknown> };

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "log_care",
    description: "Record care events that the user says happened (e.g. watering the whole tray, seeing sprouts, thinning). One event per planting.",
    properties: {
      planting_ids: { type: "array", items: { type: "string" }, description: "Planting IDs (the [bracketed] IDs in the context)." },
      type: { type: "string", enum: [...EVENT_TYPES] },
      date: { type: "string", description: "YYYY-MM-DD, or empty string for today." },
      note: { type: "string", description: "Optional short detail, or empty string." },
      condition: {
        type: "string",
        enum: ["", ...CONDITION_KEYS],
        description: "For type 'observed' (checking on plants): what was seen. Empty string otherwise.",
      },
      plants: {
        type: "array",
        items: { type: "integer" },
        description: "Specific plant numbers (1-based) within a bed row planting that has a count, e.g. [3, 4]; empty for the whole planting.",
      },
    },
  },
  {
    name: "add_note",
    description: "Save a journal note, for an observation or something the user wants remembered.",
    properties: { planting_id: { type: "string", description: "Planting ID, or empty string for a garden-wide note." }, body: { type: "string" } },
  },
  {
    name: "create_task",
    description: "Create a to-do reminder that shows up on the Today page and calendar on its due date.",
    properties: {
      title: { type: "string" },
      due_date: { type: "string", description: "YYYY-MM-DD" },
      planting_id: { type: "string", description: "Related planting ID, or empty string." },
    },
  },
  {
    name: "update_planting",
    description: "Correct a planting's status and/or sow date.",
    properties: {
      planting_id: { type: "string" },
      status: { type: "string", enum: [...PLANTING_STATUSES, "unchanged"] },
      sown_at: { type: "string", description: "YYYY-MM-DD, or empty string to leave unchanged." },
      sow_date_estimated: { type: "string", enum: ["yes", "no", "unchanged"] },
    },
  },
  {
    name: "update_planter_layout",
    description:
      "Create a planter or rewrite its layout. Pass the whole planter as markdown: a '# Name' heading, an optional one-line description, then a table whose header row is | | 1 | 2 | ... |, a |---| separator row, and one row per letter (| A | Basil | Thyme | ... |). Leave a cell blank when empty; repeat a name in adjacent cells of a row for one planting spanning them. For outdoor beds planted in rows, write the variety and plant count, e.g. 'Beet (Detroit Golden) x 18' (often one column per row). Plants not in the seed library are added to it. New plantings start as 'planned'.",
    properties: {
      planter_id: { type: "string", description: "Planter ID to rewrite, or empty string to create a new planter." },
      markdown: { type: "string" },
    },
  },
  {
    name: "edit_map",
    description:
      "Add, change or remove things on the garden map. Coordinates are feet: x east from the lot's west edge, y south from its north edge; w is east–west size, d north–south, h height (before any turn); rot turns it clockwise about its center. For 'update', fields left null stay as they are; for 'add', null sizes use the kind's defaults. Use 'link_planter_id' to show a planter's rows on a bed.",
    properties: {
      changes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["op", "id", "kind", "name", "x", "y", "w", "d", "h", "rot", "link_planter_id", "zone", "radius", "notes"],
          properties: {
            op: { type: "string", enum: ["add", "update", "remove"] },
            id: { type: "string", description: "Map item ID for update/remove; empty string for add." },
            kind: {
              type: "string",
              enum: ["", ...KINDS.map((k) => k.kind)],
              description: "Kind for add. For update, a new kind changes what the item is in place (e.g. a drip-line into a sprinkler-line), keeping its position, size and zone. Empty string otherwise.",
            },
            name: { type: "string", description: "New name, or empty string to keep / use the default." },
            x: { type: ["number", "null"] },
            y: { type: ["number", "null"] },
            w: { type: ["number", "null"] },
            d: { type: ["number", "null"] },
            h: { type: ["number", "null"] },
            rot: { type: ["number", "null"], description: "Turn about the item's center, degrees clockwise on the plan (0 = square to the lot)." },
            link_planter_id: { type: "string", description: "Planter ID to link, 'none' to unlink, or empty string to leave as is." },
            zone: { type: "string", description: "Irrigation zone for a sprinkler, drip line or valve (e.g. '1'), or empty string to leave as is / use the default '1'." },
            radius: { type: ["number", "null"], description: "A sprinkler's spray radius in feet; null to leave as is / use the default 8." },
            notes: { type: "string", description: "New notes, or empty string to leave as is." },
          },
        },
      },
    },
  },
  {
    name: "irrigation_ran",
    description:
      "Record that an irrigation zone ran (sprinklers or drip) on a day, which counts as watering for every planting in the zone's beds, or that just one of its lines did (it waters only that line's beds); or, with ran 'no', that it didn't (a timer run that was skipped, or a run logged by mistake).",
    properties: {
      zone: { type: "string", description: "The zone, as given in the irrigation zones list (e.g. '1')." },
      line_id: { type: "string", description: "Map item ID of the one drip line or sprinkler that ran, or empty string for the whole zone." },
      date: { type: "string", description: "YYYY-MM-DD, or empty string for today." },
      ran: { type: "string", enum: ["yes", "no"] },
    },
  },
  { name: "get_planting", description: "Get full details (packet info, schedule, care log, notes, photo list) for any planting.", properties: { planting_id: { type: "string" } } },
  { name: "view_photo", description: "Look at one of the garden's photos by ID.", properties: { photo_id: { type: "string" } } },
];

export const MUTATING = new Set(["log_care", "add_note", "create_task", "update_planting", "update_planter_layout", "edit_map", "irrigation_ran"]);

const LogCare = z.object({
  planting_ids: z.array(z.string()).min(1),
  type: z.enum(EVENT_TYPES),
  date: z.string().default(""),
  note: z.string().default(""),
  condition: z.enum(["", ...CONDITION_KEYS]).default(""),
  plants: z.array(z.number().int()).default([]),
});
const AddNote = z.object({ planting_id: z.string().default(""), body: z.string().min(1) });
const CreateTask = z.object({ title: z.string().min(1), due_date: z.string(), planting_id: z.string().default("") });
const UpdatePlanting = z.object({
  planting_id: z.string(),
  status: z.enum([...PLANTING_STATUSES, "unchanged"]).default("unchanged"),
  sown_at: z.string().default(""),
  sow_date_estimated: z.enum(["yes", "no", "unchanged"]).default("unchanged"),
});
const UpdateLayout = z.object({ planter_id: z.string().default(""), markdown: z.string().min(1) });
const num = z.number().finite().nullable().default(null);
const EditMap = z.object({
  changes: z
    .array(
      z.object({
        op: z.enum(["add", "update", "remove"]),
        id: z.string().default(""),
        kind: z.string().default(""),
        name: z.string().default(""),
        x: num,
        y: num,
        w: num,
        d: num,
        h: num,
        rot: num,
        link_planter_id: z.string().default(""),
        zone: z.string().default(""),
        radius: num,
        notes: z.string().default(""),
      }),
    )
    .min(1),
});
const IrrigationRan = z.object({ zone: z.string().min(1), line_id: z.string().default(""), date: z.string().default(""), ran: z.enum(["yes", "no"]).default("yes") });
const PlantingRef = z.object({ planting_id: z.string() });
const PhotoRef = z.object({ photo_id: z.string() });

export type AssistantDeps = {
  db: GardenDB;
  latest: () => GardenData;
  act: <T>(fn: (ctx: ActionCtx) => Promise<T>) => Promise<T>;
  gardener: string | null;
  today: string;
};

/** A tool's outcome: text for the model, a photo to show it (each backend attaches images its own way), and a line for the UI. */
export type ToolOutput = { text: string; photoId?: string; summary: string; isError?: boolean };

export async function runTool(name: string, raw: unknown, deps: AssistantDeps): Promise<ToolOutput> {
  const data = deps.latest();
  const fail = (msg: string): ToolOutput => ({ text: msg, summary: `${name} failed`, isError: true });
  const planting = (id: string) => data.plantings.find((p) => p.id === id);
  const nameOf = (id: string) => data.species.find((s) => s.id === planting(id)?.speciesId)?.commonName ?? "planting";
  try {
    switch (name) {
      case "log_care": {
        const r = LogCare.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        const date = r.data.date || deps.today;
        if (!isDate(date)) return fail("date must be YYYY-MM-DD");
        const n = await deps.act((ctx) =>
          logCare(ctx, {
            plantingIds: r.data.planting_ids,
            type: r.data.type,
            date,
            note: r.data.note,
            condition: r.data.condition || null,
            plants: r.data.plants,
            byAssistant: true,
          }),
        );
        if (n === 0) return fail("None of those planting IDs exist in this garden.");
        return { text: `Logged ${r.data.type} on ${date} for ${n} planting(s).`, summary: `Logged “${r.data.type.replace("_", " ")}” for ${n} planting${n === 1 ? "" : "s"}` };
      }
      case "add_note": {
        const r = AddNote.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        if (r.data.planting_id && !planting(r.data.planting_id)) return fail("Unknown planting ID.");
        await deps.act((ctx) => addNote(ctx, { plantingId: r.data.planting_id || null, body: r.data.body, byAssistant: true }));
        return { text: "Note saved.", summary: `Saved a note${r.data.planting_id ? ` on ${nameOf(r.data.planting_id)}` : ""}` };
      }
      case "create_task": {
        const r = CreateTask.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        if (!isDate(r.data.due_date)) return fail("due_date must be YYYY-MM-DD");
        if (r.data.planting_id && !planting(r.data.planting_id)) return fail("Unknown planting ID.");
        await deps.act((ctx) => addTask(ctx, { plantingId: r.data.planting_id || null, title: r.data.title, dueDate: r.data.due_date, byAssistant: true }));
        return { text: "Task created.", summary: `Added task “${r.data.title}” for ${formatDate(r.data.due_date)}` };
      }
      case "update_planting": {
        const r = UpdatePlanting.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        if (!planting(r.data.planting_id)) return fail("Unknown planting ID.");
        if (r.data.sown_at && !isDate(r.data.sown_at)) return fail("sown_at must be YYYY-MM-DD");
        const patch: Parameters<typeof updatePlanting>[2] = {};
        if (r.data.status !== "unchanged") patch.status = r.data.status;
        if (r.data.sown_at) patch.sownAt = r.data.sown_at;
        if (r.data.sow_date_estimated !== "unchanged") patch.sowDateEstimated = r.data.sow_date_estimated === "yes";
        await deps.act((ctx) => updatePlanting(ctx, r.data.planting_id, patch));
        return { text: "Planting updated.", summary: `Updated ${nameOf(r.data.planting_id)}` };
      }
      case "update_planter_layout": {
        const r = UpdateLayout.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        if (r.data.planter_id && !data.trays.some((t) => t.id === r.data.planter_id)) return fail("Unknown planter ID.");
        const res = await deps.act((ctx) => applyTrayLayout(ctx, r.data.planter_id || null, r.data.markdown));
        const fresh = deps.latest();
        const ids = plantingViews(fresh, deps.today)
          .filter((p) => p.trayId === res.trayId)
          .map((p) => `[${p.id}] ${p.name} ${cellRange(p.cells)} (${p.status})`)
          .join("; ");
        return {
          text: `Planter [${res.trayId}] saved: ${res.added} planned, ${res.moved} moved, ${res.kept} unchanged, ${res.removed} removed, ${res.detached} kept outside the planter because they have history.${res.newPlants.length ? ` Added to the seed library: ${res.newPlants.join(", ")}.` : ""} Plantings now: ${ids || "none"}`,
          summary: `Updated a planter layout (${res.added} new, ${res.moved} moved, ${res.removed + res.detached} removed)`,
        };
      }
      case "edit_map": {
        const r = EditMap.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        const done: string[] = [];
        for (const c of r.data.changes) {
          const current = deps.latest();
          const target = c.id ? current.mapEntities.find((m) => m.id === c.id) : undefined;
          if (c.op !== "add" && !target) return fail(`Unknown map item ID ${c.id}.${done.length ? ` Already done: ${done.join("; ")}` : ""}`);
          if (c.link_planter_id && c.link_planter_id !== "none" && !current.trays.some((t) => t.id === c.link_planter_id)) return fail(`Unknown planter ID ${c.link_planter_id}.`);
          const patch: Partial<MapEntity> = {};
          for (const k of ["x", "y", "w", "d", "h"] as const) if (c[k] != null) patch[k] = k === "x" || k === "y" ? c[k]! : Math.max(0, c[k]!);
          if (c.rot != null) patch.rot = c.rot;
          if (c.name) patch.name = c.name;
          if (c.notes) patch.notes = c.notes;
          if (c.link_planter_id) patch.links = { trayId: c.link_planter_id === "none" ? null : c.link_planter_id };
          const props: MapEntity["props"] = {};
          if (c.zone.trim()) props.zone = c.zone.trim();
          if (c.radius != null) props.radius = Math.max(0, c.radius);
          if (Object.keys(props).length) patch.props = { ...(target?.props ?? kindDef(c.kind).defaults.props ?? {}), ...props };
          if (c.op === "update" && c.kind && c.kind !== target!.kind) {
            // What it is changes; where it is doesn't. The new kind's settings, keeping its zone.
            const def = kindDef(c.kind).defaults;
            patch.kind = c.kind;
            if (c.h == null) patch.h = def.h;
            patch.props = { ...(def.props ?? {}), ...(target!.props.zone != null ? { zone: target!.props.zone } : {}), ...(patch.props ?? {}) };
          }
          if (c.op === "remove") {
            await deps.act((ctx) => deleteMapEntity(ctx, target!.id));
            done.push(`removed ${target!.name}`);
          } else if (c.op === "update") {
            await deps.act((ctx) => updateMapEntity(ctx, target!.id, patch));
            done.push(`updated ${patch.name ?? target!.name} [${target!.id}]`);
          } else {
            if (!c.kind) return fail("kind is required to add a map item.");
            const def = kindDef(c.kind).defaults;
            const at = { x: (c.x ?? 0) + (c.w ?? def.w) / 2, y: (c.y ?? 0) + (c.d ?? def.d) / 2 };
            const id = await deps.act((ctx) => addMapEntity(ctx, c.kind, at, { ...patch, links: patch.links ?? {} }));
            done.push(`added ${patch.name ?? def.name} [${id}]`);
          }
        }
        return { text: `Map updated: ${done.join("; ")}.`, summary: `Updated the map (${done.length} change${done.length === 1 ? "" : "s"})` };
      }
      case "irrigation_ran": {
        const r = IrrigationRan.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        const date = r.data.date || deps.today;
        if (!isDate(date)) return fail("date must be YYYY-MM-DD");
        const zone = irrigationZones(data).find((z) => z.zone === r.data.zone);
        if (!zone) return fail(`There's no zone "${r.data.zone}" on the map. Add sprinklers or drip lines on that zone with edit_map first.`);
        const line = r.data.line_id ? zone.lines.find((l) => l.head.id === r.data.line_id) : undefined;
        if (r.data.line_id && !line) return fail(`[${r.data.line_id}] isn't a drip line or sprinkler on zone "${zone.zone}".`);
        const head = line?.head.id ?? null;
        const label = line ? lineLabel(zone, line) : zoneLabel(zone);
        const beds = line ? line.beds : zone.beds;
        if (r.data.ran === "yes") {
          await deps.act((ctx) => setZoneRun(ctx, zone.zone, date, "manual", head));
          const trays = new Set(beds.map((b) => b.links.trayId));
          const n = data.plantings.filter((p) => p.trayId && trays.has(p.trayId)).length;
          return { text: `Recorded that ${label} ran on ${date}; that counts as watering for the ${n} planting(s) in ${beds.map((b) => b.name).join(", ") || "its beds"}.`, summary: `Recorded a ${label} run` };
        }
        const existing = (data.irrigation ?? []).find((x) => x.id === runId(zone.zone, date, head));
        await deps.act((ctx) => setZoneRun(ctx, zone.zone, date, !head && (existing?.source === "timer" || zone.settings.timer) ? "skipped" : null, head));
        return { text: `Recorded that ${label} didn't run on ${date}.`, summary: `Marked ${label} as not run` };
      }
      case "get_planting": {
        const r = PlantingRef.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        const p = plantingViews(data, deps.today).find((x) => x.id === r.data.planting_id);
        if (!p) return fail("Unknown planting ID.");
        return { text: plantingDetail(data, p), summary: `Looked up ${p.name}` };
      }
      case "view_photo": {
        const r = PhotoRef.safeParse(raw);
        if (!r.success) return fail(`Invalid input: ${r.error.message}`);
        if (!data.photos.some((p) => p.id === r.data.photo_id)) return fail("Unknown photo ID.");
        return { text: `Photo [${r.data.photo_id}] attached.`, photoId: r.data.photo_id, summary: "Looked at a photo" };
      }
      default:
        return fail(`Unknown tool ${name}`);
    }
  } catch (err) {
    return fail((err as Error).message || "That didn't work.");
  }
}

// ---------- Photos ----------

export type ImageData = { mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; base64: string };

export async function photoData(db: GardenDB, photo: Photo | undefined): Promise<ImageData | null> {
  if (!photo) return null;
  let blob: Blob | undefined;
  if (photo.src) {
    const res = await fetch(`${import.meta.env.BASE_URL}${photo.src}`);
    if (res.ok) blob = await res.blob();
  } else blob = await getPhotoBlob(db, photo.id);
  if (!blob) return null;
  return { mime: (blob.type || photo.mime) as ImageData["mime"], base64: await blobToBase64(blob) };
}
