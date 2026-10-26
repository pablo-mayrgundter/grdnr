import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { addPhoto, applyTrayLayout, deletePlanting, deleteTray, logCare, trayMarkdown, type ActionCtx } from "../src/lib/actions.ts";
import { plantingViews } from "../src/lib/garden.ts";
import {
  appendChat,
  createGarden,
  currentThreadId,
  exportBackup,
  getPhotoBlob,
  importBackup,
  loadAll,
  loadChat,
  migrateBundledPhotos,
  openGardenDb,

  type GardenDB,
} from "../src/lib/store.ts";
import type { GardenData } from "../src/lib/types.ts";

const TODAY = "2026-10-17";
let n = 0;
const fresh = () => openGardenDb(`test-${n++}`);
const load = async (db: GardenDB): Promise<GardenData> => (await loadAll(db))!;
const ctxFor = async (db: GardenDB): Promise<ActionCtx> => ({ db, data: await load(db), by: "Pablo", today: TODAY });

const TRAY = `# Seed tray

16-cell seed tray

|   | 1        | 2     | 3    | 4     |
|---|----------|-------|------|-------|
| A | Rosemary | Thyme | Dill | Basil |
| B |          |       |      |       |
| C | Lavender | Lavender |   |       |
`;

async function gardenWithTray() {
  const db = await fresh();
  await createGarden(db, { name: "Test garden", timezone: "UTC", gardener: "Pablo" });
  const r = await applyTrayLayout(await ctxFor(db), null, TRAY);
  const data = await load(db);
  const byName = (name: string) => data.plantings.find((p) => data.species.find((s) => s.id === p.speciesId)?.commonName === name)!;
  return { db, trayId: r.trayId, result: r, byName };
}

test("a new browser has no garden; nothing ships with the app", async () => {
  const db = await fresh();
  assert.equal(await loadAll(db), null);
  await createGarden(db, { name: "Mine", timezone: "UTC", gardener: "Sam" });
  const data = await load(db);
  assert.equal(data.garden.name, "Mine");
  assert.deepEqual(data.garden.gardeners, ["Sam"]);
  assert.equal(data.species.length + data.trays.length + data.plantings.length + data.photos.length, 0);
});

test("a markdown layout creates the planter, plants and planned plantings", async () => {
  const { db, result, byName } = await gardenWithTray();
  const data = await load(db);
  assert.equal(data.trays[0].name, "Seed tray");
  assert.equal(data.trays[0].kind, "16-cell seed tray");
  assert.deepEqual(data.trays[0].rows, ["A", "B", "C"]);
  assert.equal(result.added, 5);
  assert.deepEqual(result.newPlants.sort(), ["Basil", "Dill", "Lavender", "Rosemary", "Thyme"]);
  assert.deepEqual(byName("Lavender").cells, ["1C", "2C"]);
  assert.equal(byName("Basil").status, "planned");
});

test("re-applying a layout keeps, moves, removes and detaches plantings", async () => {
  const { db, trayId, byName } = await gardenWithTray();
  const thyme = byName("Thyme");
  const dill = byName("Dill");
  const basil = byName("Basil");
  await logCare(await ctxFor(db), { plantingIds: [dill.id], type: "watered" });
  const edited = TRAY.replace("| A | Rosemary | Thyme    | Dill | Basil |", "| A | Rosemary |          |      |       |")
    .replace("| A | Rosemary | Thyme | Dill | Basil |", "| A | Rosemary |  |  |  |")
    .replace("| B |          |       |      |       |", "| B | Thyme | Basil | Mint |  |");
  const r = await applyTrayLayout(await ctxFor(db), trayId, edited);
  const data = await load(db);
  assert.equal(r.kept, 2, "rosemary and lavender unchanged");
  assert.equal(r.added, 3, "thyme and basil moved rows, so they're new plantings; mint is new");
  assert.equal(r.removed, 2, "old thyme and basil had no history");
  assert.equal(r.detached, 1, "dill has a care log, so it's kept outside the planter");
  assert.ok(!data.plantings.some((p) => p.id === thyme.id || p.id === basil.id));
  const keptDill = data.plantings.find((p) => p.id === dill.id)!;
  assert.equal(keptDill.trayId, null);
  assert.match(keptDill.location!, /Was in Seed tray 3A/);
  assert.ok(data.species.some((s) => s.commonName === "Mint"));
  // The markdown written back out round-trips.
  assert.match(trayMarkdown(data, trayId), /\| B +\| Thyme +\| Basil +\| Mint +\| +\|/);
});

test("moving a planting within its row keeps its history", async () => {
  const { db, trayId, byName } = await gardenWithTray();
  const basil = byName("Basil");
  await logCare(await ctxFor(db), { plantingIds: [basil.id], type: "sprouted" });
  const r = await applyTrayLayout(await ctxFor(db), trayId, TRAY.replace("| A | Rosemary | Thyme | Dill | Basil |", "| A | Rosemary | Thyme | Dill | Basil |").replace("| B |          |       |      |       |", "| B |  |  |  | Basil |").replace("| A | Rosemary | Thyme | Dill | Basil |", "| A | Rosemary | Thyme | Dill |  |"));
  const moved = (await load(db)).plantings.find((p) => p.id === basil.id)!;
  assert.equal(r.moved, 0, "different row and no overlap means a new planting");
  assert.equal(moved.trayId, null, "old basil had history, so it's kept outside");
});

