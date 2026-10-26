import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, Link, Outlet, RouterProvider } from "react-router";
import { AssistantPanel } from "./components/AssistantPanel";
import { GardenerPicker } from "./components/forms";
import { Nav } from "./components/Nav";
import { IrrigationSync } from "./components/IrrigationSync";
import { Logo } from "./components/Logo";
import { RainSync } from "./components/RainSync";
import { GardenProvider, useGarden } from "./lib/GardenContext";
import { NewPlantPage, PlantPage, PlantsPage } from "./pages/Plants";
import { PlantingPage } from "./pages/Planting";
import { SettingsPage } from "./pages/Settings";
import { NewTrayPage, TrayPage, TraysPage } from "./pages/Trays";
import { CalendarPage } from "./pages/Calendar";
import "./styles.css";

function Layout() {
  const { data, gardener, setGardener } = useGarden();
  if (!gardener) {
    return (
      <main className="auth-wrap">
        <div className="card auth-card">
          <div className="auth-hero">
            <div className="emoji">🌿</div>
            <h1>{data.garden.name}</h1>
            <p className="muted">Who&rsquo;s gardening on this device?</p>
          </div>
          <GardenerPicker />
        </div>
      </main>
    );
  }
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <Logo />
          </Link>
          <Nav />
          <span className="spacer" />
          <span className="who">
            {gardener}
            <button className="ghost small" onClick={() => setGardener(null)}>Switch</button>
          </span>
        </div>
      </header>
      <main className="shell">
        <Outlet />
      </main>
      <AssistantPanel />
      <RainSync />
      <IrrigationSync />
    </>
  );
}

function NotFound() {
  return (
    <div className="page-head">
      <div>
        <h1>Not found</h1>
        <p className="sub">That page isn&rsquo;t in this garden. <Link to="/">Back home</Link></p>
      </div>
    </div>
  );
}

// Hash routing keeps deep links working on GitHub Pages, which has no server-side rewrites.
const router = createHashRouter([
  {
    element: <Layout />,
    children: [
      // The home page is the map, the biggest page by far, so it and the map page load in their own chunk, after the app's shell.
      { path: "/", lazy: async () => ({ Component: (await import("./pages/Home")).HomePage }) },
      { path: "/trays", element: <TraysPage /> },
      { path: "/trays/new", element: <NewTrayPage /> },
      { path: "/trays/:id", element: <TrayPage /> },
      { path: "/calendar", element: <CalendarPage /> },
      { path: "/map", lazy: async () => ({ Component: (await import("./pages/Map")).MapPage }) },
      { path: "/plantings/:id", element: <PlantingPage /> },
      { path: "/plants", element: <PlantsPage /> },
      { path: "/plants/new", element: <NewPlantPage /> },
      { path: "/plants/:id", element: <PlantPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GardenProvider>
      <RouterProvider router={router} />
    </GardenProvider>
  </StrictMode>,
);
