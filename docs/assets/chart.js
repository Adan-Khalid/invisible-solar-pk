// Inline SVG line chart of one region's two-week hourly series (AEMO rooftop PV vs our
// estimate, optional net load) with a crosshair readout that also works from the keyboard.
// Redrawn at the real pixel width so text stays legible on phones.
import { h, svg, num } from "./dom.js";

const SERIES = [
  { key: "est", field: "pv_estimated_mw", label: "Our estimate" },
  { key: "pv", field: "pv_measured_mw", label: "AEMO rooftop PV" },
  { key: "net", field: "net_load_mw", label: "Net load (what the meter sees)", optional: true },
];
const DRAW_ORDER = ["net", "pv", "est"]; // estimate on top
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400e3;
const KEY_STEPS = { ArrowLeft: -1, ArrowRight: 1, PageUp: -24, PageDown: 24 };
const MAX_HEIGHT = 520; // px; a very tall side panel leaves space below the chart rather than stretching it

/** "2024-10-07T00:00" -> epoch ms, reading the wall-clock time as UTC so nothing shifts by time zone. */
export function parseStamp(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(stamp || "");
  if (!m) throw new Error(`unexpected timestamp "${stamp}"`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}
export const dayLabel = (ms, long = false) => {
  const d = new Date(ms);
  const short = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return long ? `${DAYS[d.getUTCDay()]} ${short}` : short;
};
const timeLabel = (ms) => {
  const d = new Date(ms);
  return `${dayLabel(ms, true)} ${d.getUTCFullYear()}, ${String(d.getUTCHours()).padStart(2, "0")}:00`;
};

/** Round axis: min/max snapped to a 1-2-2.5-5 step and the tick values in between. */
export function niceScale(lo, hi, target = 4) {
  const raw = Math.max(hi - lo, 1) / target;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v));
  return { min, max, ticks };
}

const pathOf = (values, X, Y) => values.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join("");

function legendItem(series) {
  return h("li", { class: `legend__item legend__item--${series.key}` },
    svg("svg", { class: "legend__key", width: 22, height: 10, viewBox: "0 0 22 10", "aria-hidden": "true" },
      svg("line", { x1: 1, x2: 21, y1: 5, y2: 5, class: `line line--${series.key}` })),
    series.label);
}

