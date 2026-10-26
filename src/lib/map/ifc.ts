// Exports the garden map as an IFC model (IFC4, in the ISO 10303-21 text
// format), so the house and yard can be opened in a BIM viewer such as Bldrs
// (https://bldrs.ai). Pure: the garden in, the file's text out.
//
// The model: an IfcProject with one IfcSite (the lot, with the garden's
// latitude, longitude and true north). Each house and shed is an IfcBuilding
// with a storey per floor: walls with their doors and windows cut in, floors,
// and the gable roof. Everything else in the yard is an element of the site:
// the ground, beds and the plants in them, trees, fences, pools, paths, water
// and power. Shapes follow the map drawing (render.tsx): the same sizes, the
// same roof, the same plants in the same spots. Each element carries a
// "Garden" property set with its map settings, planter and plant.
//
// Units and axes: lengths are metres (the map's feet convert on the way out).
// The map's x runs east and y south; IFC's Y runs north, so y flips. An
// entity's turn is clockwise on the plan, which is a negative turn about IFC's
// Z. Every element is placed at its footprint's center, turned, and its shapes
// are worked out in that frame, as if it weren't turned.

import { sprinklerHeads } from "../irrigation.ts";
import type { GardenData } from "../types.ts";
import { bedPlants, type BedPlant } from "./bedPlants.ts";
import { compassPoint, roundedRect, turn, type Vec2 } from "./geometry.ts";
import { kindDef, treeTrunk } from "./kinds.ts";
import { DEFAULT_SITE, type MapEntity, type Opening, type Wall } from "./model.ts";
import { buildingOpenings, houseStories } from "./openings.ts";

const FT = 0.3048;

// ---------- STEP text ----------

/** A real number as STEP writes it, always with a decimal point. */
export function real(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  const s = String(Object.is(r, -0) ? 0 : r);
  return s.includes(".") ? s : `${s}.`;
}

/** A string as STEP writes it: quotes and backslashes doubled, anything outside printable ASCII as UTF-16 hex. */
export function str(v: string): string {
  let out = "";
  let wide = "";
  const flush = () => {
    if (wide) out += `\\X2\\${wide}\\X0\\`;
    wide = "";
  };
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) {
      flush();
      out += c === 0x27 ? "''" : c === 0x5c ? "\\\\" : v[i];
    } else wide += c.toString(16).toUpperCase().padStart(4, "0");
  }
  flush();
  return `'${out}'`;
}

const opt = (v: string | null | undefined) => (v ? str(v) : "$");
const list = (xs: string[]) => `(${xs.join(",")})`;

const GUID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";

/** An IFC GlobalId (128 bits in 22 characters) hashed from a key, so exporting again keeps every element's id. */
export function ifcGuid(key: string): string {
  // cyrb128: four 32-bit hashes of the key.
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < key.length; i++) {
    const k = key.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  let n = 0n;
  for (const h of [h1, h2, h3, h4]) n = (n << 32n) | BigInt(h >>> 0);
  let out = "";
  for (let i = 21; i >= 0; i--) out += GUID_CHARS[Number((n >> BigInt(6 * i)) & 63n)];
  return out;
}

/** An angle as IFC's degrees, minutes, seconds and millionths of a second. */
function dms(deg: number): string {
  const sign = deg < 0 ? -1 : 1;
  let rest = Math.abs(deg);
  const d = Math.floor(rest);
  rest = (rest - d) * 60;
  const m = Math.floor(rest);
  rest = (rest - m) * 60;
  const s = Math.floor(rest);
  const u = Math.min(999999, Math.round((rest - s) * 1e6));
  return list([d, m, s, u].map((v) => String(sign * v || 0)));
}

// ---------- The model writer ----------

type Color = { hex: string; transparency?: number };
type Part = { solid: string; color: Color; brep?: boolean };
type Prop = [name: string, value: string | number | boolean | null | undefined];

const C = {
  ground: { hex: "#d9d3b0" },
  lawn: { hex: "#a6c070" },
  soil: { hex: "#8a6748" },
  mulch: { hex: "#a77c55" },
  concrete: { hex: "#e4ddcc" },
  stone: { hex: "#c7cdd0" },
  gravel: { hex: "#d6ccb4" },
  wood: { hex: "#c9a679" },
  post: { hex: "#a07c4d" },
  wall: { hex: "#f1e8d5" },
  floor: { hex: "#d2c8b2" },
  roof: { hex: "#b88d64" },
  glass: { hex: "#a9c0cc", transparency: 0.45 },
  door: { hex: "#8b5a3c" },
  garage: { hex: "#ece6d8" },
  trunk: { hex: "#7a5a3c" },
  canopy: { hex: "#86a064" },
  hedge: { hex: "#7f9c5c" },
  water: { hex: "#5fb0d8", transparency: 0.4 },
  poolShell: { hex: "#dfeef5" },
  metal: { hex: "#a7adb3" },
  green: { hex: "#2f4f2f" },
  pot: { hex: "#c97a4f" },
  net: { hex: "#d8d8d8", transparency: 0.75 },
  other: { hex: "#e5dccb" },
} satisfies Record<string, Color>;

class IfcWriter {
  private lines: string[] = [];
  private cache = new Map<string, string>();
  private p2d = this.add("IFCAXIS2PLACEMENT2D", this.add("IFCCARTESIANPOINT", "(0.,0.)"), "$");

  add(type: string, ...args: string[]): string {
    this.lines.push(`#${this.lines.length + 1}=${type}(${args.join(",")});`);
    return `#${this.lines.length}`;
  }

  /** One shared instance for repeated values (directions, styles). */
  once(key: string, make: () => string): string {
    let ref = this.cache.get(key);
    if (!ref) this.cache.set(key, (ref = make()));
    return ref;
  }

