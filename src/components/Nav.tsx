import { NavLink } from "react-router";

const LINKS = [
  { to: "/", label: "Home", end: true },
  { to: "/calendar", label: "Calendar" },
  { to: "/trays", label: "Planters" },
  { to: "/map", label: "Map" },
  { to: "/plants", label: "Seed library" },
  { to: "/settings", label: "Settings" },
];

export function Nav() {
  return (
    <nav className="nav">
      {LINKS.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? "active" : "")}>
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
}
