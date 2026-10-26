import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { calendarEntries, monthGrid, type CalendarEntry } from "@/lib/calendar";
import { formatDate } from "@/lib/dates";
import { setGaugeRain } from "@/lib/actions";
import { useGarden } from "@/lib/GardenContext";
import { RAIN_WATERS_IN } from "@/lib/weather/rain";
import type { FrostDates } from "@/lib/weather/climate";
import { formatTemp, prefersFahrenheit, type DayForecast } from "@/lib/weather/forecast";
import { useForecast, useFrostDates } from "@/lib/weather/useWeather";

/** The average frost and hard-freeze dates, keyed by MM-DD. */
function frostMarks(f: FrostDates | null): Map<string, { icon: string; text: string; detail: string }[]> {
  const marks = new Map<string, { icon: string; text: string; detail: string }[]>();
  if (!f) return marks;
  const add = (md: string | null, icon: string, text: string, detail: string) => {
    if (md) marks.set(md, [...(marks.get(md) ?? []), { icon, text, detail }]);
  };
  add(f.lastHardFreeze, "🧊", "Last hard freeze", "Average last hard freeze (28°F / −2°C) of spring");
  add(f.lastFrost, "❄️", "Last frost", "Average last frost (32°F / 0°C) of spring");
  add(f.firstFrost, "❄️", "First frost", "Average first frost (32°F / 0°C) of autumn");
  add(f.firstHardFreeze, "🧊", "First hard freeze", "Average first hard freeze (28°F / −2°C) of autumn");
  return marks;
}

const mdLabel = (md: string | null) => (md ? new Date(Date.UTC(2001, Number(md.slice(0, 2)) - 1, Number(md.slice(3)))).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "rarely");

/** What the garden's own rain gauge read on a day: overrides the weather record for that day. */
function RainGauge({ date }: { date: string }) {
  const { data, act } = useGarden();
  const day = (data.rain ?? []).find((r) => r.date === date);
  const [value, setValue] = useState(day?.source === "gauge" ? String(day.inches) : "");
  const save = (inches: number | null) => act((ctx) => setGaugeRain(ctx, date, inches));
  return (
    <form
      className="rain-gauge small"
      onSubmit={(e) => {
        e.preventDefault();
        const v = Number(value);
        if (value.trim() !== "" && Number.isFinite(v) && v >= 0) save(v);
      }}
    >
      <span>🌧️ Rain gauge</span>
      <input type="number" step="0.01" min="0" value={value} placeholder={day ? day.inches.toFixed(2) : "0.00"} onChange={(e) => setValue(e.target.value)} aria-label="Inches of rain" />
      <span>in</span>
      <button className="small">Save</button>
      {day?.source === "gauge" && (
        <button type="button" className="ghost small" onClick={() => { setValue(""); save(null); }}>
          Use the weather record
        </button>
      )}
      <span className="muted">
        {day
          ? day.source === "gauge"
            ? "From your gauge."
            : day.source === "expected"
              ? `Rain likely today (${day.chance ?? "?"}%); the measured amount replaces this tomorrow.`
              : `Weather record: ${day.inches.toFixed(2)} in.`
          : "No rain recorded for this day yet."}{" "}
        {RAIN_WATERS_IN} in or more counts as watering for the beds outdoors.
      </span>
    </form>
  );
}