  data(): string {
    return this.lines.join("\n");
  }

  point(x: number, y: number, z: number): string {
    return this.add("IFCCARTESIANPOINT", list([real(x), real(y), real(z)]));
  }

  dir(x: number, y: number, z: number): string {
    return this.once(`dir ${real(x)} ${real(y)} ${real(z)}`, () => this.add("IFCDIRECTION", list([real(x), real(y), real(z)])));
  }

  axis(at: [number, number, number], z?: [number, number, number], x?: [number, number, number]): string {
    return this.add("IFCAXIS2PLACEMENT3D", this.point(...at), z ? this.dir(...z) : "$", x ? this.dir(...x) : "$");
  }

  /** A placement relative to another, at a point (metres) and turned clockwise on the plan by `deg`. */
  placement(relTo: string | null, at: [number, number, number], deg = 0): string {
    const a = (-deg * Math.PI) / 180;
    const ax = deg ? this.axis(at, [0, 0, 1], [Math.cos(a), Math.sin(a), 0]) : this.axis(at);
    return this.add("IFCLOCALPLACEMENT", relTo ?? "$", ax);
  }

  style(c: Color): string {
    return this.once(`style ${c.hex} ${c.transparency ?? 0}`, () => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16) / 255);
      const rgb = this.add("IFCCOLOURRGB", "$", real(r), real(g), real(b));
      const rendering = this.add("IFCSURFACESTYLERENDERING", rgb, real(c.transparency ?? 0), "$", "$", "$", "$", "$", "$", ".NOTDEFINED.");
      return this.add("IFCSURFACESTYLE", str(c.hex), ".BOTH.", list([rendering]));
    });
  }

  // Shapes. Arguments are in the element's frame, in feet, with y running south
  // like the map; they come out in metres with y running north.

  /** A closed polyline profile, counter-clockwise in IFC's axes. */
  private curve(pts: Vec2[]): string {
    const m = pts.map(([x, y]) => [x * FT, -y * FT] as Vec2);
    const area = m.reduce((a, p, i) => a + p[0] * m[(i + 1) % m.length][1] - m[(i + 1) % m.length][0] * p[1], 0);
    if (area < 0) m.reverse();
    const refs = m.map(([x, y]) => this.add("IFCCARTESIANPOINT", list([real(x), real(y)])));
    return this.add("IFCPOLYLINE", list([...refs, refs[0]]));
  }

  private extrude(profile: string, at: [number, number, number], depth: number, z?: [number, number, number], x?: [number, number, number]): string {
    return this.add("IFCEXTRUDEDAREASOLID", profile, this.axis(at, z, x), this.dir(0, 0, 1), real(Math.max(depth, 0.001)));
  }

  box(x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, color: Color): Part {
    const sx = Math.max(Math.abs(x1 - x0), 0.01) * FT;
    const sy = Math.max(Math.abs(y1 - y0), 0.01) * FT;
    const profile = this.add("IFCRECTANGLEPROFILEDEF", ".AREA.", "$", this.p2d, real(sx), real(sy));
    return { solid: this.extrude(profile, [((x0 + x1) / 2) * FT, (-(y0 + y1) / 2) * FT, z0 * FT], (z1 - z0) * FT), color };
  }

  /** A slab of any outline, optionally with holes. */
  slab(outline: Vec2[], z0: number, z1: number, color: Color, holes: Vec2[][] = []): Part {
    const profile = holes.length
      ? this.add("IFCARBITRARYPROFILEDEFWITHVOIDS", ".AREA.", "$", this.curve(outline), list(holes.map((h) => this.curve(h))))
      : this.add("IFCARBITRARYCLOSEDPROFILEDEF", ".AREA.", "$", this.curve(outline));
    return { solid: this.extrude(profile, [0, 0, z0 * FT], (z1 - z0) * FT), color };
  }

  cylinder(x: number, y: number, r: number, z0: number, z1: number, color: Color): Part {
    const profile = this.add("IFCCIRCLEPROFILEDEF", ".AREA.", "$", this.p2d, real(r * FT));
    return { solid: this.extrude(profile, [x * FT, -y * FT, z0 * FT], (z1 - z0) * FT), color };
  }

  /**
   * A prism standing on its side: an outline drawn across the element (the
   * across coordinate and height, in feet), pushed along its x (or y) from
   * `start` for `length` feet. For roofs and gable ends.
   */
  prism(outline: [across: number, z: number][], alongX: boolean, start: number, length: number, color: Color): Part {
    // Across runs along IFC's Y (flipped) when the prism runs along x, else along IFC's X.
    const pts = outline.map(([c, z]) => [(alongX ? -c : c) * FT, z * FT] as Vec2);
    const area = pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0);
    if (area < 0) pts.reverse();
    const refs = pts.map(([u, v]) => this.add("IFCCARTESIANPOINT", list([real(u), real(v)])));
    const profile = this.add("IFCARBITRARYCLOSEDPROFILEDEF", ".AREA.", "$", this.add("IFCPOLYLINE", list([...refs, refs[0]])));
    const solid = alongX
      ? this.extrude(profile, [start * FT, 0, 0], length * FT, [1, 0, 0], [0, 1, 0])
      : this.extrude(profile, [0, -start * FT, 0], length * FT, [0, -1, 0], [1, 0, 0]);
    return { solid, color };
  }

  /** An ellipsoid as a faceted solid: canopies, plants, fruit. */
  ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number, color: Color, rings = 8, around = 12): Part {
    const c = [x * FT, -y * FT, z * FT];
    const at = (theta: number, phi: number) =>
      this.point(c[0] + Math.sin(theta) * Math.cos(phi) * rx * FT, c[1] + Math.sin(theta) * Math.sin(phi) * ry * FT, c[2] + Math.cos(theta) * rz * FT);
    const top = this.point(c[0], c[1], c[2] + rz * FT);
    const bottom = this.point(c[0], c[1], c[2] - rz * FT);
    const ring = Array.from({ length: rings - 1 }, (_, i) => Array.from({ length: around }, (_, j) => at((Math.PI * (i + 1)) / rings, (2 * Math.PI * j) / around)));
    const faces: string[] = [];
    // Each face counter-clockwise seen from outside.
    const face = (...pts: string[]) => faces.push(this.add("IFCFACE", list([this.add("IFCFACEOUTERBOUND", this.add("IFCPOLYLOOP", list(pts)), ".T.")])));
    for (let j = 0; j < around; j++) {
      const k = (j + 1) % around;
      face(top, ring[0][j], ring[0][k]);
      for (let i = 0; i < rings - 2; i++) face(ring[i][j], ring[i + 1][j], ring[i + 1][k], ring[i][k]);
      face(bottom, ring[rings - 2][k], ring[rings - 2][j]);
    }
    return { solid: this.add("IFCFACETEDBREP", this.add("IFCCLOSEDSHELL", list(faces))), color, brep: true };
  }

  /** The body shape of an element from its parts, each in its color. */
  shape(context: string, parts: Part[]): string {
    if (!parts.length) return "$";
    for (const p of parts) this.add("IFCSTYLEDITEM", p.solid, list([this.style(p.color)]), "$");
    const breps = parts.filter((p) => p.brep).length;
    const type = breps === parts.length ? "Brep" : breps ? "SolidModel" : "SweptSolid";
    const rep = this.add("IFCSHAPEREPRESENTATION", context, "'Body'", str(type), list(parts.map((p) => p.solid)));
    return this.add("IFCPRODUCTDEFINITIONSHAPE", "$", "$", list([rep]));
  }

  /** A property set ("Garden") on an element, from name–value pairs; empty values are left out. */
  properties(key: string, of: string, props: Prop[]) {
    const values = props
      .filter(([, v]) => v != null && v !== "")
      .map(([name, v]) => {
        const value = typeof v === "number" ? `IFCREAL(${real(v)})` : typeof v === "boolean" ? `IFCBOOLEAN(${v ? ".T." : ".F."})` : `IFCLABEL(${str(String(v))})`;
        return this.add("IFCPROPERTYSINGLEVALUE", str(name), "$", value, "$");
      });
    if (!values.length) return;
    const set = this.add("IFCPROPERTYSET", str(ifcGuid(`${key}/pset`)), "$", "'Garden'", "$", list(values));
    this.add("IFCRELDEFINESBYPROPERTIES", str(ifcGuid(`${key}/pset-rel`)), "$", "$", "$", list([of]), set);
  }
}

