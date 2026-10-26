// Local-first storage: everything lives in the browser's IndexedDB, and nothing
// about a garden ships with the app. A garden starts empty or from an imported
// file; exportBackup/importBackup move a whole garden between devices and app
// instances. A remote backup/sync backend can be added later behind these functions.

import { openDB, type IDBPDatabase } from "idb";
import type { MapEntity } from "./map/model.ts";
import type { CareEvent, ChatRecord, Garden, GardenData, IrrigationRun, Note, Photo, Planting, RainDay, Species, Task, Tray } from "./types.ts";

export type GardenDB = IDBPDatabase;
export type Provider = "claude" | "ollama";

const DB_VERSION = 4;
export const RECORD_STORES = ["species", "trays", "plantings", "events", "notes", "photos", "tasks", "mapEntities", "rain", "irrigation"] as const;
export type RecordStore = (typeof RECORD_STORES)[number];
type StoreRecord = {
  species: Species;
  trays: Tray;
  plantings: Planting;
  events: CareEvent;
  notes: Note;
  photos: Photo;
  tasks: Task;
  mapEntities: MapEntity;
  rain: RainDay;
  irrigation: IrrigationRun;
};

export function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");
}

const now = () => new Date().toISOString();

export type OpenHooks = {
  /** Another tab still has an older version of the database open, so the upgrade has to wait for it. */
  blocked?: () => void;
  /** A newer version of the app in another tab wants to upgrade the database; this connection has been closed. */
  blocking?: () => void;
};

// The database is named "garden" from before the app was called Grdnr; the name stays so existing gardens keep opening.
export async function openGardenDb(name = "garden", hooks: OpenHooks = {}): Promise<GardenDB> {
  const db: GardenDB = await openDB(name, DB_VERSION, {
    blocked: () => hooks.blocked?.(),
    // Step aside so the other tab's upgrade isn't stuck waiting on this one.
    blocking: () => {
      db.close();
      hooks.blocking?.();
    },
    upgrade(db, oldVersion) {
      // Each step brings a database from the previous version; new browsers run them all.
      if (oldVersion < 1) {
        db.createObjectStore("meta");
        for (const s of ["species", "trays", "plantings", "events", "notes", "photos", "tasks"]) db.createObjectStore(s, { keyPath: "id" });
        db.createObjectStore("photoBlobs");
        const chat = db.createObjectStore("chat", { keyPath: "seq", autoIncrement: true });
        chat.createIndex("threadId", "threadId");
      }
      if (oldVersion < 2) db.createObjectStore("mapEntities", { keyPath: "id" });
      if (oldVersion < 3) db.createObjectStore("rain", { keyPath: "id" });
      if (oldVersion < 4) db.createObjectStore("irrigation", { keyPath: "id" });
    },
  });
  return db;
}

/** Everything in this browser's garden, or null when no garden has been started here yet. */
export async function loadAll(db: GardenDB): Promise<GardenData | null> {
  const tx = db.transaction(["meta", ...RECORD_STORES], "readonly");
  const [garden, species, trays, plantings, events, notes, photos, tasks, mapEntities, rain, irrigation] = await Promise.all([
    tx.objectStore("meta").get("garden"),
    ...RECORD_STORES.map((s) => tx.objectStore(s).getAll()),
  ]);
  if (!garden) return null;
  return { garden, species, trays, plantings, events, notes, photos, tasks, mapEntities, rain, irrigation } as GardenData;
}

export async function createGarden(db: GardenDB, input: { name: string; timezone: string; gardener: string | null }): Promise<void> {
  await saveGarden(db, { id: "garden", name: input.name, timezone: input.timezone, gardeners: input.gardener ? [input.gardener] : [], createdAt: now() });
}

export async function putRecords<S extends RecordStore>(db: GardenDB, store: S, records: StoreRecord[S][]): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  await Promise.all([...records.map((r) => tx.store.put(r)), tx.done]);
}

export async function deleteRecord(db: GardenDB, store: RecordStore, id: string): Promise<void> {
  await db.delete(store, id);
  if (store === "photos") await db.delete("photoBlobs", id);
}

export async function saveGarden(db: GardenDB, garden: Garden): Promise<void> {
  await db.put("meta", garden, "garden");
}

export async function savePhoto(db: GardenDB, photo: Photo, blob: Blob): Promise<void> {
  const tx = db.transaction(["photos", "photoBlobs"], "readwrite");
  await Promise.all([tx.objectStore("photos").put(photo), tx.objectStore("photoBlobs").put(blob, photo.id), tx.done]);
}

export async function getPhotoBlob(db: GardenDB, id: string): Promise<Blob | undefined> {
  return db.get("photoBlobs", id);
}

