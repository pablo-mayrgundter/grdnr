import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { ActionButton, TrayGrid } from "@/components/ui";
import { addMapEntity, applySiteTemplate, createPlanterForEntity, deleteMapEntity, setSite, setZone, setZoneRun, updateGarden, updateMapEntity } from "@/lib/actions";
import { bedsWatered, DEFAULT_RUN_MINUTES, describeTimer, IRRIGATION_KINDS, irrigationZones, lastRun, ranWhen, runId, WATER_LINES, zoneLabel, zoneOf, zonesRunning } from "@/lib/irrigation";
import { timeIn, todayIn } from "@/lib/dates";
import { coverPhotos, plantingViews, sortedSpecies, sortedTrays } from "@/lib/garden";
import { useGarden } from "@/lib/GardenContext";
import {
  compassPoint,
  entityProjector,
  footprintBounds,
  freeSpot,
  lineEnds,
  lineFromEnds,
  longSideBearing,
  makeProjector,
  normDeg,
  paintOrder,
  resizeFromCorner,
  rotForBearing,
  siteBounds,
  snap,
  turn,
  unprojectDelta,
  type Projector,
  type Rot,
  type Vec2,
  type ViewMode,
} from "@/lib/map/geometry";
import { KINDS, kindDef, type FieldDef } from "@/lib/map/kinds";
import { DEFAULT_SITE, LAYER_KEYS, LAYERS, type Layer, type MapEntity, type Opening, type Site, type Wall } from "@/lib/map/model";
import { drawEntity, MapPatterns, PAL } from "@/lib/map/render";
import { Critters } from "@/components/Critters";
import { formatTemp, prefersFahrenheit, type DayForecast, type Sky } from "@/lib/weather/forecast";
import { useForecast } from "@/lib/weather/useWeather";
import { buildingOpenings, clampOpening, newOpening, placeOpening, wallLine, WALLS } from "@/lib/map/openings";
import { CITIES, CITY_REGIONS, nearestCity, parseLatLng } from "@/lib/map/places";
import { exportIfc, fileSlug } from "@/lib/map/ifc";
import { DOG_COATS } from "@/lib/map/pets";
import { newId } from "@/lib/store";
import type { Pet, ZoneTimer } from "@/lib/types";
import { downloadFile } from "@/lib/download";
import { entityShadow, gardenLocation, shadowShape, sunFrom, sunGroundDirection, sunPosition, type SunPosition } from "@/lib/map/sun";

type View = { mode: ViewMode; rot: Rot; zoom: number; cx: number; cy: number };
type Draft = { id: string; x: number; y: number; w: number; d: number; rot?: number; openings?: Opening[] };
type Drag =
  | { type: "pan"; sx: number; sy: number; view: View; moved: boolean; selectId: string | null }
  | { type: "move" | "resize" | "rotate"; sx: number; sy: number; entity: MapEntity; moved: boolean }
  | { type: "end"; sx: number; sy: number; entity: MapEntity; end: 0 | 1; moved: boolean }
  | { type: "span"; sx: number; sy: number; entity: MapEntity; moved: boolean }
  | { type: "compass"; sx: number; sy: number; moved: boolean }
  | { type: "opening"; sx: number; sy: number; entity: MapEntity; openingId: string; moved: boolean };

/** Where the compass sits, from the map's bottom-right corner. */
const COMPASS_INSET = 40;

const VIEW_KEY = "garden.mapView";
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 80;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

function readView(): Partial<View> {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function writeView(v: View) {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    // Private mode: the view just isn't remembered.
  }
}

