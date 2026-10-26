import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildContext } from "../src/lib/assistant/core.ts";
import { plantingViews } from "../src/lib/garden.ts";
import { getPhotoBlob, importBackup, loadAll, openGardenDb, type Backup } from "../src/lib/store.ts";
import type { GardenData } from "../src/lib/types.ts";

// The sample garden is data published next to the app (public/samples/), not part of the app's code.
const sample = JSON.parse(readFileSync(new URL("../public/samples/herb-garden.json", import.meta.url), "utf8")) as Backup;

test("the sample garden is a valid garden file that opens", async () => {
  const db = await openGardenDb("sample-test");
  await importBackup(db, sample);
  const data = (await loadAll(db))!;
  assert.equal(data.garden.name, "Herb Garden");
  assert.ok(data.species.length >= 10);
  assert.ok(data.plantings.length >= 10);
  assert.ok(data.mapEntities.length > 0);
  // Every reference points at something that exists.
  const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));
  const species = ids(data.species);
  const trays = ids(data.trays);
  const plantings = ids(data.plantings);
  for (const p of data.plantings) assert.ok(species.has(p.speciesId) && (!p.trayId || trays.has(p.trayId)), p.id);
  for (const e of [...data.events, ...data.notes]) assert.ok(!e.plantingId || plantings.has(e.plantingId));
  for (const m of data.mapEntities) assert.ok(!m.links.trayId || trays.has(m.links.trayId), m.name);
  for (const ph of data.photos) assert.ok(await getPhotoBlob(db, ph.id), `bytes for ${ph.id}`);
  assert.equal(plantingViews(data, "2026-10-19").length, data.plantings.length);
});

test("the sample carries no assistant chats, gardeners or keys", () => {
  assert.deepEqual(sample.chats ?? [], []);
  assert.deepEqual(sample.data.garden.gardeners, []);
  assert.doesNotMatch(JSON.stringify({ ...sample, photoBlobs: {} }), /sk-ant-|apiKey/i);
});

test("on the home page the assistant sees the map, what's selected on it, and the open tasks", () => {
  const data = structuredClone(sample.data) as GardenData;
  data.tasks.push({ id: "t1", plantingId: null, title: "Order mulch", dueDate: "2026-10-30", doneAt: null, by: "Pablo", byAssistant: false, createdAt: "2026-10-19T00:00:00Z" });
  const bed = data.mapEntities.find((e) => e.name === "Bed 1")!;
  const { text } = buildContext(data, "Pablo", `/?e=${bed.id}`, "2026-10-19");
  assert.match(text, /Viewing: the home page: the garden map/);
  assert.match(text, /Selected: .*Bed 1/);
  assert.match(text, /Open tasks:\n- 2026-10-30: Order mulch/);
  assert.doesNotMatch(buildContext(data, "Pablo", "/map", "2026-10-19").text, /Open tasks/);
});