function ForecastBadge({ f, fahrenheit }: { f: DayForecast; fahrenheit: boolean }) {
  return (
    <span className="cal-weather" title={`${f.summary}${f.precip != null ? `, ${f.precip}% chance of rain` : ""}`}>
      <span>{f.icon}</span>
      <span className="temps">{f.high != null ? formatTemp(f.high, fahrenheit) : ""}{f.low != null ? `/${formatTemp(f.low, fahrenheit)}` : ""}</span>
    </span>
  );
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PER_DAY = 4;

function Entry({ e, full }: { e: CalendarEntry; full?: boolean }) {
  const body = (
    <>
      <span className="cal-icon">{e.icon}</span>
      <span className="cal-text">{full ? e.detail : e.text}</span>
    </>
  );
  return e.href ? (
    <Link to={e.href} className={`cal-entry ${e.kind}`} title={e.detail}>{body}</Link>
  ) : (
    <span className={`cal-entry ${e.kind}`} title={e.detail}>{body}</span>
  );
}

export function CalendarPage() {
  const { data, today } = useGarden();
  const [params, setParams] = useSearchParams();
  const month = params.get("m") ?? today.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const [selected, setSelected] = useState<string>(today);

  const days = monthGrid(y, m - 1);
  const entries = calendarEntries(data, today, days[0], days.at(-1)!);
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);

  const go = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setParams({ m: d.toISOString().slice(0, 7) });
  };
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const selectedEntries = byDay.get(selected) ?? [];
  const forecast = useForecast();
  const frost = useFrostDates();
  const fahrenheit = prefersFahrenheit();
  const weatherByDay = new Map(forecast.status === "ready" ? forecast.value.days.map((f) => [f.date, f]) : []);
  const marks = frostMarks(frost.status === "ready" ? frost.value : null);

  return (
    <>
      <div className="page-head cal-head">
        <div className="row">
          <button className="small" onClick={() => { setParams({}); setSelected(today); }}>Today</button>
          <button className="ghost" onClick={() => go(-1)} aria-label="Previous month">‹</button>
          <button className="ghost" onClick={() => go(1)} aria-label="Next month">›</button>
          <h1 style={{ margin: 0 }}>{title}</h1>
        </div>
        <div className="row small muted cal-legend">
          <span className="cal-entry logged">done</span>
          <span className="cal-entry scheduled">planned</span>
          <span className="cal-entry overdue">overdue</span>
          <span className="cal-entry task">reminder</span>
          <span className="cal-entry rain">rain</span>
        </div>
      </div>

      <div className="calendar">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-weekday">{w}</div>
        ))}
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const other = d.slice(0, 7) !== month;
          return (
            <div
              key={d}
              className={`cal-day ${other ? "other" : ""} ${d === selected ? "selected" : ""}`}
              onClick={() => setSelected(d)}
            >
              <div className="cal-day-head">
                <span className={`cal-date ${d === today ? "today" : ""}`}>{Number(d.slice(8))}</span>
                {weatherByDay.get(d) && <ForecastBadge f={weatherByDay.get(d)!} fahrenheit={fahrenheit} />}
              </div>
              {(marks.get(d.slice(5)) ?? []).map((m) => (
                <span key={m.text} className="cal-entry climate" title={m.detail}>
                  <span className="cal-icon">{m.icon}</span>
                  <span className="cal-text">{m.text}</span>
                </span>
              ))}
              {list.slice(0, PER_DAY).map((e, i) => (
                <Entry key={i} e={e} />
              ))}
              {list.length > PER_DAY && <span className="cal-more">{list.length - PER_DAY} more</span>}
            </div>
          );
        })}
      </div>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>{formatDate(selected, { weekday: true, year: true })}</h3>
        {weatherByDay.get(selected) && (
          <p className="small">
            {weatherByDay.get(selected)!.icon} {weatherByDay.get(selected)!.summary}
            {weatherByDay.get(selected)!.high != null && `, high ${formatTemp(weatherByDay.get(selected)!.high, fahrenheit)}`}
            {weatherByDay.get(selected)!.low != null && `, low ${formatTemp(weatherByDay.get(selected)!.low, fahrenheit)}`}
            {weatherByDay.get(selected)!.precip != null && `, ${weatherByDay.get(selected)!.precip}% chance of rain`}
          </p>
        )}
        {(marks.get(selected.slice(5)) ?? []).map((m) => <p key={m.text} className="small">{m.icon} {m.detail}</p>)}
        {selected <= today && <RainGauge key={selected} date={selected} />}
        {selectedEntries.length ? (
          <div className="stack" style={{ gap: 6 }}>
            {selectedEntries.map((e, i) => (
              <Entry key={i} e={e} full />
            ))}
          </div>
        ) : (
          <p className="empty">Nothing logged or planned.</p>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Frost dates</h3>
        {frost.status === "no-location" && (
          <p className="small muted">Set the garden&rsquo;s location (Map → The lot) to see its average frost dates and the week&rsquo;s forecast.</p>
        )}
        {frost.status === "loading" && <p className="small muted">Working out frost dates from 30 years of weather…</p>}
        {frost.status === "error" && (
          <p className="small error">Couldn&rsquo;t get frost dates: {frost.error} <button className="ghost small" onClick={frost.retry}>Try again</button></p>
        )}
        {frost.status === "ready" && (
          <>
            <div className="frost-grid">
              <div><span className="muted small">Last hard freeze</span><strong>🧊 {mdLabel(frost.value.lastHardFreeze)}</strong></div>
              <div><span className="muted small">Last frost</span><strong>❄️ {mdLabel(frost.value.lastFrost)}</strong></div>
              <div><span className="muted small">First frost</span><strong>❄️ {mdLabel(frost.value.firstFrost)}</strong></div>
              <div><span className="muted small">First hard freeze</span><strong>🧊 {mdLabel(frost.value.firstHardFreeze)}</strong></div>
            </div>
            <p className="small muted">
              {`Averages over ${frost.value.years} years of daily lows (frost 32°F / 0°C, hard freeze 28°F / −2°C)${
                frost.value.frostYears < frost.value.years ? `; it froze in ${frost.value.frostYears} of them` : ""
              }. `}
              From Open-Meteo&rsquo;s weather history, on a grid about 10 km across: a low spot in the yard can be colder.
            </p>
          </>
        )}
        {forecast.status === "ready" && <p className="small muted">Forecast from {forecast.value.source}.</p>}
        {forecast.status === "error" && <p className="small muted">The forecast is unavailable right now ({forecast.error}).</p>}
      </section>
    </>
  );
}