function fitView(pj: Projector, width: number, height: number): Pick<View, "zoom" | "cx" | "cy"> {
  const b = siteBounds(pj);
  const zoom = clampZoom(Math.min(width / (b.maxX - b.minX), height / (b.maxY - b.minY)) * 0.92);
  return { zoom, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
}


/**
 * The map page, or with `home` the home page: the same map with the home page's heading, and its column beside the map in place of the map tools.
 * Either way, selecting something on the map puts its editor in that column.
 */
export function MapPage({ home }: { home?: { head: ReactNode; side: ReactNode } }) {
  const { data, today, act } = useGarden();
  const savedSite: Site = data.garden.site ?? DEFAULT_SITE;
  // While the compass is being turned, north follows it before it's saved.
  const [northDraft, setNorthDraft] = useState<number | null>(null);
  const site = useMemo(() => (northDraft == null ? savedSite : { ...savedSite, northDeg: northDraft }), [savedSite, northDraft]);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("e");
  const select = useCallback(
    (id: string | null) =>
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          if (id) n.set("e", id);
          else n.delete("e");
          return n;
        },
        { replace: true },
      ),
    [setParams],
  );

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>(() => ({ mode: "iso", rot: 1, zoom: 0, cx: 0, cy: 0, ...readView() }));
  const [hidden, setHidden] = useState<Set<Layer>>(new Set());
  /** Full screen: the map fills the window, and the screen where the browser allows it. Esc or the button leaves. */
  const [full, setFull] = useState(false);
  const enterFull = () => {
    setFull(true);
    try {
      void Promise.resolve(document.documentElement.requestFullscreen?.()).catch(() => {});
    } catch {
      // Filling the window is enough.
    }
  };
  const leaveFull = useCallback(() => {
    setFull(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);
  useEffect(() => {
    if (!full) return;
    const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && leaveFull();
    // The browser's own Esc (or its exit button) leaves its full screen without a key event reaching the page.
    const onChange = () => !document.fullscreenElement && setFull(false);
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, [full, leaveFull]);
  // Leaving the page leaves full screen too.
  useEffect(() => () => void (document.fullscreenElement && document.exitFullscreen().catch(() => {})), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  /** The door or window being edited on the selected building. */
  const [openingSel, setOpeningSel] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);

  const pj = useMemo(() => makeProjector(view.mode, view.rot, site), [view.mode, view.rot, site]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: Math.max(200, entry.contentRect.width), h: Math.max(200, entry.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // First visit (or a forgotten view): fit the lot to the screen.
  useEffect(() => {
    if (view.zoom === 0 && size.w) setView((v) => ({ ...v, ...fitView(pj, size.w, size.h) }));
  }, [view.zoom, pj, size.w, size.h]);

  useEffect(() => {
    if (view.zoom) writeView(view);
  }, [view]);

  const toScreen = useCallback((sx: number, sy: number): [number, number] => [(sx - view.cx) * view.zoom + size.w / 2, (sy - view.cy) * view.zoom + size.h / 2], [view, size]);
  const toScene = useCallback((px: number, py: number): [number, number] => [(px - size.w / 2) / view.zoom + view.cx, (py - size.h / 2) / view.zoom + view.cy], [view, size]);

  const zoomAt = useCallback(
    (px: number, py: number, factor: number) =>
      setView((v) => {
        const zoom = clampZoom(v.zoom * factor);
        // Keep the scene point under the cursor where it is.
        const sx = (px - size.w / 2) / v.zoom + v.cx;
        const sy = (py - size.h / 2) / v.zoom + v.cy;
        return { ...v, zoom, cx: sx - (px - size.w / 2) / zoom, cy: sy - (py - size.h / 2) / zoom };
      }),
    [size],
  );

  // Wheel zoom needs a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(ev.clientX - r.left, ev.clientY - r.top, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /** Changes the projection while keeping the same spot of ground in the middle of the screen. */
  const reproject = (mode: ViewMode, rot: Rot) => {
    const [wx, wy] = pj.unproject(view.cx, view.cy);
    const next = makeProjector(mode, rot, site);
    const [cx, cy] = next.p(wx, wy);
    setView((v) => ({ ...v, mode, rot, cx, cy }));
  };

  const entities = useMemo(() => {
    const list = data.mapEntities.map((e) => (draft && draft.id === e.id ? { ...e, ...draft } : e)).filter((e) => !hidden.has(kindDef(e.kind).layer));
    // A drip line over a bed is drawn on the bed (right after it), not under it on the ground.
    const dripBeds = new Map(list.filter((e) => WATER_LINES.has(e.kind)).map((e) => [e.id, bedsWatered(e, list)]));
    const overBed = (e: MapEntity) => (dripBeds.get(e.id)?.length ?? 0) > 0;
    const flat = list.filter((e) => kindDef(e.kind).flat && !overBed(e)).sort((a, b) => LAYERS[kindDef(a.kind).layer].order - LAYERS[kindDef(b.kind).layer].order || b.w * b.d - a.w * a.d);
    const ordered = paintOrder(pj, list.filter((e) => !kindDef(e.kind).flat));
    const after = new Map<string, MapEntity[]>();
    for (const e of list.filter(overBed)) {
      const beds = new Set(dripBeds.get(e.id)!.map((b) => b.id));
      const last = ordered.findLast((x) => beds.has(x.id));
      if (last) after.set(last.id, [...(after.get(last.id) ?? []), e]);
    }
    const solid = ordered.flatMap((e) => [e, ...(after.get(e.id) ?? [])]);
    return { flat, solid, all: [...flat, ...solid] };
  }, [data.mapEntities, draft, hidden, pj]);

  const selected = entities.all.find((e) => e.id === selectedId) ?? null;
  useEffect(() => setOpeningSel(null), [selectedId]);

  // ---------- Sun and shadows ----------

  const [clock, setClock] = useState<{ live: boolean; at: number }>({ live: true, at: Date.now() });
  const [shadows, setShadows] = useState(true);
  useEffect(() => {
    if (!clock.live) return;
    const t = setInterval(() => setClock({ live: true, at: Date.now() }), 30_000);
    return () => clearInterval(t);
  }, [clock.live]);
  const when = new Date(clock.at);

  // ---------- Watering ----------

  /** Sprinklers and lines shown spraying for a little while after they're run or watched from the Watering panel. */
  const [watching, setWatching] = useState<{ ids: string[]; until: number } | null>(null);
  useEffect(() => {
    if (!watching) return;
    const t = setTimeout(() => setWatching(null), Math.max(0, watching.until - Date.now()));
    return () => clearTimeout(t);
  }, [watching]);
  const watch = useCallback((ids: string[]) => setWatching({ ids, until: Date.now() + 20_000 }), []);
  // What's running at the map's clock: zones whose timer is on, live or scrubbed to.
  const spraying = useMemo(() => {
    const zones = irrigationZones(data);
    const tz = data.garden.timezone;
    const on = new Set(zonesRunning(zones, data.irrigation ?? [], todayIn(tz, when), timeIn(tz, when)).flatMap((z) => z.heads.map((h) => h.id)));
    for (const id of watching?.ids ?? []) on.add(id);
    return on;
  }, [data, watching, clock.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const where = gardenLocation(site, when);
  const sun = sunPosition(when, where.lat, where.lon);

  // ---------- Weather and wildlife ----------

  const [wildlife, setWildlife] = useState(true);
  const forecast = useForecast();
  /** A forecast day being shown on the map: its sky while the clock is on that day. */
  const [sim, setSim] = useState<{ date: string; sky: Sky; wind: number | null } | null>(null);
  useEffect(() => {
    if (clock.live) setSim(null);
  }, [clock.live]);
  const sky: Sky = sim && localDate(when) === sim.date ? sim.sky : "sun";
  const sway = (sky === "rain" ? 2.2 : sky === "snow" ? 1.4 : 1) * (sim?.wind && sim.wind >= 15 ? 1.6 : 1);
  const shadowOpacity = { sun: 0.2, cloud: 0.06, rain: 0, snow: 0.05 }[sky];
  const pickDay = (day: DayForecast) => {
    if (sim?.date === day.date) return setClock({ live: true, at: Date.now() });
    // Same time of day, on that day.
    const d = new Date(clock.at);
    const [y, m, dd] = day.date.split("-").map(Number);
    d.setFullYear(y, m - 1, dd);
    setClock({ live: false, at: d.getTime() });
    setSim({ date: day.date, sky: day.sky, wind: day.wind });
  };

  const shadowPaths = useMemo(() => {
    if (!shadows || sun.altitude <= 0 || !shadowOpacity) return "";
    return entities.solid
      .filter((e) => !kindDef(e.kind).flat)
      .map((e) => entityShadow(e, shadowShape(e.kind, kindDef(e.kind).flat), sun, site.northDeg))
      .filter((poly): poly is [number, number][] => !!poly && poly.length > 2)
      .map((poly) => poly.map(([x, y], i) => `${i ? "L" : "M"}${pj.p(x, y, 0.03).map((v) => v.toFixed(3)).join(" ")}`).join(" ") + " Z")
      .join(" ");
  }, [shadows, shadowOpacity, sun.altitude, sun.azimuth, entities.solid, site.northDeg, pj]);

  // ---------- Pointer handling ----------

  const localPoint = (ev: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  const startDrag = (ev: RPointerEvent, d: Drag) => {
    svgRef.current?.setPointerCapture(ev.pointerId);
    drag.current = d;
  };

  const onPointerDown = (ev: RPointerEvent<SVGSVGElement>) => {
    // No text selection or native dragging while panning; keep keyboard focus for nudging.
    ev.preventDefault();
    svgRef.current?.focus({ preventScroll: true });
    const pt = localPoint(ev);
    pointers.current.set(ev.pointerId, pt);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: view.zoom };
      drag.current = null;
      return;
    }
    const target = (ev.target as Element).closest("[data-handle], [data-id]");
    const handle = target?.getAttribute("data-handle");
    const id = target?.getAttribute("data-id") ?? null;
    if (handle === "opening" && selected) {
      const openingId = target!.getAttribute("data-opening")!;
      setOpeningSel(openingId);
      startDrag(ev, { type: "opening", sx: pt.x, sy: pt.y, entity: selected, openingId, moved: false });
    } else if (handle === "compass") {
      startDrag(ev, { type: "compass", sx: pt.x, sy: pt.y, moved: false });
    } else if ((handle === "resize" || handle === "rotate") && selected) {
      startDrag(ev, { type: handle, sx: pt.x, sy: pt.y, entity: selected, moved: false });
    } else if (handle === "span" && selected) {
      startDrag(ev, { type: "span", sx: pt.x, sy: pt.y, entity: selected, moved: false });
    } else if ((handle === "end-0" || handle === "end-1") && selected) {
      startDrag(ev, { type: "end", sx: pt.x, sy: pt.y, entity: selected, end: handle === "end-0" ? 0 : 1, moved: false });
    } else if (id && id === selectedId && selected) {
      startDrag(ev, { type: "move", sx: pt.x, sy: pt.y, entity: selected, moved: false });
    } else {
      // Dragging anything that isn't selected pans, so a lawn can't be moved by accident.
      startDrag(ev, { type: "pan", sx: pt.x, sy: pt.y, view, moved: false, selectId: id });
    }
  };

  const onPointerMove = (ev: RPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(ev.pointerId)) {
      // Just hovering (a mouse with no button down): label whatever is under the pointer.
      if (ev.pointerType === "mouse") {
        const id = (ev.target as Element).closest("[data-id]")?.getAttribute("data-id") ?? null;
        if (id !== hoverId) setHoverId(id);
      }
      return;
    }
    const pt = localPoint(ev);
    pointers.current.set(ev.pointerId, pt);
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const factor = (pinch.current.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.dist)) / view.zoom;
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, factor);
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = pt.x - d.sx;
    const dy = pt.y - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.type === "pan") {
      setView({ ...d.view, cx: d.view.cx - dx / d.view.zoom, cy: d.view.cy - dy / d.view.zoom });
      return;
    }
    if (d.type === "compass") {
      // Point the N arrow at the pointer: turn that screen direction back into a direction on the ground.
      const vx = pt.x - (size.w - COMPASS_INSET);
      const vy = pt.y - (size.h - COMPASS_INSET);
      if (Math.hypot(vx, vy) < 6) return;
      const [gx, gy] = unprojectDelta(pj, vx, vy);
      const deg = (Math.atan2(gx, -gy) * 180) / Math.PI;
      setNorthDraft((((Math.round(deg) % 360) + 360) % 360));
      return;
    }
    if (d.type === "opening") {
      // Slide the door or window to the wall spot nearest the pointer, in the building's own (unturned) frame.
      const e = d.entity;
      const [gx, gy] = pj.unproject(...toScene(pt.x, pt.y));
      const cx = e.x + e.w / 2;
      const cy = e.y + e.d / 2;
      const [lx, ly] = turn(gx - cx, gy - cy, -(e.rot ?? 0));
      const list = buildingOpenings(e);
      const openings = list.map((o) => (o.id === d.openingId ? placeOpening(e, o, cx + lx, cy + ly, (v) => snap(v, 0.5)) : o));
      setDraft({ id: e.id, x: e.x, y: e.y, w: e.w, d: e.d, rot: e.rot, openings });
      return;
    }
    const [wx, wy] = unprojectDelta(pj, dx / view.zoom, dy / view.zoom);
    const e = d.entity;
    const g = site.gridFt;
    if (d.type === "span") {
      // The span (how wide the line waters) grows and shrinks evenly about the line, its ends staying put.
      const [a, b] = lineEnds(e);
      const [gx, gy] = pj.unproject(...toScene(pt.x, pt.y));
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const off = Math.abs(((gx - a[0]) * (b[1] - a[1]) - (gy - a[1]) * (b[0] - a[0])) / len);
      setDraft({ id: e.id, ...lineFromEnds(a, b, Math.max(0.1, snap(off * 2, Math.max(g, 0.25)))) });
    } else if (d.type === "end") {
      // One end follows the pointer (on the grid); the other stays put.
      const ends = lineEnds(e);
      const moving = ends[d.end];
      const target: Vec2 = [snap(moving[0] + wx, g), snap(moving[1] + wy, g)];
      const fixed = ends[1 - d.end];
      setDraft({ id: e.id, ...(d.end === 1 ? lineFromEnds(fixed, target, Math.min(e.w, e.d)) : lineFromEnds(target, fixed, Math.min(e.w, e.d))) });
    } else if (d.type === "move") {
      setDraft({ id: e.id, x: snap(e.x + wx, g), y: snap(e.y + wy, g), w: e.w, d: e.d, rot: e.rot });
    } else if (d.type === "resize") {
      const next = resizeFromCorner(e, wx, wy, (v) => snap(v, g), Math.max(g, 0.25));
      if (kindDef(e.kind).round) {
        // A canopy stays round: its spread follows the larger of the two, about the same corner.
        const s = Math.max(next.w, next.d);
        setDraft({ id: e.id, ...resizeFromCorner(e, s - e.w, s - e.d), rot: e.rot });
      } else {
        setDraft({ id: e.id, ...next, rot: e.rot });
      }
    } else {
      // Turn so the handle follows the pointer: 5° steps, 1° with shift.
      const [gx, gy] = pj.unproject(...toScene(pt.x, pt.y));
      const angle = (Math.atan2(gy - (e.y + e.d / 2), gx - (e.x + e.w / 2)) * 180) / Math.PI - (e.w >= e.d ? 0 : 90);
      const step = ev.shiftKey ? 1 : 5;
      setDraft({ id: e.id, x: e.x, y: e.y, w: e.w, d: e.d, rot: normDeg(Math.round(angle / step) * step) });
    }
  };

  const onPointerUp = (ev: RPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(ev.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.type === "pan") {
      if (!d.moved) select(d.selectId);
      return;
    }
    if (d.type === "compass") {
      if (northDraft != null) act((ctx) => setSite(ctx, { ...savedSite, northDeg: northDraft })).finally(() => setNorthDraft(null));
      return;
    }
    if (d.moved && draft) {
      const { id, ...geom } = draft;
      act((ctx) => updateMapEntity(ctx, id, geom)).finally(() => setDraft(null));
    }
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (!selected) return;
    if (ev.key === "Escape") return openingSel ? setOpeningSel(null) : select(null);
    if ((ev.key === "Delete" || ev.key === "Backspace") && openingSel && kindDef(selected.kind).openings) {
      ev.preventDefault();
      const rest = buildingOpenings(selected).filter((o) => o.id !== openingSel);
      setOpeningSel(null);
      act((ctx) => updateMapEntity(ctx, selected.id, { openings: rest }));
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      ev.preventDefault();
      if (confirm(`Remove ${selected.name} from the map?`)) act((ctx) => deleteMapEntity(ctx, selected.id)).then(() => select(null));
      return;
    }
    // [ and ] turn the selection (5°, or 1° with shift).
    if ((ev.key === "[" || ev.key === "]" || ev.key === "{" || ev.key === "}") && kindDef(selected.kind).resizable) {
      ev.preventDefault();
      const step = (ev.shiftKey ? 1 : 5) * (ev.key === "[" || ev.key === "{" ? -1 : 1);
      act((ctx) => updateMapEntity(ctx, selected.id, { rot: normDeg((selected.rot ?? 0) + step) }));
      return;
    }
    // Arrows nudge along the ground grid as it's drawn (diagonals in the isometric view).
    const dir = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, [number, number]>)[ev.key];
    if (!dir) return;
    ev.preventDefault();
    const step = ev.shiftKey ? 1 : Math.max(site.gridFt, 0.25);
    const [ax, ay] = pj.fromR(dir[0] * step, dir[1] * step);
    const [bx, by] = pj.fromR(0, 0);
    act((ctx) => updateMapEntity(ctx, selected.id, { x: selected.x + ax - bx, y: selected.y + ay - by }));
  };

  // ---------- Adding things ----------

  const add = async (kind: string) => {
    const [wx, wy] = pj.unproject(view.cx, view.cy);
    const def = kindDef(kind);
    const { w, d } = def.defaults;
    // Ground covers (lawn, paths, areas) go anywhere and don't get in the way; anything else, a pool included, needs clear ground.
    const cover = (k: typeof def) => k.flat && (k.layer === "ground" || k.layer === "annotation");
    const taken = cover(def) ? [] : data.mapEntities.filter((e) => !cover(kindDef(e.kind))).map(footprintBounds);
    const spot = freeSpot(taken, site, wx, wy, w, d, Math.max(site.gridFt, 0.5));
    const id = await act((ctx) => addMapEntity(ctx, kind, { x: spot.x + w / 2, y: spot.y + d / 2 }, { x: spot.x, y: spot.y }));
    if (hidden.has(kindDef(kind).layer)) setHidden((h) => new Set([...h].filter((l) => l !== kindDef(kind).layer)));
    select(id);
  };

  /** The zoom buttons zoom in on the selected thing, bringing it to the middle, or else on the middle of the view. */
  const zoomBy = (factor: number) => {
    if (!selected) return zoomAt(size.w / 2, size.h / 2, factor);
    const [cx, cy] = pj.p(selected.x + selected.w / 2, selected.y + selected.d / 2, selected.z);
    setView((v) => ({ ...v, cx, cy, zoom: clampZoom(v.zoom * factor) }));
  };

  /** Selects something and brings it into the middle of the view. */
  const focusOn = (e: MapEntity) => {
    const [sx, sy] = pj.p(e.x + e.w / 2, e.y + e.d / 2, e.z);
    setView((v) => ({ ...v, cx: sx, cy: sy }));
    select(e.id);
  };

  const empty = data.mapEntities.length === 0;
  const ctx = { pj, data, today, zoom: view.zoom || 1, sunShadows: shadows && sun.altitude > 0, selectedOpening: openingSel, spraying };
  // Night: shade the whole scene, fading in through twilight.
  const night = Math.min(1, Math.max(0, -sun.altitude / 8)) * 0.42;
  const transform = `translate(${size.w / 2 - view.cx * view.zoom} ${size.h / 2 - view.cy * view.zoom}) scale(${view.zoom || 1})`;
  const lot: [number, number, number][] = [
    [0, 0, 0],
    [site.width, 0, 0],
    [site.width, site.depth, 0],
    [0, site.depth, 0],
  ];
  const lotPath = lot.map((q, i) => `${i ? "L" : "M"}${pj.p(q[0], q[1], q[2]).join(" ")}`).join(" ") + " Z";
  const gridStep = view.zoom > 14 ? 1 : view.zoom > 4 ? 5 : 10;

  return (
    <>
      {home ? (
        home.head
      ) : (
        <div className="page-head">
          <div>
            <h1>Garden map</h1>
            <p className="sub">The whole lot, house and yards. Drag to pan, scroll or pinch to zoom, tap something to select it, then drag it to move.</p>
          </div>
        </div>
      )}

      <div className={`map-layout ${home ? "home" : ""} ${full ? "full" : ""}`}>
        <div className="map-main">
        <div className="map-wrap card" ref={wrapRef}>
          <svg
            ref={svgRef}
            className={`map-svg ${wildlife ? "" : "still"}`}
            style={{ "--sway": sway } as React.CSSProperties}
            width={size.w}
            height={size.h}
            tabIndex={0}
            role="application"
            aria-label="Garden map"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setHoverId(null)}
            onKeyDown={onKeyDown}
          >
            <MapPatterns />
            <rect width={size.w} height={size.h} fill="var(--map-bg)" />
            <g transform={transform}>
              <path d={lotPath} fill={PAL.paper} stroke={PAL.ink} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <Grid pj={pj} site={site} step={gridStep} />
              {entities.flat.map((e) => (
                <g key={e.id} data-id={e.id} className={`ent ent-${e.kind}`}>
                  {drawEntity(e, ctx)}
                </g>
              ))}
              {shadowPaths && (
                <>
                  <clipPath id="lot-clip">
                    <path d={lotPath} />
                  </clipPath>
                  <path d={shadowPaths} fill="#1d2440" fillOpacity={shadowOpacity} pointerEvents="none" clipPath="url(#lot-clip)" />
                </>
              )}
              {sky === "snow" && <path d={lotPath} fill="#fbfdff" fillOpacity={0.55} pointerEvents="none" />}
              {entities.solid.map((e) => (
                <g key={e.id} data-id={e.id} className={`ent ent-${e.kind}`}>
                  {drawEntity(e, ctx)}
                </g>
              ))}
              <Critters pj={pj} entities={entities.all} data={data} site={site} sun={sun} sky={sky} zoom={view.zoom || 1} enabled={wildlife && !empty} />
              {selected && <Selection pj={pj} e={selected} zoom={view.zoom || 1} resizable={kindDef(selected.kind).resizable ?? false} openingSel={openingSel} />}
            </g>
            <WeatherFx sky={sky} w={size.w} h={size.h} />
            {shadows && <Sun pj={pj} site={site} sun={sun} toScreen={toScreen} w={size.w} h={size.h} dim={sky !== "sun"} />}
            {night > 0 && <rect width={size.w} height={size.h} fill="#141b3c" fillOpacity={night} pointerEvents="none" />}
            <Labels entities={entities.all} pj={pj} toScreen={toScreen} hoverId={drag.current ? null : hoverId} selectedId={selectedId} />
            <Compass pj={pj} site={site} x={size.w - COMPASS_INSET} y={size.h - COMPASS_INSET} turning={northDraft != null} />
          </svg>

          <div className="map-toolbar">
            <div className="seg">
              <button className={view.mode === "iso" ? "on" : ""} onClick={() => reproject("iso", view.rot)} title="Isometric view">Iso</button>
              <button className={view.mode === "plan" ? "on" : ""} onClick={() => reproject("plan", view.rot)} title="Top-down plan">Plan</button>
            </div>
            <div className="seg">
              <button onClick={() => reproject(view.mode, ((view.rot + 3) % 4) as Rot)} title="Turn left">⟲</button>
              <button onClick={() => reproject(view.mode, ((view.rot + 1) % 4) as Rot)} title="Turn right">⟳</button>
            </div>
            <div className="seg">
              <button onClick={() => zoomBy(1 / 1.4)} title="Zoom out">−</button>
              <button onClick={() => zoomBy(1.4)} title="Zoom in">+</button>
              <button onClick={() => setView((v) => ({ ...v, ...fitView(pj, size.w, size.h) }))} title="Fit the lot">Fit</button>
            </div>
            <div className="seg">
              <button onClick={full ? leaveFull : enterFull} title={full ? "Leave full screen (Esc)" : "Full screen"} aria-label={full ? "Leave full screen" : "Full screen"}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d={full ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"} />
                </svg>
              </button>
            </div>
          </div>

          <SunClock
            clock={clock}
            setClock={setClock}
            sun={sun}
            approximate={where.approximate}
            shadows={shadows}
            setShadows={setShadows}
            wildlife={wildlife}
            setWildlife={setWildlife}
            sim={sim && sky === sim.sky ? sim : null}
          />

          {empty && (
            <div className="map-empty card">
              <h3>Lay out your place</h3>
              <p className="small muted">Start from a typical lot (house, front and back yards, fence, three raised beds, water and power on the side of the house) and drag things to match, or start with an empty {site.width} × {site.depth} ft lot.</p>
              <div className="row">
                <button className="primary" onClick={() => act(applySiteTemplate)}>Start from a typical lot</button>
                <button onClick={() => act((c) => setSite(c, site))}>Empty lot</button>
              </div>
            </div>
          )}
        </div>
        <ForecastStrip forecast={forecast} picked={sim?.date ?? null} onPick={pickDay} />
        </div>

        {/* In full screen only a selection's editor shows, floating over the map. */}
        {(!full || selected) && (
          <aside className="map-panel stack">
            {selected ? (
              <EntityPanel key={selected.id} e={selected} onClose={() => select(null)} onSelect={select} openingSel={openingSel} setOpeningSel={setOpeningSel} />
            ) : home ? (
              home.side
            ) : (
              <>
                {!empty && <WateringPanel onSelect={select} onAdd={add} onWatch={watch} />}
                <section className="card">
                  <h3>Add to the map</h3>
                  <p className="small muted">Added in the middle of the view; drag it into place.</p>
                  {LAYER_KEYS.map((l) => (
                    <div key={l} className="palette-group">
                      <div className="small muted">{LAYERS[l].label}</div>
                      <div className="palette">
                        {KINDS.filter((k) => k.layer === l).map((k) => (
                          <button key={k.kind} className="small" onClick={() => add(k.kind)} title={k.description}>
                            {k.icon} {k.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
                <section className="card">
                  <h3>Layers</h3>
                  <div className="layer-toggles">
                    {LAYER_KEYS.map((l) => (
                      <label key={l} className="check">
                        <input
                          type="checkbox"
                          checked={!hidden.has(l)}
                          onChange={(ev) => setHidden((h) => { const n = new Set(h); if (ev.target.checked) n.delete(l); else n.add(l); return n; })}
                        />
                        {LAYERS[l].label}
                      </label>
                    ))}
                  </div>
                </section>
                {!empty && (
                  <section className="card">
                    <details>
                      <summary>Everything on the map ({data.mapEntities.length})</summary>
                      <ul className="ent-list">
                        {[...data.mapEntities]
                          .sort((a, b) => LAYERS[kindDef(a.kind).layer].order - LAYERS[kindDef(b.kind).layer].order || a.name.localeCompare(b.name))
                          .map((e) => (
                            <li key={e.id}>
                              <button className="ghost small" onClick={() => focusOn(e)}>{kindDef(e.kind).icon} {e.name}</button>
                            </li>
                          ))}
                      </ul>
                    </details>
                  </section>
                )}
                {!empty && <PetsPanel />}
                {!empty && <ExportPanel />}
                <SitePanel site={site} />
              </>
            )}
          </aside>
        )}
      </div>
    </>
  );
}

// ---------- Map overlays ----------

function Grid({ pj, site, step }: { pj: Projector; site: Site; step: number }) {
  const lines: string[] = [];
  for (let x = step; x < site.width; x += step) lines.push(`M${pj.p(x, 0).join(" ")} L${pj.p(x, site.depth).join(" ")}`);
  for (let y = step; y < site.depth; y += step) lines.push(`M${pj.p(0, y).join(" ")} L${pj.p(site.width, y).join(" ")}`);
  return <path d={lines.join(" ")} stroke={PAL.ink} strokeOpacity={0.08} strokeWidth={1} vectorEffect="non-scaling-stroke" fill="none" pointerEvents="none" />;
}

function Selection({ pj: base, e, zoom, resizable, openingSel }: { pj: Projector; e: MapEntity; zoom: number; resizable: boolean; openingSel: string | null }) {
  // Through the entity's own projector, so the outline and handles turn with it.
  const pj = entityProjector(base, e);
  const ring = (z: number) => [pj.p(e.x, e.y, z), pj.p(e.x + e.w, e.y, z), pj.p(e.x + e.w, e.y + e.d, z), pj.p(e.x, e.y + e.d, z)].map((q, i) => `${i ? "L" : "M"}${q.join(" ")}`).join(" ") + " Z";
  const [hx, hy] = pj.p(e.x + e.w, e.y + e.d, e.z);
  // The turn handle sits off the end of the long side.
  const off = 24 / zoom;
  const alongX = e.w >= e.d;
  const [ex, ey] = pj.p(alongX ? e.x + e.w : e.x + e.w / 2, alongX ? e.y + e.d / 2 : e.y + e.d, e.z);
  const [tx, ty] = pj.p(alongX ? e.x + e.w + off : e.x + e.w / 2, alongX ? e.y + e.d / 2 : e.y + e.d + off, e.z);
  const line = kindDef(e.kind).line;
  // Big, high-contrast knobs: a white halo under an accent ring, so they show on any ground.
  const knob = (x: number, y: number, r: number, fill: string) => (
    <>
      <circle cx={x} cy={y} r={r + 3 / zoom} fill="#fff" fillOpacity={0.9} />
      <circle cx={x} cy={y} r={r} fill={fill} stroke={PAL.accent} strokeWidth={3} vectorEffect="non-scaling-stroke" />
    </>
  );
  return (
    <g pointerEvents="none">
      <path d={ring(e.z)} fill={PAL.accent} fillOpacity={0.12} stroke={PAL.accent} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeDasharray="6 3" />
      {pj.mode === "iso" && e.h > 0.5 && <path d={ring(e.z + e.h)} fill="none" stroke={PAL.accent} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      {line && WATER_LINES.has(e.kind) && (() => {
        // A square knob on the side, for how wide a span the line waters.
        const [a, b] = lineEnds(e);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const half = Math.min(e.w, e.d) / 2;
        const [sx, sy] = base.p((a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * half, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * half, e.z);
        const r = 8 / zoom;
        return (
          <g data-handle="span" pointerEvents="all" style={{ cursor: "ew-resize" }}>
            <title>Drag to set how wide a span it waters</title>
            <rect x={sx - r - 3 / zoom} y={sy - r - 3 / zoom} width={(r + 3 / zoom) * 2} height={(r + 3 / zoom) * 2} rx={3 / zoom} fill="#fff" fillOpacity={0.9} />
            <rect x={sx - r} y={sy - r} width={r * 2} height={r * 2} rx={2 / zoom} fill="#fff" stroke={PAL.accent} strokeWidth={3} vectorEffect="non-scaling-stroke" />
            <text x={sx} y={sy} fontSize={11 / zoom} textAnchor="middle" dominantBaseline="central" fill={PAL.accent} fontWeight={700}>↔</text>
          </g>
        );
      })()}
      {line &&
        lineEnds(e).map(([x, y], i) => {
          // The ends are on the lot already turned, so through the plain projector.
          const [sx, sy] = base.p(x, y, e.z);
          return (
            <g key={i} data-handle={`end-${i}`} pointerEvents="all" style={{ cursor: "move" }}>
              <title>Drag this end</title>
              {knob(sx, sy, 10 / zoom, i ? PAL.accent : "#fff")}
            </g>
          );
        })}
      {resizable && !line && (
        <>
          <line x1={ex} y1={ey} x2={tx} y2={ty} stroke={PAL.accent} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          <g data-handle="rotate" pointerEvents="all" style={{ cursor: "grab" }}>
            <title>Drag to turn ([ and ] keys too)</title>
            {knob(tx, ty, 10 / zoom, PAL.accent)}
            <text x={tx} y={ty} fontSize={13 / zoom} fill="#fff" textAnchor="middle" dominantBaseline="central">⟳</text>
          </g>
          <g data-handle="resize" pointerEvents="all" style={{ cursor: "nwse-resize" }}>
            <title>Drag to resize</title>
            {knob(hx, hy, 9 / zoom, "#fff")}
          </g>
        </>
      )}
      {kindDef(e.kind).openings &&
        buildingOpenings(e).map((o) => {
          // A tab on the ground just outside each door and window: drag it along (or around) the walls.
          const l = wallLine(e, o.wall);
          const out = 12 / zoom;
          const along = o.offset + o.width / 2;
          const [ox, oy] = pj.p(l.x + l.dx * along + l.nx * out, l.y + l.dy * along + l.ny * out, 0);
          const [wx, wy] = pj.p(l.x + l.dx * along, l.y + l.dy * along, 0);
          const sel = o.id === openingSel;
          const r = (sel ? 8 : 6.5) / zoom;
          return (
            <g key={o.id} data-handle="opening" data-opening={o.id} pointerEvents="all" style={{ cursor: "grab" }}>
              <title>{`${OPENING_LABEL[o.type]}: drag along the walls`}</title>
              <line x1={wx} y1={wy} x2={ox} y2={oy} stroke={PAL.accent} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <rect x={ox - r} y={oy - r} width={r * 2} height={r * 2} rx={r * 0.35} fill={sel ? PAL.accent : "#fff"} stroke={PAL.accent} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
              <text x={ox} y={oy} fontSize={r * 1.2} textAnchor="middle" dominantBaseline="central" fill={sel ? "#fff" : PAL.accent} fontWeight={700}>
                {o.type === "window" ? "W" : o.type === "door" ? "D" : "G"}
              </text>
            </g>
          );
        })}
    </g>
  );
}

/**
 * The sun, at the edge of the map in the direction of its real place in the
 * sky (out past the lot that way, raised by its altitude), with its altitude.
 */
function Sun({ pj, site, sun, toScreen, w, h, dim }: { pj: Projector; site: Site; sun: SunPosition; toScreen: (x: number, y: number) => [number, number]; w: number; h: number; dim?: boolean }) {
  if (sun.altitude < -1) return null;
  const R = Math.max(site.width, site.depth) * 0.62;
  const [ux, uy] = sunGroundDirection(sun, site.northDeg);
  const lift = R * 0.55 * Math.sin((Math.max(0, sun.altitude) * Math.PI) / 180);
  const [tx, ty] = toScreen(...pj.p(site.width / 2 + ux * R, site.depth / 2 + uy * R, lift));
  const [ox, oy] = toScreen(...pj.p(site.width / 2, site.depth / 2, 0));
  const dx = tx - ox || 1e-6;
  const dy = ty - oy;
  // Out from the middle of the map, in that direction, to just inside its edge.
  const m = 34;
  const t = Math.min(Math.abs((w / 2 - m) / dx), dy ? Math.abs((h / 2 - m) / dy) : Infinity);
  const sx = w / 2 + dx * t;
  const sy = h / 2 + dy * t;
  const r = 12;
  const color = sun.altitude < 8 ? "#f08a3c" : "#f6b93b";
  return (
    <g pointerEvents="none" className="map-sun" opacity={dim ? 0.35 : 1}>
      <title>{`Sun ${Math.round(sun.altitude)}° up, from the ${sunFrom(sun.azimuth)}`}</title>
      <circle cx={sx} cy={sy} r={r * 2.3} fill={color} fillOpacity={0.2} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return <line key={i} x1={sx + Math.cos(a) * r * 1.35} y1={sy + Math.sin(a) * r * 1.35} x2={sx + Math.cos(a) * r * 1.85} y2={sy + Math.sin(a) * r * 1.85} stroke={color} strokeWidth={2} strokeLinecap="round" />;
      })}
      <circle cx={sx} cy={sy} r={r} fill={color} stroke="#c47a12" strokeWidth={1} />
      <text x={sx} y={sy + r * 2.3 + 10} textAnchor="middle" className="sun-label">{Math.max(0, Math.round(sun.altitude))}°</text>
    </g>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The map's clock: live by default; drag through the day (or pick a date) to see the shadows move. */
function SunClock({
  clock,
  setClock,
  sun,
  approximate,
  shadows,
  setShadows,
  wildlife,
  setWildlife,
  sim,
}: {
  clock: { live: boolean; at: number };
  setClock: (c: { live: boolean; at: number }) => void;
  sun: SunPosition;
  approximate: boolean;
  shadows: boolean;
  setShadows: (on: boolean) => void;
  wildlife: boolean;
  setWildlife: (on: boolean) => void;
  sim: { date: string; sky: Sky } | null;
}) {
  const at = new Date(clock.at);
  const minutes = at.getHours() * 60 + at.getMinutes();
  const set = (d: Date) => setClock({ live: false, at: d.getTime() });
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div className="map-clock">
      <div className="row small clock-head">
        <label className="check" title="Sun and shadows">
          <input type="checkbox" checked={shadows} onChange={(e) => setShadows(e.target.checked)} /> ☀️
        </label>
        <label className="check" title="Birds, butterflies and cats, and trees in the breeze">
          <input type="checkbox" checked={wildlife} onChange={(e) => setWildlife(e.target.checked)} /> 🐦
        </label>
        <strong>{time}</strong>
        <span className="muted sun-text">
          {sun.altitude > 0 ? `sun ${Math.round(sun.altitude)}° up, from the ${sunFrom(sun.azimuth)}` : "sun down"}
        </span>
        {clock.live ? <span className="live-dot" title="Following the real time">live</span> : (
          <button className="ghost small" onClick={() => setClock({ live: true, at: Date.now() })}>Now</button>
        )}
      </div>
      {shadows && (
        <div className="row small">
          <input
            type="range"
            min={0}
            max={1439}
            step={5}
            value={minutes}
            aria-label="Time of day"
            onChange={(e) => {
              const m = Number(e.target.value);
              const d = new Date(clock.at);
              d.setHours(Math.floor(m / 60), m % 60, 0, 0);
              set(d);
            }}
          />
          <input
            type="date"
            value={localDate(at)}
            aria-label="Date"
            onChange={(e) => {
              const [y, mo, da] = e.target.value.split("-").map(Number);
              if (!y) return;
              const d = new Date(clock.at);
              d.setFullYear(y, mo - 1, da);
              set(d);
            }}
          />
        </div>
      )}
      {sim && <div className="small">Showing the forecast: {SKY_WORDS[sim.sky]}</div>}
      {shadows && approximate && <div className="small muted">Location guessed from your time zone; set it under The lot.</div>}
    </div>
  );
}

const SKY_WORDS: Record<Sky, string> = { sun: "☀️ sun", cloud: "☁️ clouds", rain: "🌧️ rain", snow: "🌨️ snow" };

/** Rain, snow or clouds over the scene, in screen space so they keep falling at the same size at any zoom. */
function WeatherFx({ sky, w, h }: { sky: Sky; w: number; h: number }) {
  if (sky === "sun") return null;
  const tint = { cloud: ["#5d6678", 0.12], rain: ["#34445a", 0.24], snow: ["#eef3f8", 0.16] }[sky] as [string, number];
  return (
    <g className="weather-fx" pointerEvents="none">
      <defs>
        <pattern id="fx-rain" width={46} height={64} patternUnits="userSpaceOnUse">
          {[[6, 4], [22, 30], [36, 12], [14, 48], [40, 44]].map(([x, y], i) => (
            <line key={i} x1={x} y1={y} x2={x - 4} y2={y + 14} stroke="#d5e4f2" strokeOpacity={0.75} strokeWidth={1.2} strokeLinecap="round" />
          ))}
        </pattern>
        <pattern id="fx-snow" width={90} height={90} patternUnits="userSpaceOnUse">
          {[[10, 12, 2.2], [45, 30, 1.6], [70, 8, 2.6], [25, 60, 1.8], [62, 70, 2.2], [84, 48, 1.5], [38, 84, 2]].map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} fill="#fff" fillOpacity={0.95} />
          ))}
        </pattern>
      </defs>
      <rect width={w} height={h} fill={tint[0]} fillOpacity={tint[1]} />
      {sky === "cloud" &&
        [0, 1, 2].map((i) => (
          <ellipse key={i} className={`cloud-shadow c${i}`} cx={w * (0.2 + i * 0.3)} cy={h * (0.3 + (i % 2) * 0.35)} rx={w * 0.22} ry={h * 0.16} fill="#1d2440" fillOpacity={0.09} />
        ))}
      {sky === "rain" && <rect className="rainfall" x={0} y={-64} width={w} height={h + 128} fill="url(#fx-rain)" />}
      {sky === "snow" && <rect className="snowfall" x={-90} y={-90} width={w + 180} height={h + 180} fill="url(#fx-snow)" />}
    </g>
  );
}

/** The week's forecast under the map; tap a day to see its weather on the map. */
function ForecastStrip({ forecast, picked, onPick }: { forecast: ReturnType<typeof useForecast>; picked: string | null; onPick: (d: DayForecast) => void }) {
  const fahrenheit = prefersFahrenheit();
  if (forecast.status === "no-location")
    return <p className="small muted forecast-note">Set the garden&rsquo;s location (The lot, in the panel) to see the week&rsquo;s forecast here.</p>;
  if (forecast.status === "loading") return <p className="small muted forecast-note">Getting the forecast…</p>;
  if (forecast.status === "error")
    return (
      <p className="small muted forecast-note">
        The forecast isn&rsquo;t available right now ({forecast.error}). <button className="ghost small" onClick={forecast.retry}>Try again</button>
      </p>
    );
  const { days, source } = forecast.value;
  return (
    <div className="forecast">
      <div className="forecast-days" role="list">
        {days.map((d) => {
          const date = new Date(`${d.date}T12:00:00`);
          return (
            <button
              key={d.date}
              role="listitem"
              className={`forecast-day ${picked === d.date ? "on" : ""}`}
              onClick={() => onPick(d)}
              title={`${d.summary}${d.precip != null ? `, ${d.precip}% chance of rain` : ""}${d.wind ? `, wind to ${d.wind} mph` : ""}. Show it on the map.`}
            >
              <span className="dow">{date.toLocaleDateString(undefined, { weekday: "short" })}</span>
              <span className="icon">{d.icon}</span>
              <span className="temps">
                <strong>{formatTemp(d.high, fahrenheit)}</strong> <span className="muted">{formatTemp(d.low, fahrenheit)}</span>
              </span>
              <span className="precip">{d.precip ? `💧${d.precip}%` : "\u00a0"}</span>
            </button>
          );
        })}
      </div>
      <p className="small muted forecast-note">
        {picked ? "Showing that day on the map; tap it again (or Now) to go back. " : "Tap a day to see it on the map. "}
        Forecast from {source}.
      </p>
    </div>
  );
}

/** Names stay out of the way: the thing under the pointer gets a light label, the selected one a bold one. */
function Labels({ entities, pj, toScreen, hoverId, selectedId }: { entities: MapEntity[]; pj: Projector; toScreen: (x: number, y: number) => [number, number]; hoverId: string | null; selectedId: string | null }) {
  return (
    <g className="map-labels" pointerEvents="none">
      {entities.map((e) => {
        const selected = e.id === selectedId;
        if (!selected && e.id !== hoverId) return null;
        const isArea = e.kind === "area";
        const [sx, sy] = isArea ? pj.p(e.x + e.w / 2, e.y + e.d / 2, 0) : pj.p(e.x + e.w / 2, e.y + e.d / 2, e.z + e.h);
        const [x, y] = toScreen(sx, sy);
        return (
          <text key={e.id} x={x} y={isArea ? y : y - 6} className={`${isArea ? "area-label" : "ent-label"} ${selected ? "selected" : "hover"}`} textAnchor="middle">
            {e.name}
          </text>
        );
      })}
    </g>
  );
}

/** Which way north is. Drag it to point the N at true north on your lot; the sun, shadows and bed headings follow. */
function Compass({ pj, site, x, y, turning }: { pj: Projector; site: Site; x: number; y: number; turning: boolean }) {
  const th = (site.northDeg * Math.PI) / 180;
  const cx = site.width / 2;
  const cy = site.depth / 2;
  const [ax, ay] = pj.p(cx, cy);
  const [bx, by] = pj.p(cx + Math.sin(th), cy - Math.cos(th));
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const ux = (bx - ax) / len;
  const uy = (by - ay) / len;
  const R = 26;
  return (
    <g className={`compass ${turning ? "turning" : ""}`} data-handle="compass" style={{ cursor: turning ? "grabbing" : "grab" }}>
      <title>Drag to point N at true north on your lot</title>
      <circle cx={x} cy={y} r={R} fill="#fffaf0" stroke={turning ? PAL.accent : PAL.ink} strokeOpacity={turning ? 1 : 0.4} strokeWidth={turning ? 2 : 1} />
      {[0, 90, 180, 270].map((a) => {
        const r = (a * Math.PI) / 180;
        // Ticks for the other compass points, turned with north.
        const tx = ux * Math.cos(r) - uy * Math.sin(r);
        const ty = uy * Math.cos(r) + ux * Math.sin(r);
        return a === 0 ? null : <line key={a} x1={x + tx * (R - 6)} y1={y + ty * (R - 6)} x2={x + tx * (R - 2)} y2={y + ty * (R - 2)} stroke={PAL.ink} strokeOpacity={0.5} strokeWidth={1.5} />;
      })}
      <line x1={x - ux * 15} y1={y - uy * 15} x2={x + ux * 5} y2={y + uy * 5} stroke={PAL.ink} strokeWidth={1.5} />
      <path d={`M${x + ux * 10} ${y + uy * 10} L${x + ux * 2 - uy * 5} ${y + uy * 2 + ux * 5} L${x + ux * 2 + uy * 5} ${y + uy * 2 - ux * 5} Z`} fill="#b23a2e" />
      <text x={x + ux * 18} y={y + uy * 18} fontSize={11} fontWeight={700} textAnchor="middle" dominantBaseline="central" fill="#b23a2e">N</text>
      {(turning || site.northDeg !== 0) && (
        <text x={x} y={y - R - 8} fontSize={11} fontWeight={600} textAnchor="middle" className="compass-deg">{Math.round(site.northDeg)}°</text>
      )}
    </g>
  );
}

// ---------- Panels ----------

/** A number input that writes through as you type, and follows the map when you aren't typing in it. */
function NumField({ label, value, onCommit, step = 0.5, min, unit = "ft" }: { label: string; value: number; onCommit: (v: number) => void; step?: number; min?: number; unit?: string }) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(String(+value.toFixed(2)));
  }, [value]);
  return (
    <label className="num-field">
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min={min}
        value={text}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          setText(String(+value.toFixed(2)));
        }}
        onChange={(ev) => {
          setText(ev.target.value);
          const v = Number(ev.target.value);
          if (ev.target.value !== "" && Number.isFinite(v) && (min == null || v >= min)) onCommit(v);
        }}
      />
      {unit && <span className="muted small">{unit}</span>}
    </label>
  );
}