// ---------- What each kind is in IFC ----------

/** The IFC class for a kind, and the attributes after the common ones (its predefined type). */
type IfcClass = { cls: string; tail: (e: MapEntity) => string[] };

const typed = (cls: string, type = "USERDEFINED"): IfcClass => ({ cls, tail: () => [`.${type}.`] });

const CLASSES: Record<string, IfcClass> = {
  lawn: typed("IFCGEOGRAPHICELEMENT"),
  mulch: typed("IFCGEOGRAPHICELEMENT"),
  tree: typed("IFCGEOGRAPHICELEMENT"),
  "fruit-tree": typed("IFCGEOGRAPHICELEMENT"),
  shrub: typed("IFCGEOGRAPHICELEMENT"),
  hedge: typed("IFCGEOGRAPHICELEMENT"),
  path: typed("IFCSLAB"),
  patio: typed("IFCSLAB"),
  driveway: typed("IFCSLAB"),
  fence: typed("IFCRAILING"),
  trellis: typed("IFCRAILING"),
  gate: { cls: "IFCDOOR", tail: (e) => [real(e.h * FT), real(Math.max(e.w, e.d) * FT), ".GATE.", ".SINGLE_SWING_LEFT.", "$"] },
  spigot: typed("IFCVALVE", "FAUCET"),
  valve: typed("IFCVALVE"),
  outlet: typed("IFCOUTLET", "POWEROUTLET"),
  meter: typed("IFCFLOWMETER", "NOTDEFINED"),
  "ac-unit": typed("IFCUNITARYEQUIPMENT", "SPLITSYSTEM"),
  "rain-barrel": typed("IFCTANK", "STORAGE"),
  "drip-line": typed("IFCPIPESEGMENT", "FLEXIBLESEGMENT"),
  "sprinkler-line": typed("IFCPIPESEGMENT", "FLEXIBLESEGMENT"),
  sensor: typed("IFCSENSOR", "NOTDEFINED"),
};
const PROXY: IfcClass = typed("IFCBUILDINGELEMENTPROXY");

/** Kinds that are notes on the plan rather than things, left out of the model. */
const SKIPPED = new Set(["area"]);

type Shapes = (w: IfcWriter, e: MapEntity, data: GardenData) => Part[];

/** A box filling the entity, in a color. */
const solid = (color: Color, minH = 0.02): Shapes => (w, e) => [w.box(-e.w / 2, -e.d / 2, e.w / 2, e.d / 2, e.z, e.z + Math.max(e.h, minH), color)];