export function createChart(region) {
  const s = region.series;
  const n = s.pv_measured_mw.length;
  const t0 = parseStamp(s.start);
  const stepMs = s.step_hours * 3600e3;
  const timeAt = (i) => t0 + i * stepMs;
  const state = { showNet: false, idx: null, width: 0, height: 0, heldPx: 0, geo: null, keyboard: false };
  const id = `chart-${region.station.replace(/\W+/g, "-").toLowerCase()}`;
  const range = `${dayLabel(timeAt(0))} to ${dayLabel(timeAt(n - 1))} ${new Date(timeAt(0)).getUTCFullYear()}`;

  const legend = h("ul", { class: "legend", "aria-label": "Series" });
  const canvas = svg("svg", { class: "chart__svg", "aria-hidden": "true", focusable: "false" });
  const tip = h("div", { class: "chart__tip", hidden: true, "aria-hidden": "true" });
  const live = h("p", { class: "sr-only", "aria-live": "polite" });
  const plot = h("div", {
    class: "chart__plot", tabindex: 0, role: "group", "aria-roledescription": "chart",
    "aria-label": `${region.name}: hourly AEMO rooftop PV and our estimate, ${range}. Use the arrow keys to read hourly values; Page Up and Page Down jump a day.`,
  }, canvas, tip);
  const root = h("figure", { class: "chart", id },
    legend, plot, live,
    h("figcaption", { class: "chart__caption" },
      `Hourly MW, ${range} (AEST, hour-beginning). Net load and AEMO rooftop PV are rows of the evidence file; the estimate is the model output from net load and irradiance alone.`));

  const active = () => SERIES.filter((x) => !x.optional || state.showNet);

  function renderLegend() {
    legend.replaceChildren(...active().map(legendItem));
  }

  function draw() {
    const width = Math.round(plot.clientWidth);
    if (!width) return;
    const narrow = width < 520;
    // The SVG is absolutely positioned, so the plot's height comes from CSS (min-height, or the
    // flex space next to a taller side panel) and never from the drawing: no resize feedback loop.
    plot.style.minHeight = `${Math.max(narrow ? 240 : 290, state.heldPx)}px`;
    const height = Math.min(MAX_HEIGHT, Math.round(plot.clientHeight));
    state.width = width;
    state.height = Math.round(plot.clientHeight);
    const m = { top: 26, right: 12, bottom: 30, left: narrow ? 46 : 54 };
    const pw = width - m.left - m.right;
    const ph = height - m.top - m.bottom;
    const shown = active();
    const values = shown.flatMap((x) => s[x.field]);
    const scale = niceScale(Math.min(0, ...values), Math.max(...values), narrow ? 3 : 4);
    const X = (i) => m.left + (i / (n - 1)) * pw;
    const Y = (v) => m.top + (1 - (v - scale.min) / (scale.max - scale.min)) * ph;
    state.geo = { m, pw, X, Y, height };

    const grid = scale.ticks.map((v) => svg("g", { class: v === 0 ? "tick tick--zero" : "tick" },
      svg("line", { x1: m.left, x2: width - m.right, y1: Y(v), y2: Y(v) }),
      svg("text", { x: m.left - 8, y: Y(v) + 4, "text-anchor": "end" }, num(v))));

    const dayW = (24 / (n - 1)) * pw;
    const longDays = dayW >= 74;
    const stride = Math.max(1, Math.ceil((longDays ? 66 : 44) / dayW));
    const days = [];
    for (let i = 0, d = 0; i < n; i++) {
      if ((timeAt(i) % DAY_MS) !== 0) continue;
      if (i > 0) days.push(svg("line", { class: "daysep", x1: X(i), x2: X(i), y1: m.top, y2: m.top + ph }));
      const mid = Math.min(i + 12, n - 1);
      if (d % stride === 0 && X(mid) + 24 < width) {
        days.push(svg("text", { class: "daylabel", x: X(mid), y: height - 9, "text-anchor": "middle" }, dayLabel(timeAt(i), longDays)));
      }
      d++;
    }

    const lines = DRAW_ORDER.map((k) => shown.find((x) => x.key === k)).filter(Boolean).map((x) => {
      const d = pathOf(s[x.field], X, Y);
      const area = x.key === "pv" ? svg("path", { class: "area area--pv", d: `${d}L${X(n - 1).toFixed(1)} ${Y(0).toFixed(1)}L${X(0).toFixed(1)} ${Y(0).toFixed(1)}Z` }) : null;
      return [area, svg("path", { class: `line line--${x.key}`, d })];
    });

    const hover = svg("g", { class: "hover", visibility: "hidden" },
      svg("line", { class: "hover__line", y1: m.top, y2: m.top + ph }),
      shown.map((x) => svg("circle", { class: `hover__dot hover__dot--${x.key}`, r: 4, "data-key": x.key })));

    canvas.setAttribute("viewBox", `0 0 ${width} ${height}`);
    canvas.setAttribute("width", width);
    canvas.setAttribute("height", height);
    canvas.replaceChildren(
      svg("text", { class: "unit", x: m.left - 8, y: 12, "text-anchor": "end" }, "MW"),
      ...days, ...grid, ...lines.flat(), hover);
    if (state.idx !== null && !tip.hidden) showAt(state.idx);
  }

  function showAt(i) {
    if (!state.geo) return;
    const idx = Math.max(0, Math.min(n - 1, i));
    state.idx = idx;
    const { X, Y, m } = state.geo;
    const x = X(idx);
    const hover = canvas.querySelector(".hover");
    hover.setAttribute("visibility", "visible");
    const line = hover.querySelector(".hover__line");
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    for (const dot of hover.querySelectorAll("circle")) {
      const f = SERIES.find((x2) => x2.key === dot.dataset.key).field;
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", Y(s[f][idx]));
    }
    const rows = active().map((x2) => h("li", { class: `tip__row tip__row--${x2.key}` },
      h("span", { class: "tip__key", "aria-hidden": "true" }),
      h("strong", {}, num(s[x2.field][idx])), " MW ", h("span", { class: "tip__label" }, x2.label)));
    tip.replaceChildren(h("p", { class: "tip__time" }, timeLabel(timeAt(idx))), h("ul", {}, rows));
    tip.hidden = false;
    const flip = x > state.width * 0.58;
    tip.style.left = `${flip ? x - 12 : x + 12}px`;
    tip.style.top = `${m.top + 4}px`;
    tip.classList.toggle("chart__tip--flip", flip);
    if (state.keyboard) {
      live.textContent = `${timeLabel(timeAt(idx))}: ${active().map((x2) => `${x2.label} ${num(s[x2.field][idx])} megawatts`).join(", ")}.`;
    }
  }

  function hide() {
    tip.hidden = true;
    canvas.querySelector(".hover")?.setAttribute("visibility", "hidden");
  }

  function indexAt(clientX) {
    const r = plot.getBoundingClientRect();
    const { m, pw } = state.geo;
    return Math.round(((clientX - r.left - m.left) / pw) * (n - 1));
  }

  plot.addEventListener("pointermove", (e) => { if (state.geo) { state.keyboard = false; showAt(indexAt(e.clientX)); } });
  plot.addEventListener("pointerleave", () => { if (document.activeElement !== plot) hide(); });
  plot.addEventListener("focus", () => { state.keyboard = true; showAt(state.idx ?? s.pv_measured_mw.indexOf(Math.max(...s.pv_measured_mw))); });
  plot.addEventListener("blur", hide);
  plot.addEventListener("keydown", (e) => {
    let next = null;
    if (e.key in KEY_STEPS) next = (state.idx ?? 0) + KEY_STEPS[e.key];
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") { hide(); return; }
    if (next === null) return;
    e.preventDefault();
    state.keyboard = true;
    showAt(next);
  });

  let frame = 0;
  new ResizeObserver(() => {
    if (Math.round(plot.clientWidth) === state.width && Math.round(plot.clientHeight) === state.height) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }).observe(plot);

  renderLegend();
  return {
    root,
    /** Keep the current height while content below the chart (the daily table) is open. */
    holdHeight(on) {
      state.heldPx = on ? Math.min(MAX_HEIGHT, Math.round(plot.clientHeight)) : 0;
      draw();
    },
    setShowNet(on) {
      state.showNet = Boolean(on);
      renderLegend();
      draw();
    },
  };
}

