// Tiny DOM builders shared by app.js and chart.js. Text always goes in as text nodes,
// never parsed as HTML, so values read from JSON files cannot inject markup.
const SVG_NS = "http://www.w3.org/2000/svg";

function build(el, attrs, children) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** h("p", { class: "x" }, "text", childNode) */
export const h = (tag, attrs, ...children) => build(document.createElement(tag), attrs, children);
export const svg = (tag, attrs, ...children) => build(document.createElementNS(SVG_NS, tag), attrs, children);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const formatters = new Map();
/** en-US number with a fixed number of decimals and thousands separators. */
export function num(value, digits = 0) {
  if (!formatters.has(digits)) {
    formatters.set(digits, new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return formatters.get(digits).format(value);
}

/** Small inline icons (stroke = currentColor), so state is never carried by color alone. */
const ICONS = {
  check: "M4 10.5l4 4 8-9",
  cross: "M5 5l10 10M15 5L5 15",
  clock: "M10 5v5l3 2M10 2.5a7.5 7.5 0 100 15 7.5 7.5 0 000-15z",
  dash: "M5 10h10",
  copy: "M7 7h9v9H7zM4 13V4h9",
  link: "M8 12l4-4M9 5.5l1.5-1.5a3.5 3.5 0 015 5L14 10.5M11 14.5L9.5 16a3.5 3.5 0 01-5-5L6 9.5",
  alert: "M10 3L18 17H2zM10 8.5v3.5M10 14.6v.1",
};
export function icon(name, cls = "icon") {
  return svg("svg", { class: cls, viewBox: "0 0 20 20", width: 16, height: 16, "aria-hidden": "true", focusable: "false" },
    svg("path", { d: ICONS[name], fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
}