/** Each kind of entry's dot in the small calendar, in the order they're shown. */
const DOT_ORDER: CalendarEntry["kind"][] = ["overdue", "scheduled", "task", "logged", "sown", "rain", "task-done"];

/**
 * The calendar in a narrow column (the home page's Calendar tab): a month of days, each with a colored dot per kind of entry.
 * Tap a day for its list; the full calendar is a link away.
 */
export function MiniCalendar() {
  const { data, today } = useGarden();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, setSelected] = useState(today);
  const [y, m] = month.split("-").map(Number);
  const days = monthGrid(y, m - 1);
  const byDay = new Map<string, CalendarEntry[]>();
  for (const e of calendarEntries(data, today, days[0], days.at(-1)!)) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const forecast = useForecast();
  const weather = forecast.status === "ready" ? forecast.value.days.find((f) => f.date === selected) : undefined;
  const go = (delta: number) => setMonth(new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7));
  const title = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const list = byDay.get(selected) ?? [];

  return (
    <div className="mini-cal">
      <div className="mini-cal-head">
        <button className="ghost" onClick={() => go(-1)} aria-label="Previous month">‹</button>
        <strong>{title}</strong>
        <button className="ghost" onClick={() => go(1)} aria-label="Next month">›</button>
        <span className="spacer" />
        {month !== today.slice(0, 7) && <button className="ghost small" onClick={() => { setMonth(today.slice(0, 7)); setSelected(today); }}>Today</button>}
        <Link to={`/calendar?m=${month}`} className="small">Full calendar</Link>
      </div>
      <div className="mini-cal-grid">
        {WEEKDAYS.map((w) => (
          <div key={w} className="cal-weekday">{w[0]}</div>
        ))}
        {days.map((d) => {
          const kinds = new Set((byDay.get(d) ?? []).map((e) => e.kind));
          return (
            <button
              key={d}
              className={`mini-cal-day ${d.slice(0, 7) !== month ? "other" : ""} ${d === selected ? "selected" : ""}`}
              onClick={() => setSelected(d)}
              aria-label={`${formatDate(d, { weekday: true })}: ${(byDay.get(d) ?? []).length || "nothing"}`}
            >
              <span className={`cal-date ${d === today ? "today" : ""}`}>{Number(d.slice(8))}</span>
              <span className="mini-cal-dots">
                {DOT_ORDER.filter((k) => kinds.has(k)).map((k) => <i key={k} className={`dot ${k}`} />)}
              </span>
            </button>
          );
        })}
      </div>
      <h4>{formatDate(selected, { weekday: true })}{weather ? ` · ${weather.icon} ${weather.summary}` : ""}</h4>
      {list.length ? (
        <div className="stack" style={{ gap: 6 }}>
          {list.map((e, i) => (
            <Entry key={i} e={e} full />
          ))}
        </div>
      ) : (
        <p className="empty">Nothing logged or planned.</p>
      )}
    </div>
  );
}