/** Daily energy (GWh) of the charted fortnight: a table view of the same numbers. */
export function dailyTable(region) {
  const s = region.series;
  const t0 = parseStamp(s.start);
  const perDay = Math.round(24 / s.step_hours);
  const rows = [];
  for (let i = 0; i + perDay <= s.pv_measured_mw.length; i += perDay) {
    const sum = (arr) => arr.slice(i, i + perDay).reduce((a, b) => a + b, 0) * s.step_hours / 1000;
    const truth = sum(s.pv_measured_mw);
    const est = sum(s.pv_estimated_mw);
    rows.push(h("tr", {},
      h("th", { scope: "row" }, dayLabel(t0 + i * s.step_hours * 3600e3, true)),
      h("td", {}, num(truth, 1)), h("td", {}, num(est, 1)),
      h("td", {}, truth > 0 ? `${num((100 * est) / truth, 0)}%` : "n/a")));
  }
  return h("details", { class: "daily" },
    h("summary", {}, "Daily energy table"),
    h("div", { class: "table-scroll" },
      h("table", { class: "daily__table" },
        h("caption", { class: "sr-only" }, `${region.name}: daily rooftop PV energy, AEMO vs our estimate`),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Day"), h("th", { scope: "col" }, "AEMO PV, GWh"),
          h("th", { scope: "col" }, "Estimate, GWh"), h("th", { scope: "col" }, "Estimate / AEMO"))),
        h("tbody", {}, rows))));
}
