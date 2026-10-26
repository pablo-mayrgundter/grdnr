import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { migrateCountedNames, type ActionCtx } from "./actions.ts";
import { todayIn } from "./dates.ts";
import { createGarden, getPhotoBlob, importBackup, loadAll, migrateBundledPhotos, openGardenDb, type Backup, type GardenDB } from "./store.ts";
import type { GardenData, Photo } from "./types.ts";
import { Logo } from "@/components/Logo";

const GARDENER_KEY = "garden.gardener";

/** Loads the garden, first bringing older data up to date (e.g. after opening an old garden file). */
async function loadTidied(db: GardenDB): Promise<GardenData | null> {
  const data = await loadAll(db);
  if (data && (await migrateCountedNames({ db, data, by: null, today: "" }))) return loadAll(db);
  return data;
}

type GardenState = {
  db: GardenDB;
  data: GardenData;
  today: string;
  /** Who's using this browser; signs care entries, notes and photos. */
  gardener: string | null;
  setGardener: (name: string | null) => void;
  /** Runs a change, then reloads the garden so every page sees it. */
  act: <T>(fn: (ctx: ActionCtx) => Promise<T>) => Promise<T>;
  /** The latest data, even from inside a long-running async flow (e.g. an assistant turn). */
  latest: () => GardenData;
  reload: () => Promise<void>;
};

const Ctx = createContext<GardenState | null>(null);

function readGardener(): string | null {
  try {
    return localStorage.getItem(GARDENER_KEY);
  } catch {
    return null;
  }
}