/** A bed: a frame around soil (or just soil), with the plants growing in it drawn separately. */
const bed = (frame: Color | null, t: number): Shapes => (w, e) => {
  const [hw, hd] = [e.w / 2, e.d / 2];
  const top = e.z + Math.max(e.h, 0.05);
  if (!frame) return [w.box(-hw, -hd, hw, hd, e.z, top, C.soil)];
  const outer: Vec2[] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  const inner: Vec2[] = [[-hw + t, -hd + t], [hw - t, -hd + t], [hw - t, hd - t], [-hw + t, hd - t]];
  return [w.slab(outer, e.z, top, frame, [inner]), w.box(-hw + t, -hd + t, hw - t, hd - t, e.z, top - 0.08, C.soil)];
};

const PLANTED = new Set(["raised-bed", "herb-garden", "in-ground-bed", "container"]);

/** Where a bed's plants stand: the top of its soil. */
function soilTop(e: MapEntity): number {
  const top = e.z + Math.max(e.h, 0.05);
  return e.kind === "raised-bed" || e.kind === "herb-garden" || e.kind === "container" ? top - 0.08 : top;
}

function fence(w: IfcWriter, e: MapEntity, style: string): Part[] {
  const alongX = e.w >= e.d;
  const len = alongX ? e.w : e.d;
  const [x0, y0] = [-e.w / 2, -e.d / 2];
  const posts = Math.max(2, Math.round(len / 8) + 1);
  const parts: Part[] = [];
  for (let i = 0; i < posts; i++) {
    const a = (i / (posts - 1)) * (len - 0.35);
    const [px, py] = alongX ? [x0 + a, y0] : [x0, y0 + a];
    parts.push(w.box(px, py, px + 0.35, py + 0.35, 0, e.h + 0.3, C.post));
  }
  const run = (z0: number, z1: number, t: number) => w.box(x0, y0, x0 + (alongX ? e.w : t), y0 + (alongX ? t : e.d), z0, z1, style === "wire" ? C.metal : C.wood);
  if (style === "privacy" || style === "picket") parts.push(run(0, style === "picket" ? e.h * 0.6 : e.h, 0.12));
  else for (const f of [0.3, 0.6, 0.9]) parts.push(run(e.h * f - 0.03, e.h * f + 0.03, 0.06));
  return parts;
}

