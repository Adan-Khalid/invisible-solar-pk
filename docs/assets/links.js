// Link helpers for the demo page (no DOM, so docs/assets/verify.test.mjs can import them).
// Only absolute https:// URLs ever become an href: a hand-edited config.js or a deployment record
// cannot turn a link into javascript:, data: or a plain-http page.

export const LINK_KEYS = ["REPO_URL", "VIDEO_URL", "PAPER_URL"];

/** True for "", undefined and values that still hold a <placeholder>. */
export const isPlaceholder = (value) => !value || /[<>]/.test(String(value));

/** The trimmed URL when it is an absolute https:// URL without a user name or password, else "". */
export function safeHttps(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!/^https:\/\//i.test(text)) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? text : "";
  } catch {
    return "";
  }
}

/** `${base}/${kind}/${id}` for a block explorer, or "" unless base is https:// and id is 0x-hex. */
export function explorerUrl(base, kind, id) {
  const root = safeHttps(base).replace(/\/+$/, "");
  return root && /^0x[0-9a-fA-F]+$/.test(String(id ?? "")) ? `${root}/${kind}/${id}` : "";
}

/**
 * Header and footer links from config.js. A placeholder REPO_URL is inferred on <user>.github.io/<repo>/;
 * placeholders and anything that is not https:// come back as "" (the page hides that link).
 */
export function resolveLinks(config, loc) {
  const links = Object.fromEntries(LINK_KEYS.map((k) => [k, config?.[k]]));
  if (isPlaceholder(links.REPO_URL) && /\.github\.io$/i.test(loc?.hostname || "")) {
    const repo = String(loc.pathname || "").split("/").filter(Boolean)[0];
    if (repo && !/\.html?$/i.test(repo)) links.REPO_URL = `https://github.com/${loc.hostname.split(".")[0]}/${repo}`;
  }
  return Object.fromEntries(LINK_KEYS.map((k) => [k, isPlaceholder(links[k]) ? "" : safeHttps(links[k])]));
}