export function GardenProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<GardenDB | null>(null);
  const [data, setData] = useState<GardenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gardener, setGardenerState] = useState<string | null>(readGardener);
  const [, setTick] = useState(0);

  const [loaded, setLoaded] = useState(false);
  /** Waiting on another tab that has an older version of the garden open. */
  const [blocked, setBlocked] = useState(false);
  /** A newer version of the app took over the garden in another tab. */
  const [superseded, setSuperseded] = useState(false);

  useEffect(() => {
    openGardenDb(undefined, { blocked: () => setBlocked(true), blocking: () => setSuperseded(true) })
      .then(async (d) => {
        setBlocked(false);
        // Gardens from the first version referenced photos bundled with the site; copy them into this browser.
        const moved = await migrateBundledPhotos(d, async (src) => {
          const res = await fetch(staticUrl(src));
          return res.ok ? res.blob() : null;
        });
        if (moved) console.info(`Copied ${moved} photos into this browser's storage.`);
        setDb(d);
        setData(await loadTidied(d));
        setLoaded(true);
      })
      .catch((e) => setError(String(e?.message ?? e)));
    // Re-render every few minutes so "today" rolls over at midnight.
    const t = setInterval(() => setTick((n) => n + 1), 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  const reload = useCallback(async () => {
    if (db) setData(await loadTidied(db));
  }, [db]);

  const setGardener = useCallback((name: string | null) => {
    try {
      if (name) localStorage.setItem(GARDENER_KEY, name);
      else localStorage.removeItem(GARDENER_KEY);
    } catch {
      // Private mode: keep it for this visit only.
    }
    setGardenerState(name);
  }, []);

  const today = data ? todayIn(data.garden.timezone) : "";
  const dataRef = useRef(data);
  dataRef.current = data;
  const gardenerRef = useRef(gardener);
  gardenerRef.current = gardener;
  const latest = useCallback(() => dataRef.current!, []);

  const act = useCallback(
    async <T,>(fn: (ctx: ActionCtx) => Promise<T>): Promise<T> => {
      const current = dataRef.current;
      if (!db || !current) throw new Error("Garden not loaded");
      const result = await fn({ db, data: current, by: gardenerRef.current, today: todayIn(current.garden.timezone) });
      const fresh = await loadAll(db);
      dataRef.current = fresh;
      setData(fresh);
      return result;
    },
    [db],
  );

  const value = useMemo(
    () => (db && data ? { db, data, today, gardener, setGardener, act, latest, reload } : null),
    [db, data, today, gardener, setGardener, act, latest, reload],
  );

  if (superseded)
    return (
      <main className="auth-wrap">
        <div className="card auth-card">
          <h1>The app was updated</h1>
          <p className="muted">A newer version of the app opened this garden in another tab. Reload to switch this tab to it.</p>
          <button className="primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    );
  if (error && /VersionError|less than the existing version/i.test(error))
    return (
      <main className="auth-wrap">
        <div className="card auth-card">
          <h1>This garden is newer than this page</h1>
          <p className="muted">A newer version of the app has already updated this garden in this browser. Reload to get it.</p>
          <button className="primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </main>
    );
  if (error)
    return (
      <main className="auth-wrap">
        <div className="card auth-card">
          <h1>Can&rsquo;t open the garden</h1>
          <p className="muted">This browser blocked local storage ({error}). Try a regular (not private) window.</p>
        </div>
      </main>
    );
  if (blocked && !loaded)
    return (
      <main className="auth-wrap">
        <div className="card auth-card">
          <h1>Updating the garden…</h1>
          <p className="muted">
            This version of the app needs to update how the garden is stored, but the garden is open in another tab or window running an older version.
            Close or reload that tab and this one will open by itself.
          </p>
        </div>
      </main>
    );
  if (!loaded || !db) return <p className="empty" style={{ padding: 24 }}>Opening the garden…</p>;
  if (!value) return <Welcome db={db} onReady={reload} setGardener={setGardener} />;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** First visit in this browser: start an empty garden, or bring one in from a garden file. */
function Welcome({ db, onReady, setGardener }: { db: GardenDB; onReady: () => Promise<void>; setGardener: (n: string | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onReady();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-wrap">
      <div className="card auth-card">
        <div className="auth-hero">
          <Logo className="hero-logo" />
          <h1>Start a garden</h1>
          <p className="muted">Grdnr keeps track of what you plant and when it needs you. Everything you add stays in this browser on this device. Nothing is uploaded.</p>
        </div>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const name = String(fd.get("name") ?? "").trim() || "My garden";
            const you = String(fd.get("you") ?? "").trim() || null;
            run(async () => {
              await createGarden(db, { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", gardener: you });
              setGardener(you);
            });
          }}
        >
          <label>Garden name<input name="name" placeholder="e.g. Herb Garden" /></label>
          <label>Your name<input name="you" placeholder="Signs what you log" /></label>
          <button className="primary" disabled={busy}>Start an empty garden</button>
        </form>
        <div className="stack" style={{ gap: 8, marginTop: 18, textAlign: "center" }}>
          <span className="small muted">or, if you have a garden file from another device or a backup</span>
          <button type="button" disabled={busy} onClick={() => file.current?.click()}>⬆️ Open a garden file…</button>
          <input
            ref={file}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) run(async () => importBackup(db, JSON.parse(await f.text()) as Backup));
            }}
          />
        </div>
        <div className="stack" style={{ gap: 8, marginTop: 18, textAlign: "center" }}>
          <span className="small muted">or look around first, in a copy of our herb garden (packets, seed tray, photos and map)</span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                // The sample is an ordinary garden file published next to the app, fetched only when asked for.
                const res = await fetch(staticUrl("samples/herb-garden.json"));
                if (!res.ok) throw new Error("Couldn't load the sample garden.");
                const backup = (await res.json()) as Backup;
                backup.data.garden.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
                await importBackup(db, backup);
              })
            }
          >
            {busy ? "Loading…" : "🌿 Explore the sample garden"}
          </button>
        </div>
        {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}
      </div>
    </main>
  );
}

export function useGarden(): GardenState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useGarden outside GardenProvider");
  return v;
}

// ---------- Photo URLs ----------

const objectUrls = new Map<string, string>();

export function staticUrl(src: string): string {
  return `${import.meta.env.BASE_URL}${src}`;
}

/** A displayable URL for a photo: the bundled file, or an object URL for an uploaded blob. */
export function usePhotoUrl(photo: Photo | undefined): string | null {
  const { db } = useGarden();
  const [url, setUrl] = useState<string | null>(() =>
    photo ? (photo.src ? staticUrl(photo.src) : (objectUrls.get(photo.id) ?? null)) : null,
  );
  useEffect(() => {
    if (!photo) return setUrl(null);
    if (photo.src) return setUrl(staticUrl(photo.src));
    const cached = objectUrls.get(photo.id);
    if (cached) return setUrl(cached);
    let live = true;
    getPhotoBlob(db, photo.id).then((blob) => {
      if (!blob || !live) return;
      const u = URL.createObjectURL(blob);
      objectUrls.set(photo.id, u);
      setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [db, photo]);
  return url;
}
