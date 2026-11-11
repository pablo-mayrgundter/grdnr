import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, daysBetween } from "../src/lib/dates.ts";
import { careSchedule, wateringInterval, type ScheduleInput } from "../src/lib/schedule.ts";
import type { Milestone } from "../src/lib/model.ts";

// Lettuce as printed on a Botanical Interests packet: up in 5–10 days, thin at 1/2", 68–82 days to maturity.
const lettuce = {
  germDaysMin: 5,
  germDaysMax: 10,
  waterEveryDays: 1,
  milestones: [
    { key: "thin", title: 'Thin when ~1/2" tall', from: "sprouted", dayMin: 3, dayMax: 7, event: "thinned" },
    { key: "feed", title: "First light feeding (half-strength)", from: "sprouted", dayMin: 14, dayMax: 21, event: "fertilized" },
    { key: "transplant", title: "Harden off & transplant", from: "sown", dayMin: 28, dayMax: 42, event: "transplanted" },
    { key: "harvest", title: "Harvest heads", from: "sown", dayMin: 68, dayMax: 82, event: "harvested" },
  ] satisfies Milestone[],
};
const base = (over: Partial<ScheduleInput> = {}): ScheduleInput => ({
  status: "sown",
  sownAt: "2026-10-05",
  germDaysMin: lettuce.germDaysMin,
  germDaysMax: lettuce.germDaysMax,
  waterEveryDays: lettuce.waterEveryDays,
  milestones: lettuce.milestones,
  events: [],
  ...over,
});
const byKey = (items: ReturnType<typeof careSchedule>, key: string) => items.find((i) => i.key === key)!;

test("date helpers", () => {
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(daysBetween("2026-10-05", "2026-10-14"), 9);
});

test("planned plantings only ask to be sown", () => {
  const items = careSchedule(base({ status: "planned", sownAt: null }), "2026-10-14");
  assert.deepEqual(items.map((i) => i.key), ["sow"]);
});

test("watering is due when never watered, then follows the interval", () => {
  assert.equal(byKey(careSchedule(base(), "2026-10-14"), "water").status, "due");
  const watered = base({ events: [{ type: "watered", date: "2026-10-14" }] });
  const w = byKey(careSchedule(watered, "2026-10-14"), "water");
  assert.equal(w.status, "upcoming");
  assert.equal(w.start, "2026-10-15");
  assert.equal(byKey(careSchedule(watered, "2026-10-17"), "water").status, "overdue");
});

test("seedlings are misted daily; established plants use the species cadence", () => {
  assert.equal(wateringInterval({ status: "sprouted", waterEveryDays: 4 }), 1);
  assert.equal(wateringInterval({ status: "transplanted", waterEveryDays: 4 }), 4);
});

test("germination window and late warning", () => {
  assert.equal(byKey(careSchedule(base(), "2026-10-08"), "sprout").status, "upcoming");
  assert.equal(byKey(careSchedule(base(), "2026-10-12"), "sprout").status, "due");
  assert.equal(byKey(careSchedule(base(), "2026-10-30"), "sprout").status, "late");
  const up = careSchedule(base({ status: "sprouted", events: [{ type: "sprouted", date: "2026-10-11" }] }), "2026-10-30");
  assert.equal(byKey(up, "sprout").status, "done");
});

test("sprout-relative milestones wait for sprouts and complete on the matching event", () => {
  assert.equal(careSchedule(base(), "2026-10-14").find((i) => i.key === "thin"), undefined);
  const sprouted = base({ status: "sprouted", events: [{ type: "sprouted", date: "2026-10-10" }] });
  const thin = byKey(careSchedule(sprouted, "2026-10-14"), "thin");
  assert.equal(thin.start, "2026-10-13");
  assert.equal(thin.status, "due");
  const thinned = { ...sprouted, events: [...sprouted.events, { type: "thinned", date: "2026-10-14" }] };
  assert.equal(byKey(careSchedule(thinned, "2026-10-20"), "thin").status, "done");
});

test("resowing starts a fresh schedule and ignores care events from the previous crop", () => {
  const resown = base({
    sownAt: "2026-10-11",
    events: [
      { type: "watered", date: "2026-10-05" },
      { type: "sprouted", date: "2026-10-10" },
      { type: "thinned", date: "2026-10-10" },
    ],
  });
  const items = careSchedule(resown, "2026-10-11");
  assert.equal(byKey(items, "water").status, "due");
  assert.equal(byKey(items, "sprout").start, "2026-10-16");
  assert.equal(byKey(items, "sprout").status, "upcoming");
  assert.equal(items.find((i) => i.key === "thin"), undefined);
});