/**
 * Gardens started by the first version of the app pointed some photos at image
 * files bundled with the site. Copy those into this browser so the garden no
 * longer depends on the site serving them. Photos that can't be fetched yet are
 * left as they are and retried next time.
 */
export async function migrateBundledPhotos(db: GardenDB, fetchFile: (src: string) => Promise<Blob | null>): Promise<number> {
  const photos = ((await db.getAll("photos")) as Photo[]).filter((p) => p.src);
  let moved = 0;
  for (const p of photos) {
    const blob = await fetchFile(p.src!).catch(() => null);
    if (!blob) continue;
    await savePhoto(db, { ...p, src: null, mime: blob.type || p.mime }, blob);
    moved++;
  }
  return moved;
}

// ---------- Garden file (full export / import) ----------

export type Backup = {
  /** The garden file format's ID, from the app's first name; kept as is so every version opens every file. */
  app: "herb-garden";
  version: 1 | 2;
  exportedAt: string;
  data: GardenData;
  /** Photo bytes, as data: URLs keyed by photo id. */
  photoBlobs: Record<string, string>;
  /** Assistant conversations (version 2+). */
  chats?: Omit<ChatRecord, "seq">[];
  chatThreads?: Partial<Record<Provider, string>>;
};

function base64(buf: ArrayBuffer): string {
  if (typeof Buffer !== "undefined") return Buffer.from(buf).toString("base64");
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return base64(await blob.arrayBuffer());
}

export async function exportBackup(db: GardenDB): Promise<Backup> {
  const data = await loadAll(db);
  if (!data) throw new Error("There's no garden here to export yet.");
  const photoBlobs: Record<string, string> = {};
  for (const p of data.photos) {
    const blob = await getPhotoBlob(db, p.id);
    if (blob) photoBlobs[p.id] = `data:${blob.type || p.mime};base64,${await blobToBase64(blob)}`;
  }
  const chats = ((await db.getAll("chat")) as ChatRecord[]).sort((a, b) => a.seq! - b.seq!).map(({ seq: _seq, ...rest }) => rest);
  const chatThreads: Partial<Record<Provider, string>> = {};
  for (const p of ["claude", "ollama"] as const) {
    const id = await db.get("meta", threadKey(p));
    if (id) chatThreads[p] = id;
  }
  return { app: "herb-garden", version: 2, exportedAt: now(), data, photoBlobs, chats, chatThreads };
}

function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(",");
  const mime = head.match(/data:([^;]+)/)?.[1] ?? "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Replaces everything in this browser with the file's contents. */
export async function importBackup(db: GardenDB, backup: Backup): Promise<void> {
  if (backup?.app !== "herb-garden" || ![1, 2].includes(backup.version) || !backup.data?.garden)
    throw new Error("That file isn't a Grdnr garden file.");
  const stores = ["meta", "photoBlobs", "chat", ...RECORD_STORES];
  const tx = db.transaction(stores, "readwrite");
  await Promise.all(stores.map((s) => tx.objectStore(s).clear()));
  const { garden, ...records } = backup.data;
  await tx.objectStore("meta").put(garden, "garden");
  for (const s of RECORD_STORES) for (const r of records[s] ?? []) await tx.objectStore(s).put(r);
  for (const [id, url] of Object.entries(backup.photoBlobs ?? {})) await tx.objectStore("photoBlobs").put(dataUrlToBlob(url), id);
  for (const c of backup.chats ?? []) await tx.objectStore("chat").add(c);
  for (const [p, id] of Object.entries(backup.chatThreads ?? {})) await tx.objectStore("meta").put(id, threadKey(p as Provider));
  await tx.done;
}

// ---------- Assistant conversations (one current thread per provider) ----------

const threadKey = (p: Provider) => `chatThread:${p}`;

export async function currentThreadId(db: GardenDB, provider: Provider): Promise<string> {
  const id = ((await db.get("meta", threadKey(provider))) ?? (provider === "claude" ? await db.get("meta", "chatThread") : undefined)) as string | undefined;
  if (id) return id;
  return newThread(db, provider);
}

export async function newThread(db: GardenDB, provider: Provider): Promise<string> {
  const id = newId();
  await db.put("meta", id, threadKey(provider));
  return id;
}

export async function loadChat(db: GardenDB, threadId: string): Promise<ChatRecord[]> {
  const rows = (await db.getAllFromIndex("chat", "threadId", threadId)) as ChatRecord[];
  return rows.sort((a, b) => a.seq! - b.seq!);
}

export async function appendChat(db: GardenDB, record: ChatRecord): Promise<void> {
  await db.add("chat", record);
}