function TextField({ value, onCommit, multiline, placeholder }: { value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => text !== value && onCommit(text);
  return multiline ? (
    <textarea rows={3} value={text} placeholder={placeholder} onChange={(ev) => setText(ev.target.value)} onBlur={commit} />
  ) : (
    <input value={text} placeholder={placeholder} onChange={(ev) => setText(ev.target.value)} onBlur={commit} onKeyDown={(ev) => ev.key === "Enter" && commit()} />
  );
}

function PropField({ f, value, onCommit }: { f: FieldDef; value: string | number | boolean | null | undefined; onCommit: (v: string | number | boolean) => void }) {
  if (f.type === "number") return <NumField label={f.label} value={Number(value ?? 0)} step={f.step} min={f.min} unit={f.unit ?? ""} onCommit={onCommit} />;
  if (f.type === "boolean")
    return (
      <label className="check">
        <input type="checkbox" checked={!!value} onChange={(ev) => onCommit(ev.target.checked)} /> {f.label}
      </label>
    );
  if (f.type === "select")
    return (
      <label className="field">
        <span>{f.label}</span>
        <select value={String(value ?? "")} onChange={(ev) => onCommit(ev.target.value)}>
          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    );
  return (
    <label className="field">
      <span>{f.label}</span>
      <TextField value={String(value ?? "")} onCommit={onCommit} />
    </label>
  );
}

const OPENING_LABEL: Record<Opening["type"], string> = { window: "Window", door: "Door", garage: "Garage door" };

/** A building's doors and windows: add, change and remove them; drag their tabs on the map to move them. */
function OpeningsEditor({ e, selected, onSelect }: { e: MapEntity; selected: string | null; onSelect: (id: string | null) => void }) {
  const { data, act } = useGarden();
  const openings = buildingOpenings(e);
  const north = (data.garden.site ?? DEFAULT_SITE).northDeg;
  const save = (list: Opening[]) => act((ctx) => updateMapEntity(ctx, e.id, { openings: list.map((o) => clampOpening(e, o)) }));
  const change = (id: string, patch: Partial<Opening>) => save(openings.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  // Which way each wall faces, by the compass.
  const facing = (wall: Wall) => {
    const l = wallLine(e, wall);
    const bearing = (Math.atan2(l.nx, -l.ny) * 180) / Math.PI + (e.rot ?? 0) - north;
    return compassPoint(bearing);
  };
  const add = (type: Opening["type"]) => {
    const wall = openings.find((o) => o.id === selected)?.wall ?? "s";
    const o = newOpening(e, type, wall, Math.random().toString(36).slice(2, 8));
    onSelect(o.id);
    save([...openings, o]);
  };
  const byWall = [...openings].sort((a, b) => WALLS.indexOf(a.wall) - WALLS.indexOf(b.wall) || a.bottom - b.bottom || a.offset - b.offset);
  return (
    <section className="card openings">
      <h3>Doors &amp; windows</h3>
      <p className="small muted">Drag the W, D and G tabs on the map to slide them along the walls, or around a corner. Delete removes the selected one.</p>
      <ul>
        {byWall.map((o) => (
          <li key={o.id} className={o.id === selected ? "on" : ""} onClick={() => onSelect(o.id)}>
            <div className="row small">
              <select value={o.type} onChange={(ev) => change(o.id, { type: ev.target.value as Opening["type"] })} aria-label="Type">
                {(Object.keys(OPENING_LABEL) as Opening["type"][]).map((t) => <option key={t} value={t}>{OPENING_LABEL[t]}</option>)}
              </select>
              <select value={o.wall} onChange={(ev) => change(o.id, { wall: ev.target.value as Wall })} aria-label="Wall">
                {WALLS.map((w) => <option key={w} value={w}>{facing(w)} wall</option>)}
              </select>
              <button
                className="ghost small"
                aria-label="Remove"
                title="Remove"
                onClick={(ev) => {
                  ev.stopPropagation();
                  if (selected === o.id) onSelect(null);
                  save(openings.filter((x) => x.id !== o.id));
                }}
              >
                ✕
              </button>
            </div>
            {o.id === selected && (
              <div className="num-grid">
                <NumField label="Along" value={o.offset} min={0} onCommit={(offset) => change(o.id, { offset })} />
                <NumField label="Width" value={o.width} min={0.5} onCommit={(width) => change(o.id, { width })} />
                <NumField label="Height" value={o.height} min={0.5} onCommit={(height) => change(o.id, { height })} />
                <NumField label="Off ground" value={o.bottom} min={0} onCommit={(bottom) => change(o.id, { bottom })} />
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="small" onClick={() => add("window")}>+ Window</button>
        <button className="small" onClick={() => add("door")}>+ Door</button>
        <button className="small" onClick={() => add("garage")}>+ Garage door</button>
      </div>
    </section>
  );
}

function EntityPanel({
  e,
  onClose,
  onSelect,
  openingSel,
  setOpeningSel,
}: {
  e: MapEntity;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  openingSel: string | null;
  setOpeningSel: (id: string | null) => void;
}) {
  const { data, today, act } = useGarden();
  const def = kindDef(e.kind);
  const update = (patch: Partial<MapEntity>) => act((ctx) => updateMapEntity(ctx, e.id, patch));
  const tray = e.links.trayId ? data.trays.find((t) => t.id === e.links.trayId) : undefined;
  const species = e.links.speciesId ? data.species.find((s) => s.id === e.links.speciesId) : undefined;
  const others = data.mapEntities.filter((m) => m.id !== e.id && !kindDef(m.kind).flat).sort((a, b) => a.name.localeCompare(b.name));
  const plantings = tray ? plantingViews(data, today).filter((p) => p.trayId === tray.id) : [];

  const duplicate = async () => {
    const id = await act((ctx) =>
      addMapEntity(ctx, e.kind, { x: 0, y: 0 }, { name: `${e.name} copy`, x: e.x + 1, y: e.y + 1, w: e.w, d: e.d, h: e.h, z: e.z, rot: e.rot, props: { ...e.props }, openings: e.openings, notes: e.notes }),
    );
    onSelect(id);
  };

  return (
    <>
      <section className="card">
        <div className="panel-head">
          <span className="small muted">{def.icon} {def.label}</span>
          <button className="ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label className="field">
          <span>Name</span>
          <TextField value={e.name} onCommit={(name) => update({ name: name.trim() || def.defaults.name })} />
        </label>
        <div className="num-grid">
          <NumField label="X" value={e.x} onCommit={(x) => update({ x })} />
          <NumField label="Y" value={e.y} onCommit={(y) => update({ y })} />
          {def.resizable && def.round && (
            <NumField
              label="Spread"
              value={Math.max(e.w, e.d)}
              min={0.5}
              onCommit={(v) => update({ w: v, d: v, x: e.x + e.w / 2 - v / 2, y: e.y + e.d / 2 - v / 2 })}
            />
          )}
          {def.resizable && !def.round && (
            <>
              <NumField label="Width" value={e.w} min={0.1} onCommit={(w) => update({ w })} />
              <NumField label="Depth" value={e.d} min={0.1} onCommit={(d) => update({ d })} />
            </>
          )}
          {!def.derive && <NumField label="Height" value={e.h} min={0} onCommit={(h) => update({ h })} />}
          <NumField label="Raised" value={e.z} min={0} onCommit={(z) => update({ z })} />
          {def.resizable && <NumField label="Turn" value={e.rot ?? 0} step={5} unit="°" onCommit={(rot) => update({ rot: normDeg(rot) })} />}
        </div>
        {def.resizable && <Heading e={e} onCommit={(rot) => update({ rot })} />}
        <p className="small muted">{def.description} X runs east from the lot&rsquo;s west edge, Y south from its north edge.</p>
        {def.fields?.map((f) => <PropField key={f.key} f={f} value={e.props[f.key] ?? f.value?.(e)} onCommit={(v) => update({ props: { [f.key]: v } })} />)}
        {def.derive && (
          <p className="small muted">
            Walls {+e.h.toFixed(1)} ft{e.props.roofRise ? `, ridge ${+(e.h + Number(e.props.roofRise)).toFixed(1)} ft` : ""} high.
          </p>
        )}
      </section>

      {def.openings && <OpeningsEditor e={e} selected={openingSel} onSelect={setOpeningSel} />}

      {IRRIGATION_KINDS.has(e.kind) && <ZonePanel e={e} />}

      {def.links?.includes("tray") && (
        <section className="card">
          <h3>Planter</h3>
          <select value={e.links.trayId ?? ""} onChange={(ev) => update({ links: { trayId: ev.target.value || null } })}>
            <option value="">— none —</option>
            {sortedTrays(data).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          {tray ? (
            <>
              <div style={{ marginTop: 10 }}>
                <TrayGrid tray={tray} plantings={plantings} covers={coverPhotos(data).byPlanting} mini />
              </div>
              <p className="small"><Link to={`/trays/${tray.id}`}>Open {tray.name} →</Link></p>
            </>
          ) : (
            <p className="small muted" style={{ marginTop: 8 }}>
              Link a planter to draw its rows here.{" "}
              <button className="small" onClick={() => act((ctx) => createPlanterForEntity(ctx, e.id))}>Create a planter for {e.name}</button>
            </p>
          )}
        </section>
      )}

      {def.links?.includes("species") && (
        <section className="card">
          <h3>Plant</h3>
          <select value={e.links.speciesId ?? ""} onChange={(ev) => update({ links: { speciesId: ev.target.value || null } })}>
            <option value="">— none —</option>
            {sortedSpecies(data).map((s) => <option key={s.id} value={s.id}>{s.commonName}{s.variety ? ` (${s.variety})` : ""}</option>)}
          </select>
          {species && <p className="small"><Link to={`/plants/${species.id}`}>Open {species.commonName} →</Link></p>}
        </section>
      )}

      {def.links?.includes("entity") && (
        <section className="card">
          <h3>Belongs to</h3>
          <select value={e.links.entityId ?? ""} onChange={(ev) => update({ links: { entityId: ev.target.value || null } })}>
            <option value="">— nothing —</option>
            {others.map((m) => <option key={m.id} value={m.id}>{kindDef(m.kind).icon} {m.name}</option>)}
          </select>
          {e.links.entityId && <p className="small"><button className="ghost small" onClick={() => onSelect(e.links.entityId!)}>Select it →</button></p>}
        </section>
      )}

      <section className="card">
        <h3>Notes</h3>
        <TextField multiline value={e.notes ?? ""} placeholder="Soil, sun, what's planned here…" onCommit={(v) => update({ notes: v.trim() || null })} />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="small" onClick={duplicate}>Duplicate</button>
          <button
            className="small danger"
            onClick={() => confirm(`Remove ${e.name} from the map?`) && act((ctx) => deleteMapEntity(ctx, e.id)).then(() => onSelect(null))}
          >
            Remove
          </button>
        </div>
      </section>
    </>
  );
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The zone a sprinkler, drip line or valve is on: the beds it waters, its name and timer, and a way to say it ran. */
function ZonePanel({ e }: { e: MapEntity }) {
  const { data, today, act } = useGarden();
  const zone = irrigationZones(data).find((z) => z.zone === zoneOf(e));
  if (!zone) return null;
  const timer = zone.settings.timer;
  const draft: ZoneTimer = timer ?? { days: [], at: "06:00", since: today, paused: false };
  const setTimer = (patch: Partial<ZoneTimer>) => act((ctx) => setZone(ctx, zone.zone, { timer: { ...draft, ...patch } }));
  const last = lastRun(data.irrigation ?? [], zone.zone, today);
  const hint =
    e.kind === "sprinkler"
      ? "move it so its spray covers most of a bed, or widen its spray radius."
      : e.kind === "drip-line"
        ? "run it through a bed, or pick the bed under Belongs to."
        : `pick a bed under Belongs to, or add sprinklers or drip lines on zone ${zone.zone}.`;
  return (
    <section className="card">
      <h3>💦 {zoneLabel(zone)}</h3>
      {WATER_LINES.has(e.kind) && (
        <label className="field">
          <span>What it is</span>
          <select
            value={e.kind}
            onChange={(ev) => {
              // Same place, span and zone; the new kind's settings.
              const kind = ev.target.value;
              const def = kindDef(kind).defaults;
              act((ctx) => updateMapEntity(ctx, e.id, { kind, h: def.h, props: { ...(def.props ?? {}), zone: e.props.zone ?? "1" } }));
            }}
          >
            <option value="drip-line">〰️ Drip line: tubing with emitters</option>
            <option value="sprinkler-line">⛲ Sprinkler line: small sprinklers on stakes along a hose</option>
          </select>
        </label>
      )}
      <p className="small">
        {zone.beds.length ? (
          <>Waters {zone.beds.map((b) => b.name).join(", ")}. A run counts as watering for every planting in them.</>
        ) : (
          <span className="muted">Doesn&rsquo;t water any beds yet: {hint}</span>
        )}
      </p>
      <label className="field">
        <span>Zone name</span>
        <TextField value={zone.settings.name ?? ""} placeholder={`Zone ${zone.zone}`} onCommit={(name) => act((ctx) => setZone(ctx, zone.zone, { name: name.trim() || null }))} />
      </label>
      <div className="field">
        <span>Timer runs on</span>
        <div className="zone-days">
          {DAY_LETTERS.map((d, i) => (
            <button
              key={i}
              className={`small ${draft.days.includes(i) ? "on" : ""}`}
              aria-pressed={draft.days.includes(i)}
              aria-label={DAY_NAMES[i]}
              title={DAY_NAMES[i]}
              onClick={() => setTimer({ days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i].sort() })}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="row">
        <label className="field">
          <span>Starts at</span>
          <input type="time" value={draft.at} onChange={(ev) => ev.target.value && setTimer({ at: ev.target.value })} />
        </label>
        <NumField label="Runs for" value={draft.minutes ?? DEFAULT_RUN_MINUTES} min={1} step={5} unit="min" onCommit={(minutes) => setTimer({ minutes: Math.max(1, Math.round(minutes)) })} />
        {timer && timer.days.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={timer.paused} onChange={(ev) => setTimer({ paused: ev.target.checked })} /> Paused
          </label>
        )}
      </div>
      <p className="small muted">
        {describeTimer(timer)}
        {last ? ` · last ran ${ranWhen(last.date, today)}${last.source === "timer" ? " (timer)" : ""}` : ""}. Timer runs are recorded on their own. Ran it by hand? Tap Ran today, here or on the Today page.
      </p>
      <div className="row">
        <ActionButton className="small" onClick={() => act((ctx) => setZoneRun(ctx, zone.zone, today, "manual"))}>💦 Whole zone ran today</ActionButton>
        {e.kind !== "valve" && (zone.lines.find((l) => l.head.id === e.id)?.beds.length ?? 0) > 0 && (
          <ActionButton className="small" onClick={() => act((ctx) => setZoneRun(ctx, zone.zone, today, "manual", e.id))}>💧 Just this one ran</ActionButton>
        )}
      </div>
    </section>
  );
}

/** Which way the long side (a bed's rows) runs, by the compass; editable. */
function Heading({ e, onCommit }: { e: MapEntity; onCommit: (rot: number) => void }) {
  const { data } = useGarden();
  const north = (data.garden.site ?? DEFAULT_SITE).northDeg;
  const bearing = Math.round(longSideBearing(e, north) * 10) / 10;
  const rows = e.links.trayId && data.trays.find((t) => t.id === e.links.trayId)?.layout === "rows";
  return (
    <div className="heading-field">
      <NumField label={rows ? "Rows run" : "Runs"} value={bearing} step={5} unit="° from north" onCommit={(b) => onCommit(rotForBearing(e, b, north))} />
      <span className="small muted">
        {compassPoint(bearing)}–{compassPoint(bearing + 180)}
        {north === 0 && " · north is the top of the plan until you set it in the lot settings"}
      </span>
    </div>
  );
}

const PASTE_HINT =
  "Paste from Google Maps: right-click a spot and click the coordinates to copy them, or copy the page's link. For example @30.1836998,-97.7891487";

/** Where the garden is, for the sun: a city, pasted coordinates, this device's location, or typed numbers. */
function LocationPicker({ site, save }: { site: Site; save: (patch: Partial<Site>) => Promise<unknown> }) {
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const guess = gardenLocation(site);
  const set = site.lat != null && site.lon != null;
  const city = set ? nearestCity(site.lat!, site.lon!) : null;
  // Four decimals is about 10 m: plenty for the sun, and no more precise than it needs to be.
  const round = (v: number) => Math.round(v * 10000) / 10000;
  const setTo = (lat: number, lon: number) => {
    setError(null);
    return save({ lat: round(lat), lon: round(lon) });
  };
  const usePasted = (text: string) => {
    if (!text.trim()) return;
    const at = parseLatLng(text);
    if (!at) return setError("Couldn't find coordinates in that. Try the @lat,lng from a Google Maps link.");
    setTo(at.lat, at.lon).then(() => setPasted(""));
  };
  return (
    <div className="location">
      <h3>Location</h3>
      <p className="small">
        {set ? (
          <>📍 {city ? `Near ${city.name}` : "Set"} <span className="muted">({site.lat!.toFixed(4)}, {site.lon!.toFixed(4)})</span></>
        ) : (
          <span className="muted">Not set: the sun is guessed from your time zone.</span>
        )}
      </p>
      <label className="field">
        <span>City</span>
        <select
          value=""
          onChange={(e) => {
            const c = CITIES.find((x) => x.name === e.target.value);
            if (c) setTo(c.lat, c.lon);
          }}
        >
          <option value="">{city ? city.name : "Choose a city…"}</option>
          {CITY_REGIONS.map((r) => (
            <optgroup key={r} label={r}>
              {CITIES.filter((c) => c.region === r).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          Or paste coordinates <span className="hint" title={PASTE_HINT} aria-label={PASTE_HINT}>ⓘ</span>
        </span>
        <div className="row">
          <input
            value={pasted}
            placeholder="@30.1836998,-97.7891487"
            title={PASTE_HINT}
            onChange={(e) => setPasted(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (parseLatLng(text)) {
                e.preventDefault();
                usePasted(text);
              }
            }}
            onKeyDown={(e) => e.key === "Enter" && usePasted(pasted)}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="small" type="button" onClick={() => usePasted(pasted)}>Set</button>
        </div>
      </label>
      <div className="num-grid">
        <NumField label="Lat" value={site.lat ?? guess.lat} step={0.01} unit="°" onCommit={(lat) => setTo(Math.max(-90, Math.min(90, lat)), site.lon ?? guess.lon)} />
        <NumField label="Lon" value={site.lon ?? guess.lon} step={0.01} unit="°" onCommit={(lon) => setTo(site.lat ?? guess.lat, ((lon + 540) % 360) - 180)} />
      </div>
      <div className="row small">
        <button
          className="small"
          type="button"
          disabled={locating}
          onClick={() => {
            if (!navigator.geolocation) return setError("This browser can't share its location.");
            setLocating(true);
            setError(null);
            navigator.geolocation.getCurrentPosition(
              (p) => {
                setLocating(false);
                setTo(p.coords.latitude, p.coords.longitude);
              },
              (err) => {
                setLocating(false);
                setError(err.message || "Couldn't get the location.");
              },
              { timeout: 15000 },
            );
          }}
        >
          📍 {locating ? "Locating…" : "Use this device's location"}
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
      <p className="small muted">For the sun and shadows. Kept only in this browser and your garden files, to about 10 m.</p>
    </div>
  );
}

/**
 * The watering system: each zone with its drip lines and sprinklers. Run a
 * whole zone at once, or say just one line ran; either way it counts as
 * watering for every planting in the beds it reaches.
 */
function WateringPanel({ onSelect, onAdd, onWatch }: { onSelect: (id: string) => void; onAdd: (kind: string) => void; onWatch: (ids: string[]) => void }) {
  const { data, today, act } = useGarden();
  const zones = irrigationZones(data);
  const runs = data.irrigation ?? [];
  const ran = (zone: string, head: string | null = null) => runs.find((r) => r.id === runId(zone, today, head) && r.source !== "skipped");
  return (
    <section className="card watering">
      <h3>💧 Watering</h3>
      {zones.length === 0 && (
        <p className="small muted">
          No watering system on the map yet. Add a sprinkler line or drip line and drag its ends along a bed (and its ↔ knob out to the span it waters), or put a sprinkler between beds. Everything on the same zone runs together.
        </p>
      )}
      {zones.map((z) => {
        const zoneRan = ran(z.zone);
        const last = lastRun(runs, z.zone, today);
        return (
          <div key={z.zone} className="zone-block">
            <div className="zone-head">
              <div>
                <strong>{zoneLabel(z)}</strong>
                <div className="small muted">
                  {describeTimer(z.settings.timer)}
                  {last ? ` · ran ${ranWhen(last.date, today)}` : ""}
                </div>
              </div>
              {zoneRan ? (
                <ActionButton className="ghost small" title="Undo" onClick={() => act((ctx) => setZoneRun(ctx, z.zone, today, zoneRan.source === "timer" ? "skipped" : null))}>
                  ✓ Ran today
                </ActionButton>
              ) : z.beds.length ? (
                <ActionButton className="small" onClick={() => act((ctx) => setZoneRun(ctx, z.zone, today, "manual")).then(() => onWatch(z.heads.map((h) => h.id)))}>
                  💦 Run whole zone
                </ActionButton>
              ) : (
                <span className="small muted">reaches no beds</span>
              )}
            </div>
            <button className="ghost small" title="Show it running on the map for a few seconds (records nothing)" onClick={() => onWatch(z.heads.map((h) => h.id))}>
              ▶ Watch it run
            </button>
            <ul className="zone-lines">
              {z.lines.map((l) => {
                const lineRan = ran(z.zone, l.head.id);
                return (
                  <li key={l.head.id}>
                    <div>
                      <button className="ghost small" title="Select it on the map" onClick={() => onSelect(l.head.id)}>
                        {kindDef(l.head.kind).icon} {l.head.name}
                      </button>
                      <div className="small muted">{l.beds.length ? `waters ${l.beds.map((b) => b.name).join(", ")}` : l.head.kind === "valve" ? "the zone's valve" : "reaches no bed yet"}</div>
                    </div>
                    {l.head.kind === "valve" || !l.beds.length ? (
                      <span />
                    ) : zoneRan ? (
                      <span className="small muted">✓</span>
                    ) : lineRan ? (
                      <ActionButton className="ghost small" title="Undo" onClick={() => act((ctx) => setZoneRun(ctx, z.zone, today, null, l.head.id))}>✓ Ran</ActionButton>
                    ) : (
                      <ActionButton className="small" title={`Just this one: waters ${l.beds.map((b) => b.name).join(", ")}`} onClick={() => act((ctx) => setZoneRun(ctx, z.zone, today, "manual", l.head.id)).then(() => onWatch([l.head.id]))}>
                        💧 Ran
                      </ActionButton>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <div className="row">
        <button className="small" onClick={() => onAdd("sprinkler-line")}>⛲ Add a sprinkler line</button>
        <button className="small" onClick={() => onAdd("drip-line")}>〰️ Add a drip line</button>
        <button className="small" onClick={() => onAdd("sprinkler")}>💦 Add a sprinkler</button>
      </div>
      <p className="small muted">A run counts as watering for every planting in the beds it reaches. Select a line or sprinkler to set its zone, the zone&rsquo;s name and timer.</p>
    </section>
  );
}

/** The household's pets, who come out on the map. */
function PetsPanel() {
  const { data, act } = useGarden();
  const pets = data.garden.pets ?? [];
  const save = (next: Pet[]) => act((ctx) => updateGarden(ctx, { pets: next }));
  const change = (id: string, patch: Partial<Pet>) => save(pets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const house = data.mapEntities.some((e) => e.kind === "house");
  return (
    <section className="card">
      <h3>Pets</h3>
      {pets.map((p) => (
        <div key={p.id} className="pet-row">
          <span aria-hidden>🐕</span>
          <TextField value={p.name} placeholder="Name" onCommit={(name) => change(p.id, { name: name.trim() })} />
          <select aria-label={`${p.name || "Dog"}'s coat`} value={p.coat} onChange={(ev) => change(p.id, { coat: ev.target.value })}>
            {Object.entries(DOG_COATS).map(([key, c]) => <option key={key} value={key}>{c.label}</option>)}
          </select>
          <button className="ghost small" onClick={() => save(pets.filter((x) => x.id !== p.id))} aria-label={`Remove ${p.name || "this dog"}`} title="Remove">✕</button>
        </div>
      ))}
      <button className="small" onClick={() => save([...pets, { id: newId(), name: "", kind: "dog", coat: "red-heeler" }])}>+ Add a dog</button>
      <p className="small muted">
        {house
          ? "A dog comes out the back door (the one nearest the patio) now and then, chases off cats and squirrels, sniffs around the yard, and on sunny days lies out on the patio."
          : "Dogs live in the house: add one to the map and they'll come out its back door."}
      </p>
    </section>
  );
}

/** The map as a 3D building model (IFC), for Bldrs and other BIM viewers. */
function ExportPanel() {
  const { data, today } = useGarden();
  const download = () => downloadFile(`${fileSlug(data.garden.name)}-${today}.ifc`, new Blob([exportIfc(data)], { type: "application/x-step" }));
  return (
    <section className="card">
      <h3>3D model</h3>
      <p className="small muted">
        The house and yard as an IFC building model: walls, doors and windows, the roof, beds and their plants, trees, fences and pools, each with its settings. Open it in{" "}
        <a href="https://share.bldrs.ai" target="_blank" rel="noreferrer">Bldrs</a> (or any BIM viewer) to walk around it in 3D.
      </p>
      <button className="small" onClick={download}>⬇️ Download IFC model</button>
    </section>
  );
}

function SitePanel({ site }: { site: Site }) {
  const { act } = useGarden();
  const save = (patch: Partial<Site>) => act((ctx) => setSite(ctx, { ...site, ...patch }));
  return (
    <section className="card">
      <h3>The lot</h3>
      <div className="num-grid">
        <NumField label="Width" value={site.width} min={10} step={1} onCommit={(width) => save({ width })} />
        <NumField label="Depth" value={site.depth} min={10} step={1} onCommit={(depth) => save({ depth })} />
        <NumField label="North" value={site.northDeg} step={5} unit="°" onCommit={(northDeg) => save({ northDeg: ((northDeg % 360) + 360) % 360 })} />
        <NumField label="Snap" value={site.gridFt} min={0} step={0.25} onCommit={(gridFt) => save({ gridFt })} />
      </div>
      <p className="small muted">Width runs east–west, depth north–south. North is degrees clockwise from the top of the plan; or drag the compass on the map. Snap 0 turns snapping off.</p>
      <LocationPicker site={site} save={save} />
    </section>
  );
}
