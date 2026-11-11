import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordRain, setZone, setZoneRun, type ActionCtx } from "../src/lib/actions.ts";
import { runTool } from "../src/lib/assistant/core.ts";
import { plantingViews } from "../src/lib/garden.ts";
import { bedsWatered, describeTimer, irrigationFor, irrigationZones, lineArea, nextRun, sprayRadius, sprinklerHeads, timerRunsDue, zoneFor, zonesRunning } from "../src/lib/irrigation.ts";
import { lineEnds, lineFromEnds } from "../src/lib/map/geometry.ts";
import { kindDef } from "../src/lib/map/kinds.ts";
import type { MapEntity } from "../src/lib/map/model.ts";
import { siteTemplate } from "../src/lib/map/template.ts";
import { careSchedule } from "../src/lib/schedule.ts";
import { createGarden, exportBackup, importBackup, loadAll, openGardenDb, putRecords } from "../src/lib/store.ts";
import type { GardenData, Planting, Species, Tray, ZoneTimer } from "../src/lib/types.ts";

let n = 0;
const { entities: template } = siteTemplate("2026-10-21", () => `e${n++}`);
const bed = (name: string) => template.find((e) => e.name === name)!;

function head(kind: string, x: number, y: number, extra: Partial<MapEntity> = {}): MapEntity {
  const def = kindDef(kind).defaults;
  return { id: `${kind}-${x}-${y}`, kind, name: def.name, x, y, w: def.w, d: def.d, h: def.h, z: 0, props: { ...(def.props ?? {}) }, links: {}, notes: null, createdAt: "", updatedAt: "", ...extra };
}

test("a sprinkler waters the beds most of which its spray covers", () => {
  // Between Bed 1 (x 8–16) and Bed 2 (x 18–26), 8 ft spray: both, not Bed 3 (x 31–39).
  const s = head("sprinkler", 16.75, 11.75);
  assert.deepEqual(bedsWatered(s, template).map((b) => b.name), ["Bed 1", "Bed 2"]);
  // A 4 ft spray only reaches the near ends: not enough of either.
  assert.deepEqual(bedsWatered({ ...s, props: { ...s.props, radius: 4 } }, template), []);
});

test("a drip line waters the bed it runs through, or the one it's linked to; a valve only a linked bed", () => {
  const drip = head("drip-line", 9, 11.9);
  assert.deepEqual(bedsWatered(drip, template).map((b) => b.name), ["Bed 1"]);
  assert.deepEqual(bedsWatered({ ...drip, links: { entityId: bed("Bed 3").id } }, template).map((b) => b.name), ["Bed 3"]);
  assert.deepEqual(bedsWatered(head("valve", 9, 12), template), []);
  assert.deepEqual(bedsWatered(head("valve", 0, 0, { links: { entityId: bed("Bed 2").id } }), template).map((b) => b.name), ["Bed 2"]);
  // A turned bed: a drip line along where it now lies.
  const turned = { ...bed("Bed 3"), rot: 90 }; // now 4 wide, 8 deep about (35, 11)
  assert.deepEqual(bedsWatered(head("drip-line", 34.9, 7.5, { w: 0.2, d: 7 }), [turned]).map((b) => b.name), ["Bed 3"]);
});

test("zones group their heads, name themselves, and list the planters they water", () => {
  const data = {
    garden: { zones: [{ zone: "2", name: "Back beds", timer: null }] },
    mapEntities: [
      ...template.map((e) => (e.name === "Bed 1" ? { ...e, links: { trayId: "t1" } } : e.name === "Bed 2" ? { ...e, links: { trayId: "t2" } } : e)),
      head("sprinkler", 16.75, 11.75),
      head("drip-line", 32, 10.9, { props: { zone: "2" } }),
      head("valve", 30, 14, { name: "Back valve", props: { zone: "2" } }),
    ],
  } as unknown as GardenData;
  const zones = irrigationZones(data);
  assert.deepEqual(zones.map((z) => [z.zone, z.name, z.what, z.beds.map((b) => b.name)]), [
    ["1", "Zone 1", "sprinklers", ["Bed 1", "Bed 2"]],
    ["2", "Back beds", "drip lines", ["Bed 3"]],
  ]);
  assert.deepEqual(zones[0].trayIds, ["t1", "t2"]);
  assert.equal(zoneFor(zones, "t2")?.zone, "1");
  assert.equal(zoneFor(zones, "nope"), null);
});