function canopy(w: IfcWriter, e: MapEntity, color: Color, fruit?: string): Part[] {
  const trunkTop = treeTrunk(e);
  const [rx, ry] = [e.w / 2, e.d / 2];
  const rz = Math.max((e.h - trunkTop) / 2, 0.2);
  const cz = e.z + trunkTop + rz;
  const parts = [w.ellipsoid(0, 0, cz, rx, ry, rz, color)];
  if (trunkTop > 0) parts.unshift(w.cylinder(0, 0, Math.max(0.2, Math.min(e.w, e.d) * 0.03), e.z, cz, C.trunk));
  if (fruit) {
    // The same fruit in the same places on every export.
    let seed = [...e.id].reduce((a, c) => a + c.charCodeAt(0), 0);
    const rand = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const r = Math.max(0.15, Math.min(rx, ry) * 0.06);
    for (let i = 0; i < 9; i++) {
      const theta = 0.5 + rand() * 1.6;
      const phi = rand() * Math.PI * 2;
      const at = (k: number, v: number) => k * v * 0.97;
      parts.push(w.ellipsoid(at(rx, Math.sin(theta) * Math.cos(phi)), -at(ry, Math.sin(theta) * Math.sin(phi)), cz + at(rz, Math.cos(theta)), r, r, r, { hex: /^#[0-9a-f]{6}$/i.test(fruit) ? fruit : "#c0392b" }, 4, 6));
    }
  }
  return parts;
}

function stepping(w: IfcWriter, e: MapEntity): Part[] {
  const alongX = e.w >= e.d;
  const len = alongX ? e.w : e.d;
  const wid = alongX ? e.d : e.w;
  const n = Math.max(1, Math.floor(len / 2.2));
  const s = Math.min(wid * 0.8, 1.7);
  return Array.from({ length: n }, (_, i) => {
    const a = -len / 2 + (i + 0.5) * (len / n);
    const [cx, cy] = alongX ? [a, 0] : [0, a];
    return w.box(cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2, 0, 0.06, C.stone);
  });
}

const PATH_COLOR: Record<string, Color> = { pavers: C.concrete, concrete: C.concrete, gravel: C.gravel, mulch: C.mulch };

/** A rounded-rectangle outline in the element's frame, `inset` feet in from its edge. */
const rounded = (e: MapEntity, r: number, inset = 0): Vec2[] => roundedRect({ x: -e.w / 2, y: -e.d / 2, w: e.w, d: e.d }, r, 0, inset).map(([x, y]) => [x, y]);

function inGroundPool(w: IfcWriter, e: MapEntity): Part[] {
  const r = Number(e.props.corner ?? 3);
  const depth = Math.max(1, Number(e.props.depth ?? 5));
  const coping = 1;
  const outer = rounded(e, r);
  const inner = rounded(e, r, coping);
  return [
    w.slab(outer, 0, 0.05, C.concrete, [inner]),
    w.slab(outer, -depth - 0.3, 0, C.poolShell, [inner]),
    w.slab(inner, -depth - 0.3, -depth, C.poolShell),
    w.slab(inner, -depth, -0.4, C.water),
  ];
}

function raisedWater(w: IfcWriter, e: MapEntity, side: Color, rim: Color): Part[] {
  const r = Number(e.props.corner ?? 2);
  const t = Math.min(0.6, Math.min(e.w, e.d) * 0.08);
  const outer = rounded(e, r);
  const inner = rounded(e, r, t);
  const top = e.z + e.h;
  return [w.slab(outer, e.z, top - 0.15, side, [inner]), w.slab(outer, top - 0.15, top, rim, [inner]), w.slab(inner, e.z, top - 0.25, C.water)];
}

function gantry(w: IfcWriter, e: MapEntity): Part[] {
  const alongX = e.w >= e.d;
  const color = e.props.status === "installed" ? C.metal : { ...C.metal, transparency: 0.5 };
  const [x0, y0, x1, y1] = [-e.w / 2, -e.d / 2, e.w / 2, e.d / 2];
  const across = alongX ? e.d : e.w;
  const rail = (o: number) => (alongX ? w.box(x0, y0 + o, x1, y0 + o + 0.2, 0, 1.2, color) : w.box(x0 + o, y0, x0 + o + 0.2, y1, 0, 1.2, color));
  const mid = alongX ? x0 + e.w * 0.4 : y0 + e.d * 0.4;
  return [
    rail(0),
    rail(across - 0.2),
    ...(alongX
      ? [w.box(mid, y0, mid + 0.3, y0 + 0.3, 1.2, e.h, color), w.box(mid, y1 - 0.3, mid + 0.3, y1, 1.2, e.h, color), w.box(mid, y0, mid + 0.4, y1, e.h - 0.3, e.h, color)]
      : [w.box(x0, mid, x0 + 0.3, mid + 0.3, 1.2, e.h, color), w.box(x1 - 0.3, mid, x1, mid + 0.3, 1.2, e.h, color), w.box(x0, mid, x1, mid + 0.4, e.h - 0.3, e.h, color)]),
  ];
}

function seedStation(w: IfcWriter, e: MapEntity): Part[] {
  const [x0, y0, x1, y1] = [-e.w / 2, -e.d / 2, e.w / 2, e.d / 2];
  const top = e.z + e.h;
  const leg = (x: number, y: number) => w.box(x, y, x + 0.2, y + 0.2, e.z, top - 0.1, C.post);
  return [leg(x0, y0), leg(x1 - 0.2, y0), leg(x0, y1 - 0.2), leg(x1 - 0.2, y1 - 0.2), w.box(x0, y0, x1, y1, top - 0.1, top, C.wood)];
}

const SHAPES: Record<string, Shapes> = {
  lawn: solid(C.lawn, 0.03),
  mulch: solid(C.mulch, 0.05),
  path: (w, e, data) => {
    const surface = String(e.props.surface ?? "pavers");
    return surface === "stepping" ? stepping(w, e) : solid(PATH_COLOR[surface] ?? C.concrete, 0.05)(w, e, data);
  },
  patio: solid(C.concrete),
  driveway: solid(C.concrete),
  fence: (w, e) => fence(w, e, String(e.props.style ?? "privacy")),
  trellis: (w, e) => fence(w, e, "wire"),
  gate: solid(C.wood),
  netting: solid(C.net),
  "raised-bed": bed(C.wood, 0.18),
  "herb-garden": bed(C.wood, 0.18),
  "in-ground-bed": bed(null, 0),
  container: bed(C.pot, 0.1),
  "seed-station": seedStation,
  tree: (w, e) => canopy(w, e, C.canopy),
  "fruit-tree": (w, e) => canopy(w, e, { hex: "#93ad6c" }, String(e.props.fruit ?? "#c0392b")),
  shrub: (w, e) => canopy(w, e, C.hedge),
  hedge: solid(C.hedge),
  compost: solid(C.mulch),
  pool: inGroundPool,
  "above-ground-pool": (w, e) => raisedWater(w, e, { hex: "#7fa7c4" }, { hex: "#dfe8ee" }),
  "hot-tub": (w, e) => raisedWater(w, e, { hex: "#b48f5c" }, { hex: "#cdbb9c" }),
  spigot: solid(C.metal),
  outlet: solid({ hex: "#eeeeee" }),
  meter: solid(C.metal),
  "ac-unit": solid(C.metal),
  "rain-barrel": (w, e) => [w.cylinder(0, 0, Math.min(e.w, e.d) / 2, e.z, e.z + e.h, { hex: "#4f7690" })],
  valve: solid(C.green),
  sprinkler: solid(C.green),
  "drip-line": (w, e) => {
    const alongX = e.w >= e.d;
    return [alongX ? w.box(-e.w / 2, -0.03, e.w / 2, 0.03, e.z, e.z + 0.06, { hex: "#222222" }) : w.box(-0.03, -e.d / 2, 0.03, e.d / 2, e.z, e.z + 0.06, { hex: "#222222" })];
  },
  "sprinkler-line": (w, e) => {
    // The hose along the middle, and a stake with a yellow head every so often.
    const alongX = e.w >= e.d;
    const [cx, cy] = [e.x + e.w / 2, e.y + e.d / 2];
    const hose = alongX ? w.box(-e.w / 2, -0.04, e.w / 2, 0.04, e.z, e.z + 0.08, { hex: "#1f6b55" }) : w.box(-0.04, -e.d / 2, 0.04, e.d / 2, e.z, e.z + 0.08, { hex: "#1f6b55" });
    return [
      hose,
      ...sprinklerHeads(e).flatMap(([x, y]) => {
        const [lx, ly] = turn(x - cx, y - cy, -(e.rot ?? 0));
        return [w.box(lx - 0.05, ly - 0.05, lx + 0.05, ly + 0.05, e.z, e.z + e.h, C.metal), w.cylinder(lx, ly, 0.08, e.z + e.h, e.z + e.h + 0.06, { hex: "#e8c02a" })];
      }),
    ];
  },
  gantry,
  "robot-dock": solid(C.metal),
  sensor: solid(C.metal),
};

// ---------- Houses and sheds ----------

const WALL_T = 0.5;
const STOREY_NAMES = ["Ground floor", "Second floor", "Third floor"];

/** Which way a wall faces, as a compass point, from the building's turn and the lot's north. */
function facing(e: MapEntity, wall: Wall, northDeg: number): string {
  const onPlan = { n: 0, e: 90, s: 180, w: 270 }[wall] + (e.rot ?? 0);
  return compassPoint(onPlan - northDeg);
}

type Ctx = { w: IfcWriter; body: string; site: string; siteItems: string[]; data: GardenData; northDeg: number };

function building(ctx: Ctx, e: MapEntity): string {
  const { w, body } = ctx;
  const { stories } = houseStories(e);
  const H = e.h / stories;
  const [hw, hd] = [e.w / 2, e.d / 2];
  const t = Math.min(WALL_T, e.w / 4, e.d / 4);
  const place = w.placement(ctx.site, [(e.x + hw) * FT, -(e.y + hd) * FT, e.z * FT], e.rot ?? 0);
  const label = kindDef(e.kind).label;
  const bldg = w.add("IFCBUILDING", str(ifcGuid(e.id)), "$", str(e.name), opt(e.notes), str(label), place, "$", "$", ".ELEMENT.", "$", "$", "$");
  w.properties(e.id, bldg, entityProps(e, ctx.data));

  const storeys: { ref: string; place: string; items: string[] }[] = [];
  for (let s = 0; s < stories; s++) {
    const sp = w.placement(place, [0, 0, s * H * FT]);
    const name = stories === 1 && e.kind !== "house" ? "Floor" : (STOREY_NAMES[s] ?? `Floor ${s + 1}`);
    const ref = w.add("IFCBUILDINGSTOREY", str(ifcGuid(`${e.id}/storey/${s}`)), "$", str(name), "$", "$", sp, "$", "$", ".ELEMENT.", real(s * H * FT));
    storeys.push({ ref, place: sp, items: [] });
  }
  const at = (s: number) => w.placement(storeys[s].place, [0, 0, 0]);
  const element = (cls: string, key: string, name: string, s: number, placement: string, parts: Part[], tail: string[]) => {
    const ref = w.add(cls, str(ifcGuid(`${e.id}/${key}`)), "$", str(name), "$", "$", placement, w.shape(body, parts), "$", ...tail);
    storeys[s].items.push(ref);
    return ref;
  };

  // Walls: the north and south ones run the full width; east and west fit between them.
  const wallBox: Record<Wall, [number, number, number, number]> = {
    n: [-hw, -hd, hw, -hd + t],
    s: [-hw, hd - t, hw, hd],
    w: [-hw, -hd + t, -hw + t, hd - t],
    e: [hw - t, -hd + t, hw, hd - t],
  };
  const walls: Record<Wall, string>[] = [];
  for (let s = 0; s < stories; s++) {
    const row = {} as Record<Wall, string>;
    for (const side of ["n", "e", "s", "w"] as Wall[]) {
      const [x0, y0, x1, y1] = wallBox[side];
      row[side] = element("IFCWALL", `wall/${s}/${side}`, `${facing(e, side, ctx.northDeg)} wall`, s, at(s), [w.box(x0, y0, x1, y1, 0, H, C.wall)], [".SOLIDWALL."]);
    }
    walls.push(row);
    element("IFCSLAB", `floor/${s}`, "Floor", s, at(s), [w.box(-hw + t, -hd + t, hw - t, hd - t, -0.33, 0, C.floor)], [".FLOOR."]);
  }

  // Doors and windows: an opening cut through the wall, filled with a door or a pane of glass.
  for (const o of buildingOpenings(e)) {
    const s = Math.max(0, Math.min(stories - 1, Math.floor((o.bottom + 0.01) / H)));
    const z0 = o.bottom - s * H;
    const z1 = Math.min(z0 + o.height, H);
    if (z1 - z0 < 0.1) continue;
    const span = (inset: number, depth: number) => openingBox(o, hw, hd, inset, depth);
    const [hx0, hy0, hx1, hy1] = span(-0.1, t + 0.2);
    const hole = w.add("IFCOPENINGELEMENT", str(ifcGuid(`${e.id}/opening/${o.id}`)), "$", "$", "$", "$", at(s), w.shape(body, [w.box(hx0, hy0, hx1, hy1, z0, z1, C.other)]), "$", ".OPENING.");
    w.add("IFCRELVOIDSELEMENT", str(ifcGuid(`${e.id}/voids/${o.id}`)), "$", "$", "$", walls[s][o.wall], hole);
    const thick = o.type === "window" ? 0.1 : 0.15;
    const [fx0, fy0, fx1, fy1] = span(t / 2 - thick / 2, thick);
    const panel = [w.box(fx0, fy0, fx1, fy1, z0, z1, o.type === "window" ? C.glass : o.type === "door" ? C.door : C.garage)];
    const [height, width] = [real((z1 - z0) * FT), real(o.width * FT)];
    const name = o.type === "window" ? "Window" : o.type === "garage" ? "Garage door" : "Door";
    const fill =
      o.type === "window"
        ? element("IFCWINDOW", `window/${o.id}`, name, s, at(s), panel, [height, width, ".WINDOW.", ".SINGLE_PANEL.", "$"])
        : element("IFCDOOR", `door/${o.id}`, name, s, at(s), panel, [height, width, ".DOOR.", o.type === "garage" ? ".ROLLINGUP." : ".SINGLE_SWING_LEFT.", "$"]);
    w.add("IFCRELFILLSELEMENT", str(ifcGuid(`${e.id}/fills/${o.id}`)), "$", "$", "$", hole, fill);
  }

  // The roof: a gable along the long side with a little overhang (as drawn on the map), and the gable ends under it.
  const top = stories - 1;
  const rise = Math.max(0, Number(e.props.roofRise ?? 6));
  const over = 0.8;
  const roofAt = w.placement(storeys[top].place, [0, 0, -top * H * FT]);
  if (rise > 0.1) {
    const alongX = e.w >= e.d;
    const [len, half] = alongX ? [e.w, hd] : [e.d, hw];
    const thick = 0.35;
    const eave = half + over;
    const panel = (side: 1 | -1) => w.prism([[side * eave, e.h], [0, e.h + rise], [0, e.h + rise + thick], [side * eave, e.h + thick]], alongX, -len / 2 - over, len + over * 2, C.roof);
    element("IFCROOF", "roof", "Roof", top, roofAt, [panel(-1), panel(1)], [".GABLE_ROOF."]);
    // The gable's sloped edges follow the roof's underside.
    const atWall = e.h + (rise * over) / eave;
    const gable: [number, number][] = [[-half, e.h], [half, e.h], [half, atWall], [0, e.h + rise], [-half, atWall]];
    element("IFCWALL", "gables", "Gable ends", top, roofAt, [w.prism(gable, alongX, -len / 2, t, C.wall), w.prism(gable, alongX, len / 2 - t, t, C.wall)], [".SOLIDWALL."]);
  } else {
    element("IFCROOF", "roof", "Roof", top, roofAt, [w.box(-hw - over, -hd - over, hw + over, hd + over, e.h, e.h + 0.35, C.roof)], [".FLAT_ROOF."]);
  }

  for (const [s, st] of storeys.entries()) {
    w.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", str(ifcGuid(`${e.id}/storey/${s}/contains`)), "$", "$", "$", list(st.items), st.ref);
  }
  w.add("IFCRELAGGREGATES", str(ifcGuid(`${e.id}/storeys`)), "$", "$", "$", bldg, list(storeys.map((s) => s.ref)));
  return bldg;
}

/** The box an opening takes in its wall: along the wall over its width, and `depth` feet through it from `inset` in from the outside face. */
function openingBox(o: Opening, hw: number, hd: number, inset: number, depth: number): [number, number, number, number] {
  const a = (o.wall === "n" || o.wall === "s" ? -hw : -hd) + o.offset;
  const b = a + o.width;
  switch (o.wall) {
    case "n":
      return [a, -hd + inset, b, -hd + inset + depth];
    case "s":
      return [a, hd - inset - depth, b, hd - inset];
    case "w":
      return [-hw + inset, a, -hw + inset + depth, b];
    case "e":
      return [hw - inset - depth, a, hw - inset, b];
  }
}

// ---------- Properties ----------

function entityProps(e: MapEntity, data: GardenData): Prop[] {
  const def = kindDef(e.kind);
  const tray = e.links.trayId ? data.trays.find((t) => t.id === e.links.trayId) : undefined;
  const species = e.links.speciesId ? data.species.find((s) => s.id === e.links.speciesId) : undefined;
  const linked = e.links.entityId ? data.mapEntities.find((x) => x.id === e.links.entityId) : undefined;
  const fields: Prop[] = (def.fields ?? []).map((f) => {
    const v = e.props[f.key] ?? f.value?.(e) ?? null;
    const label = f.unit ? `${f.label} (${f.unit})` : f.label;
    if (f.type === "select") return [label, f.options?.find((o) => o.value === v)?.label ?? (v == null ? null : String(v))];
    return [label, f.type === "number" && v != null && v !== "" ? Number(v) : v];
  });
  return [
    ["Kind", def.label],
    ["Width (ft)", e.w],
    ["Depth (ft)", e.d],
    ["Height (ft)", e.h],
    ...fields,
    ["Planter", tray?.name],
    ["Plant", species ? speciesName(species) : null],
    ["Part of", linked?.name],
    ["Notes", e.notes],
  ];
}

const speciesName = (s: { commonName: string; variety: string | null }) => (s.variety ? `${s.commonName} (${s.variety})` : s.commonName);

// ---------- The whole model ----------

export type IfcOptions = { now?: Date };

/** The garden map as an IFC4 file. */
export function exportIfc(data: GardenData, opts: IfcOptions = {}): string {
  const site = data.garden.site ?? DEFAULT_SITE;
  const w = new IfcWriter();

  const units = w.add(
    "IFCUNITASSIGNMENT",
    list([
      w.add("IFCSIUNIT", "*", ".LENGTHUNIT.", "$", ".METRE."),
      w.add("IFCSIUNIT", "*", ".AREAUNIT.", "$", ".SQUARE_METRE."),
      w.add("IFCSIUNIT", "*", ".VOLUMEUNIT.", "$", ".CUBIC_METRE."),
      w.add("IFCSIUNIT", "*", ".PLANEANGLEUNIT.", "$", ".RADIAN."),
    ]),
  );
  // True north, as a direction in the plan's axes: turned clockwise from plan-up by the compass setting.
  const n = (site.northDeg * Math.PI) / 180;
  const north = w.add("IFCDIRECTION", list([real(Math.sin(n)), real(Math.cos(n))]));
  const model = w.add("IFCGEOMETRICREPRESENTATIONCONTEXT", "$", "'Model'", "3", real(1e-5), w.axis([0, 0, 0]), north);
  const body = w.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT", "'Body'", "'Model'", "*", "*", "*", "*", model, "$", ".MODEL_VIEW.", "$");
  const key = `garden:${data.garden.createdAt}`;
  const project = w.add("IFCPROJECT", str(ifcGuid(key)), "$", str(data.garden.name), "$", "$", "$", "$", list([model]), units);

  const sitePlace = w.placement(null, [0, 0, 0]);
  const hasLatLon = site.lat != null && site.lon != null;
  const siteRef = w.add(
    "IFCSITE",
    str(ifcGuid(`${key}/site`)),
    "$",
    str(data.garden.name),
    "$",
    "$",
    sitePlace,
    "$",
    "$",
    ".ELEMENT.",
    hasLatLon ? dms(site.lat!) : "$",
    hasLatLon ? dms(site.lon!) : "$",
    "$",
    "$",
    "$",
  );
  w.add("IFCRELAGGREGATES", str(ifcGuid(`${key}/project-site`)), "$", "$", "$", project, list([siteRef]));

  const ctx: Ctx = { w, body, site: sitePlace, siteItems: [], data, northDeg: site.northDeg };
  const entities = data.mapEntities.filter((e) => !SKIPPED.has(e.kind));

  // The ground: the lot, with the in-ground pools dug out of it.
  const pools = entities.filter((e) => e.kind === "pool" && inside(e, site));
  const holes = pools.map((e) => rounded(e, Number(e.props.corner ?? 3)).map(([x, y]) => toWorld(e, x, y)));
  const lot: Vec2[] = [[0, 0], [site.width, 0], [site.width, site.depth], [0, site.depth]];
  const groundAt = w.placement(sitePlace, [0, 0, 0]);
  const ground = w.add("IFCGEOGRAPHICELEMENT", str(ifcGuid(`${key}/ground`)), "$", "'Ground'", "$", "'Lot'", groundAt, w.shape(body, [w.slab(lot, -1, 0, C.ground, holes)]), "$", ".TERRAIN.");
  ctx.siteItems.push(ground);
  w.properties(`${key}/ground`, ground, [["Lot width (ft)", site.width], ["Lot depth (ft)", site.depth]]);

  const buildings: string[] = [];
  for (const e of entities) {
    if (e.kind === "house" || e.kind === "shed") {
      buildings.push(building(ctx, e));
      continue;
    }
    const cls = CLASSES[e.kind] ?? PROXY;
    const shapes = SHAPES[e.kind] ?? solid(C.other);
    const place = w.placement(sitePlace, [(e.x + e.w / 2) * FT, -(e.y + e.d / 2) * FT, 0], e.rot ?? 0);
    const label = kindDef(e.kind).label;
    const ref = w.add(cls.cls, str(ifcGuid(e.id)), "$", str(e.name), opt(e.notes), str(label), place, w.shape(body, shapes(w, e, data)), "$", ...cls.tail(e));
    ctx.siteItems.push(ref);
    w.properties(e.id, ref, entityProps(e, data));
    plants(ctx, e);
  }

  if (buildings.length) w.add("IFCRELAGGREGATES", str(ifcGuid(`${key}/site-buildings`)), "$", "$", "$", siteRef, list(buildings));
  w.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", str(ifcGuid(`${key}/site-contains`)), "$", "$", "$", list(ctx.siteItems), siteRef);

  const stamp = (opts.now ?? new Date()).toISOString().slice(0, 19);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
    `FILE_NAME(${str(`${fileSlug(data.garden.name)}.ifc`)},'${stamp}',(''),(''),'Grdnr','Grdnr','');`,
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    w.data(),
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

/** The plants in a bed, one element per planting, standing where the map draws them. */
function plants(ctx: Ctx, e: MapEntity) {
  const { w, body, data } = ctx;
  // As on the map: beds and pots show their plants; a seed station's tray doesn't.
  if (!e.links.trayId || !PLANTED.has(e.kind)) return;
  const byPlanting = new Map<string, BedPlant[]>();
  // Only plants that are up: planned spots and seeds in the ground don't show.
  for (const p of bedPlants(e, data)) if (p.stage > 0.3) byPlanting.set(p.plantingId, [...(byPlanting.get(p.plantingId) ?? []), p]);
  const [cx, cy] = [e.x + e.w / 2, e.y + e.d / 2];
  const z = soilTop(e);
  for (const [id, spots] of byPlanting) {
    const planting = data.plantings.find((p) => p.id === id)!;
    const species = data.species.find((s) => s.id === planting.speciesId);
    const parts = spots.map((p) => {
      const r = Math.max(0.08, p.r * p.stage);
      return w.ellipsoid(p.x - cx, p.y - cy, z + r * 0.7, r, r, r * 0.8, { hex: p.color }, 4, 6);
    });
    const place = w.placement(ctx.site, [cx * FT, -cy * FT, 0], e.rot ?? 0);
    const name = species ? speciesName(species) : "Plant";
    const ref = w.add("IFCGEOGRAPHICELEMENT", str(ifcGuid(`${e.id}/planting/${id}`)), "$", str(name), "$", "'Plant'", place, w.shape(body, parts), "$", ".USERDEFINED.");
    ctx.siteItems.push(ref);
    w.properties(`${e.id}/planting/${id}`, ref, [
      ["Kind", "Plant"],
      ["Plant", name],
      ["Scientific name", species?.scientificName],
      ["Bed", e.name],
      ["Status", planting.status],
      ["Count", planting.count ?? spots.length],
      ["Sown", planting.sownAt],
    ]);
  }
}

/** A point in an entity's frame (feet, from its center, unturned) on the lot. */
function toWorld(e: MapEntity, x: number, y: number): Vec2 {
  const [dx, dy] = turn(x, y, e.rot ?? 0);
  return [e.x + e.w / 2 + dx, e.y + e.d / 2 + dy];
}

/** Whether an entity's footprint lies within the lot, so it can be cut out of the ground. */
function inside(e: MapEntity, site: { width: number; depth: number }): boolean {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sy]) => {
    const [x, y] = toWorld(e, (sx * e.w) / 2, (sy * e.d) / 2);
    return x > 0.05 && y > 0.05 && x < site.width - 0.05 && y < site.depth - 0.05;
  });
}

export const fileSlug = (name: string) => name.toLowerCase().replace(/\W+/g, "-").replace(/^-|-$/g, "") || "garden";