test("bad markdown explains what's wrong", async () => {
  const db = await fresh();
  await createGarden(db, { name: "x", timezone: "UTC", gardener: null });
  await assert.rejects(applyTrayLayout(await ctxFor(db), null, "| | 1 |\n|---|---|\n| A | Basil |"), /heading/);
  await assert.rejects(applyTrayLayout(await ctxFor(db), null, "# T\n\n| | 1 | 3 |\n|---|---|---|\n| A | Basil | |"), /number the columns/);
});

test("logging sprouts advances status and the schedule", async () => {
  const { db, byName } = await gardenWithTray();
  const dill = byName("Dill");
  await logCare(await ctxFor(db), { plantingIds: [dill.id], type: "sprouted", date: TODAY });
  const view = plantingViews(await load(db), TODAY).find((p) => p.id === dill.id)!;
  assert.equal(view.status, "sprouted");
});

test("deleting a planting or a planter cleans up", async () => {
  const { db, trayId, byName } = await gardenWithTray();
  const basil = byName("Basil");
  await deletePlanting(await ctxFor(db), basil.id);
  assert.ok(!(await load(db)).plantings.some((p) => p.id === basil.id));
  await logCare(await ctxFor(db), { plantingIds: [byName("Thyme").id], type: "watered" });
  await deleteTray(await ctxFor(db), trayId);
  const data = await load(db);
  assert.equal(data.trays.length, 0);
  assert.deepEqual(data.plantings.map((p) => p.trayId), [null], "only thyme (with history) survives, outside any planter");
});

test("photos from the first version are copied into the browser", async () => {
  const db = await fresh();
  await createGarden(db, { name: "x", timezone: "UTC", gardener: null });
  await (await import("../src/lib/store.ts")).putRecords(db, "photos", [
    { id: "p1", plantingId: null, speciesId: null, trayId: null, kind: "progress", caption: null, takenAt: TODAY, mime: "image/webp", src: "seed/cell-1A.webp", by: null, createdAt: TODAY },
  ]);
  assert.equal(await migrateBundledPhotos(db, async () => null), 0, "unreachable files are retried later");
  assert.equal(await migrateBundledPhotos(db, async (src) => new Blob([src], { type: "image/webp" })), 1);
  const [photo] = (await load(db)).photos;
  assert.equal(photo.src, null);
  assert.equal(await (await getPhotoBlob(db, "p1"))!.text(), "seed/cell-1A.webp");
});

test("a garden file round-trips records, photos and chats", async () => {
  const { db: src, byName } = await gardenWithTray();
  const ctx = await ctxFor(src);
  await logCare(ctx, { plantingIds: [byName("Thyme").id], type: "thinned", note: "kept 3" });
  await addPhoto(ctx, { plantingId: byName("Thyme").id, speciesId: null, trayId: null, kind: "progress", caption: "day 10", takenAt: TODAY }, new Blob([new Uint8Array([1, 2, 3, 250])], { type: "image/jpeg" }));
  const thread = await currentThreadId(src, "ollama");
  await appendChat(src, { threadId: thread, provider: "ollama", role: "user", content: [{ role: "user", content: "hi" }], display: { text: "hi" }, createdAt: TODAY });
  const backup = JSON.parse(JSON.stringify(await exportBackup(src)));
  assert.equal(backup.version, 2);

  const dst = await fresh();
  await createGarden(dst, { name: "Other", timezone: "UTC", gardener: null });
  await importBackup(dst, backup);
  const data = await load(dst);
  assert.equal(data.garden.name, "Test garden");
  assert.ok(data.events.some((e) => e.type === "thinned" && e.note === "kept 3"));
  const uploaded = data.photos.find((p) => p.caption === "day 10")!;
  assert.deepEqual([...new Uint8Array(await (await getPhotoBlob(dst, uploaded.id))!.arrayBuffer())], [1, 2, 3, 250]);
  assert.equal(await currentThreadId(dst, "ollama"), thread);
  assert.equal((await loadChat(dst, thread))[0].display?.text, "hi");
  await assert.rejects(importBackup(dst, { nope: true } as never), /isn't a Grdnr garden file/);
});

test("version 1 garden files still import", async () => {
  const db = await fresh();
  const v1 = {
    app: "herb-garden",
    version: 1,
    exportedAt: TODAY,
    data: { garden: { id: "garden", name: "Old", timezone: "UTC", gardeners: [], createdAt: TODAY }, species: [], trays: [], plantings: [], events: [], notes: [], photos: [], tasks: [] },
    photoBlobs: {},
  };
  await importBackup(db, v1 as never);
  assert.equal((await load(db)).garden.name, "Old");
});