const daily = (since: string, extra: Partial<ZoneTimer> = {}): ZoneTimer => ({ days: [0, 1, 2, 3, 4, 5, 6], at: "06:00", since, paused: false, ...extra });
const zoneWith = (timer: ZoneTimer | null) => [{ zone: "1", name: "Zone 1", what: "sprinklers", settings: { zone: "1", name: null, timer }, heads: [], beds: [], trayIds: ["t1"], lines: [] }];

test("timer runs come due from the day it was set, today once the start time passes", () => {
  const zones = zoneWith(daily("2026-10-18"));
  assert.deepEqual(timerRunsDue(zones, [], "2026-10-21", "05:59").map((r) => r.date), ["2026-10-18", "2026-10-19", "2026-10-20"]);
  assert.deepEqual(timerRunsDue(zones, [], "2026-10-21", "06:00").map((r) => r.date), ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
  // Already on record, or marked skipped: not again.
  const have = [{ id: "1:2026-10-19", zone: "1", date: "2026-10-19", source: "skipped" as const, updatedAt: "" }, { id: "1:2026-10-20", zone: "1", date: "2026-10-20", source: "manual" as const, updatedAt: "" }];
  assert.deepEqual(timerRunsDue(zones, have, "2026-10-21", "07:00").map((r) => r.date), ["2026-10-18", "2026-10-21"]);
  // Only its days (2026-10-21 is a Wednesday); nothing while paused; at most a month back.
  assert.deepEqual(timerRunsDue(zoneWith(daily("2026-10-12", { days: [1, 3, 5] })), [], "2026-10-21", "07:00").map((r) => r.date), ["2026-10-12", "2026-10-14", "2026-10-16", "2026-10-19", "2026-10-21"]);
  assert.deepEqual(timerRunsDue(zoneWith(daily("2026-10-18", { paused: true })), [], "2026-10-21", "07:00"), []);
  assert.equal(timerRunsDue(zoneWith(daily("2025-01-01")), [], "2026-10-21", "07:00").length, 31);
  assert.deepEqual(timerRunsDue(zoneWith(null), [], "2026-10-21", "07:00"), []);
});

test("next run and the timer in words", () => {
  assert.equal(nextRun(daily("2026-10-01"), "2026-10-21", "05:00"), "2026-10-21");
  assert.equal(nextRun(daily("2026-10-01"), "2026-10-21", "06:30"), "2026-10-22");
  assert.equal(nextRun(daily("2026-10-01", { days: [1] }), "2026-10-21", "05:00"), "2026-10-26");
  assert.equal(nextRun(daily("2026-10-01", { paused: true }), "2026-10-21", "05:00"), null);
  assert.equal(describeTimer(daily("x")), "Daily at 6:00 AM for 20 min");
  assert.equal(describeTimer(daily("x", { days: [1, 3, 5], at: "18:30", minutes: 45 })), "Mon, Wed, Fri at 6:30 PM for 45 min");
  assert.equal(describeTimer(daily("x", { days: [1, 2, 3, 4, 5] })), "Weekdays at 6:00 AM for 20 min");
  assert.equal(describeTimer(daily("x", { paused: true })), "Timer paused");
  assert.equal(describeTimer(null), "No timer");
});

test("a sprinkler run counts as watering, like rain, and says so; seedlings in beds are kept moist, not misted", () => {
  const base = { status: "growing" as const, sownAt: "2026-10-01", germDaysMin: null, germDaysMax: null, waterEveryDays: 2, milestones: [], events: [{ type: "watered", date: "2026-10-17" }] };
  const water = (extra: object) => careSchedule({ ...base, ...extra }, "2026-10-21").find((c) => c.key === "water")!;
  assert.equal(water({}).status, "overdue");
  const ran = water({ irrigation: [{ date: "2026-10-21", label: "Zone 1 sprinklers" }] });
  assert.equal(ran.status, "upcoming");
  assert.equal(ran.start, "2026-10-23");
  assert.equal(ran.irrigatedOn, "2026-10-21");
  assert.match(ran.detail!, /Zone 1 sprinklers ran today, which counts/);
  // The latest of hand watering, sprinklers and rain wins.
  const rain = water({ irrigation: [{ date: "2026-10-19", label: "Zone 1 sprinklers" }], rain: [{ date: "2026-10-20", inches: 0.4, source: "recorded" }] });
  assert.equal(rain.rainedOn, "2026-10-20");
  assert.equal(rain.irrigatedOn, undefined);
  const seedling = (outdoors: boolean) => careSchedule({ ...base, status: "sown", outdoors }, "2026-10-21").find((c) => c.key === "water")!.title;
  assert.equal(seedling(true), "Keep moist");
  assert.equal(seedling(false), "Keep moist (mist)");
});

// ---------- In a garden ----------

async function garden(name: string) {
  const db = await openGardenDb(name);
  await createGarden(db, { name: "G", timezone: "UTC", gardener: "Pablo" });
  const species = (id: string, commonName: string): Species => ({ id, commonName, waterEveryDays: 2, milestones: [], germDaysMin: null, germDaysMax: null, category: "vegetable", variety: null }) as unknown as Species;
  const tray = (id: string, name: string): Tray => ({ id, name, kind: null, rows: ["A", "B"], cols: 1, notes: null, layout: "rows", position: 1, createdAt: "" });
  const planting = (id: string, speciesId: string, trayId: string): Planting => ({ id, speciesId, trayId, cells: ["1A"], location: null, status: "growing", sownAt: "2026-10-01", sowDateEstimated: false, count: 6, createdAt: "", updatedAt: "" });
  await putRecords(db, "species", [species("beet", "Beet"), species("radish", "Radish"), species("spinach", "Spinach")]);
  await putRecords(db, "trays", [tray("t1", "Beet bed"), tray("t2", "Radish bed")]);
  await putRecords(db, "plantings", [planting("p1", "beet", "t1"), planting("p2", "radish", "t2"), { ...planting("p3", "spinach", "t2"), cells: ["1B"] }]);
  await putRecords(db, "mapEntities", [
    ...template.map((e) => (e.name === "Bed 1" ? { ...e, links: { trayId: "t1" } } : e.name === "Bed 2" ? { ...e, links: { trayId: "t2" } } : e)),
    head("sprinkler", 16.75, 11.75),
  ]);
  const today = "2026-10-21";
  const ctx = async (): Promise<ActionCtx> => ({ db, data: (await loadAll(db))!, by: "Pablo", today });
  return { db, today, ctx };
}

test("one sprinkler run waters the beets in one bed and the radish and spinach in the next", async () => {
  const { db, today, ctx } = await garden("irrigation-garden");
  let views = plantingViews((await ctx()).data, today);
  assert.deepEqual(new Set(views.map((v) => v.zone?.zone)), new Set(["1"]), "all three in zone 1");
  assert.ok(views.every((v) => v.care.find((c) => c.key === "water")!.status !== "upcoming"), "never watered: due");
  await setZoneRun(await ctx(), "1", today, "manual");
  views = plantingViews((await ctx()).data, today);
  for (const v of views) assert.equal(v.care.find((c) => c.key === "water")!.status, "upcoming", v.name);
  // Said it didn't run after all.
  await setZoneRun(await ctx(), "1", today, null);
  assert.equal((await ctx()).data.irrigation.length, 0);
  // Rain still counts; the zone's runs are listed for a planting's history.
  await recordRain(await ctx(), [{ id: "2026-10-20", date: "2026-10-20", inches: 0.5, source: "recorded", updatedAt: "" }]);
  await setZoneRun(await ctx(), "1", "2026-10-19", "manual");
  const data = (await ctx()).data;
  assert.deepEqual(irrigationFor(irrigationZones(data), data.irrigation, "t1", today).map((r) => r.date), ["2026-10-19"]);
  await db.close();
});

test("a zone's name and timer are kept with the garden; a new timer starts today; runs travel in the garden file", async () => {
  const { db, today, ctx } = await garden("irrigation-settings");
  await setZone(await ctx(), "1", { name: "Back beds" });
  await setZone(await ctx(), "1", { timer: { days: [1, 3, 5], at: "06:00", since: "2020-01-01", paused: false } });
  const z = (await ctx()).data.garden.zones!.find((x) => x.zone === "1")!;
  assert.equal(z.name, "Back beds");
  assert.equal(z.timer!.since, today, "runs count from when the timer was set");
  await setZoneRun(await ctx(), "1", today, "skipped");
  const other = await openGardenDb("irrigation-settings-2");
  await importBackup(other, await exportBackup(db));
  const copy = (await loadAll(other))!;
  assert.deepEqual(copy.garden.zones, (await ctx()).data.garden.zones);
  assert.deepEqual(copy.irrigation.map((r) => [r.id, r.source]), [["1:2026-10-21", "skipped"]]);
  await db.close();
  await other.close();
});

test("the assistant records a zone run in one go, and knows the zones", async () => {
  const { db, today, ctx } = await garden("irrigation-assistant");
  const deps = { db, today, gardener: "Pablo", latest: () => cache, act: async <T,>(fn: (c: ActionCtx) => Promise<T>) => fn(await ctx()) };
  let cache = (await ctx()).data;
  const out = await runTool("irrigation_ran", { zone: "1", date: "", ran: "yes" }, deps);
  assert.ok(!out.isError, out.text);
  assert.match(out.text, /Zone 1 sprinklers ran on 2026-10-21.*3 planting\(s\) in Bed 1, Bed 2/);
  cache = (await ctx()).data;
  assert.deepEqual(cache.irrigation.map((r) => [r.zone, r.date, r.source]), [["1", today, "manual"]]);
  assert.ok((await runTool("irrigation_ran", { zone: "9", date: "", ran: "yes" }, deps)).isError);
  // Adding sprinklers on a zone, with a spray radius, through the map tool.
  const added = await runTool("edit_map", { changes: [{ op: "add", id: "", kind: "sprinkler", name: "", x: 33, y: 10, w: null, d: null, h: null, rot: null, link_planter_id: "", zone: "2", radius: 6, notes: "" }] }, deps);
  assert.ok(!added.isError, added.text);
  const s = (await ctx()).data.mapEntities.find((e) => e.kind === "sprinkler" && e.props.zone === "2")!;
  assert.equal(s.props.radius, 6);
  await db.close();
});

test("the assistant records resowing for several existing plantings and restarts their dates", async () => {
  const { db, today, ctx } = await garden("assistant-resowing");
  let cache = (await ctx()).data;
  const deps = { db, today, gardener: "Pablo", latest: () => cache, act: async <T,>(fn: (c: ActionCtx) => Promise<T>) => fn(await ctx()) };
  const out = await runTool("record_resowing", { planting_ids: ["p1", "p2"], date: "" }, deps);
  assert.ok(!out.isError, out.text);
  assert.match(out.text, /care schedules now start from that date/);
  const updated = (await ctx()).data;
  assert.deepEqual(updated.plantings.filter((p) => ["p1", "p2"].includes(p.id)).map((p) => [p.status, p.sownAt, p.sowDateEstimated]), [
    ["sown", today, false],
    ["sown", today, false],
  ]);
  assert.ok((await runTool("record_resowing", { planting_ids: ["p1", "missing"], date: "" }, deps)).isError);
  assert.equal((await ctx()).data.notes.length, 0);
  await db.close();
});

test("a run is placed by its two ends: dragging one end keeps the other where it was", () => {
  const drip = head("drip-line", 9, 11.9); // 8 ft east–west from (9, 12)
  const [a, b] = lineEnds(drip);
  assert.deepEqual(a.map((v) => +v.toFixed(6)), [9, 12]);
  assert.deepEqual(b.map((v) => +v.toFixed(6)), [17, 12]);
  // Drag the east end down to (9, 20): now 8 ft running south, the west end unmoved.
  const moved = { ...drip, ...lineFromEnds(a, [9, 20], 0.2) };
  assert.equal(moved.w, 8);
  assert.equal(moved.rot, 90);
  const [a2, b2] = lineEnds(moved);
  assert.deepEqual(a2.map((v) => +v.toFixed(6)), [9, 12]);
  assert.deepEqual(b2.map((v) => +v.toFixed(6)), [9, 20]);
  // Diagonal across Bed 2 (x 18–26, y 10–14), from corner to corner: it waters that bed.
  const diag = { ...drip, ...lineFromEnds([18.5, 10.5], [25.5, 13.5], 0.2) };
  assert.deepEqual(bedsWatered(diag, template).map((x) => x.name), ["Bed 2"]);
});

test("one drip line run waters just its own bed; the whole zone waters them all", async () => {
  const { db, today, ctx } = await garden("irrigation-line");
  await putRecords(db, "mapEntities", [head("drip-line", 9, 11.9, { id: "drip1", name: "Bed 1 drip" })]);
  const zone = irrigationZones((await ctx()).data)[0];
  assert.deepEqual(zone.lines.map((l) => [l.head.name, l.beds.map((b) => b.name)]), [
    ["Bed 1 drip", ["Bed 1"]],
    ["Sprinkler", ["Bed 1", "Bed 2"]],
  ]);
  await setZoneRun(await ctx(), "1", today, "manual", "drip1");
  const water = (data: GardenData) => new Map(plantingViews(data, today).map((v) => [v.name, v.care.find((c) => c.key === "water")!]));
  let w = water((await ctx()).data);
  assert.equal(w.get("Beet")!.status, "upcoming");
  assert.match(w.get("Beet")!.detail!, /Bed 1 drip \(Zone 1\) ran today/);
  assert.notEqual(w.get("Radish")!.status, "upcoming", "the drip line doesn't reach Bed 2");
  await setZoneRun(await ctx(), "1", today, "manual");
  w = water((await ctx()).data);
  assert.equal(w.get("Radish")!.status, "upcoming");
  // Through the assistant, by line ID.
  const deps = { db, today, gardener: null, latest: () => cache, act: async <T,>(fn: (c: ActionCtx) => Promise<T>) => fn(await ctx()) };
  let cache = (await ctx()).data;
  const out = await runTool("irrigation_ran", { zone: "1", line_id: "drip1", date: "2026-10-20", ran: "yes" }, deps);
  assert.match(out.text, /Bed 1 drip \(Zone 1\) ran on 2026-10-20.*1 planting\(s\) in Bed 1/);
  cache = (await ctx()).data;
  assert.ok(cache.irrigation.some((r) => r.id === "1:2026-10-20:drip1" && r.head === "drip1"));
  assert.ok((await runTool("irrigation_ran", { zone: "1", line_id: "nope", date: "", ran: "yes" }, deps)).isError);
  await db.close();
});

test("a sprinkler line: a head every 18 in, throwing to the edges of its span and a little past", () => {
  // Along Bed 1 (x 8–16, y 10–14): 8 ft long, a 4 ft span.
  const line = head("sprinkler-line", 8, 10, { w: 8, d: 4 });
  const heads = sprinklerHeads(line);
  assert.equal(heads.length, 5);
  assert.deepEqual(heads.map(([x, y]) => [+x.toFixed(2), y]), [[8.8, 12], [10.4, 12], [12, 12], [13.6, 12], [15.2, 12]]);
  assert.equal(sprayRadius(line), 2.3, "half the 4 ft span, 15% over");
  assert.equal(sprayRadius({ ...line, d: 0.25 }), 0.86, "a narrow line still reaches the next head");
  assert.equal(sprayRadius({ ...line, props: { ...line.props, radius: 5 } }), 5, "a set radius wins");
  assert.deepEqual(bedsWatered(line, template).map((b) => b.name), ["Bed 1"]);
  // Run alongside Bed 2's edge with a wide span: its spray covers most of the bed.
  assert.deepEqual(bedsWatered(head("sprinkler-line", 18, 9, { w: 8, d: 6 }), template).map((b) => b.name), ["Bed 2"]);
  // Turned, its heads turn with it.
  const turned = { ...line, rot: 90 };
  assert.ok(sprinklerHeads(turned).every(([x]) => Math.abs(x - 12) < 1e-9));
});

test("a zone is running from its timer's start for its run time, unless that day's run was skipped", () => {
  const zones = zoneWith(daily("2026-10-01", { minutes: 20 }));
  assert.equal(zonesRunning(zones, [], "2026-10-21", "05:59").length, 0);
  assert.equal(zonesRunning(zones, [], "2026-10-21", "06:00").length, 1);
  assert.equal(zonesRunning(zones, [], "2026-10-21", "06:19").length, 1);
  assert.equal(zonesRunning(zones, [], "2026-10-21", "06:20").length, 0);
  assert.equal(zonesRunning(zoneWith(daily("2026-10-01")), [], "2026-10-21", "06:19").length, 1, "20 minutes when not set");
  assert.equal(zonesRunning(zones, [{ id: "1:2026-10-21", zone: "1", date: "2026-10-21", source: "skipped", updatedAt: "" }], "2026-10-21", "06:05").length, 0);
  assert.equal(zonesRunning(zoneWith(daily("2026-10-01", { days: [1] })), [], "2026-10-21", "06:05").length, 0, "not its day");
});

test("the assistant turns a drip line into a sprinkler line in place", async () => {
  const { db, today, ctx } = await garden("irrigation-kind");
  await putRecords(db, "mapEntities", [head("drip-line", 8, 10, { id: "drip1", w: 8, d: 4, props: { zone: "2" } })]);
  const deps = { db, today, gardener: null, latest: () => cache, act: async <T,>(fn: (c: ActionCtx) => Promise<T>) => fn(await ctx()) };
  let cache = (await ctx()).data;
  const out = await runTool("edit_map", { changes: [{ op: "update", id: "drip1", kind: "sprinkler-line", name: "", x: null, y: null, w: null, d: null, h: null, rot: null, link_planter_id: "", zone: "", radius: null, notes: "" }] }, deps);
  assert.ok(!out.isError, out.text);
  cache = (await ctx()).data;
  const e = cache.mapEntities.find((m) => m.id === "drip1")!;
  assert.deepEqual([e.kind, e.x, e.y, e.w, e.d, e.h, e.props.zone, e.props.spacing], ["sprinkler-line", 8, 10, 8, 4, 0.75, "2", 18]);
  assert.deepEqual(irrigationZones(cache).find((z) => z.zone === "2")!.beds.map((b) => b.name), ["Bed 1"]);
  await db.close();
});

test("a drip line covers only the part of a bed its span lies over; one with no span, the whole bed", () => {
  // A long bed, 16 × 4 ft, and a drip line spanning its east half and the south 3 ft.
  const long = head("raised-bed", 0, 0, { id: "long", w: 16, d: 4 });
  const drip = head("drip-line", 8, 1, { w: 8, d: 3 });
  assert.deepEqual(lineArea(drip, long), { a0: 8, a1: 16, c0: 1, c1: 4 });
  assert.deepEqual(bedsWatered(drip, [long]).map((b) => b.id), ["long"]);
  // Hanging past the bed's end: clipped to the bed.
  assert.deepEqual(lineArea({ ...drip, x: 12 }, long), { a0: 12, a1: 16, c0: 1, c1: 4 });
  // No span set (a thin line): the whole bed.
  assert.deepEqual(lineArea({ ...drip, d: 0.2 }, long), { a0: 0, a1: 16, c0: 0, c1: 4 });
  // A bed running north–south: along is its y, across its x.
  const tall = head("raised-bed", 0, 0, { id: "tall", w: 4, d: 16 });
  assert.deepEqual(lineArea(head("drip-line", 1, 8, { w: 3, d: 8 }), tall), { a0: 8, a1: 16, c0: 1, c1: 4 });
});
