// Fallback connector for anything without a machine-readable schema.
// Fetches the target, infers a structural schema from JSON responses, or
// extracts readable text and links from HTML pages, and lets Claude work from that.

import { fetchText, tryParseJson } from "../http.js";

export const kind = "generic";

const MAX_TEXT = 60000;

export async function load(target, { headers }) {
  const res = await fetchText(target, { headers: { Accept: "application/json, text/html;q=0.9, */*;q=0.5", ...headers } });
  if (res.status >= 400) {
    throw new Error(`${target} responded with HTTP ${res.status}. Check the URL and pass credentials with --header or --bearer.`);
  }

  const json = tryParseJson(res.body);
  if (json !== undefined) {
    const shape = inferShape(json);
    return {
      kind,
      source: res.url,
      title: "JSON API",
      raw: { sample: json, inferredShape: shape },
      summary: [
        "# JSON response (no formal schema found)",
        `Fetched: ${res.url}`,
        "",
        "## Inferred structure",
        JSON.stringify(shape, null, 2),
        "",
        "## Sample (trimmed)",
        trimText(JSON.stringify(trimSample(json), null, 2)),
      ].join("\n"),
    };
  }

  const isHtml = /html/i.test(res.contentType) || /<html[\s>]/i.test(res.body);
  const text = isHtml ? htmlToText(res.body) : res.body;
  const links = isHtml ? extractLinks(res.body, res.url) : [];
  return {
    kind,
    source: res.url,
    title: (isHtml && res.body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim()) || "Application",
    raw: res.body,
    summary: [
      `# ${isHtml ? "Web page" : "Document"} (no formal schema found)`,
      `Fetched: ${res.url}`,
      links.length ? `\n## Links that may point at API docs\n${links.map((l) => `- ${l}`).join("\n")}` : "",
      "",
      "## Content",
      trimText(text),
    ].join("\n"),
  };
}

/** Build a type skeleton from an example value: { id: "number", tags: ["string"], ... }. */
export function inferShape(value, depth = 0) {
  if (depth > 6) return "...";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (!value.length) return [];
    // Merge the shapes of the first few items so optional fields show up.
    const merged = value.slice(0, 5).map((v) => inferShape(v, depth + 1)).reduce(mergeShapes);
    return [merged];
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, inferShape(v, depth + 1)]));
  }
  return typeof value;
}

function mergeShapes(a, b) {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? mergeShapes(out[k], v) : v;
    return out;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  return typeof a === "string" && typeof b === "string" ? `${a}|${b}` : a;
}

function trimSample(value, depth = 0) {
  if (Array.isArray(value)) return value.slice(0, 3).map((v) => trimSample(v, depth + 1));
  if (value && typeof value === "object") {
    if (depth > 5) return "{...}";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimSample(v, depth + 1)]));
  }
  if (typeof value === "string" && value.length > 200) return `${value.slice(0, 200)}...`;
  return value;
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function extractLinks(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>/gi)) {
    if (!/api|doc|developer|reference|swagger|openapi|graphql/i.test(m[1])) continue;
    try {
      out.add(new URL(m[1], base).href);
    } catch {
      // ignore malformed hrefs
    }
    if (out.size >= 25) break;
  }
  return [...out];
}

function trimText(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[content truncated: ${text.length - MAX_TEXT} more characters not shown]` : text;
}
