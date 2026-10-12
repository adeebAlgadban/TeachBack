// Small fetch wrapper shared by every connector.
// Handles auth headers, timeouts, and reading local files with the same call.

import fs from "node:fs/promises";

export function isUrl(target) {
  return /^https?:\/\//i.test(target);
}

/**
 * Fetch a URL (or read a local file) and return { status, contentType, body, url }.
 * Never throws on HTTP error codes - callers decide what a 404 means.
 */
export async function fetchText(target, { headers = {}, method = "GET", body, timeoutMs = 20000 } = {}) {
  if (!isUrl(target)) {
    const text = await fs.readFile(target, "utf8");
    return { status: 200, contentType: guessContentType(target, text), body: text, url: target };
  }

  let res;
  try {
    res = await fetch(target, {
      method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // undici reports everything as "fetch failed"; the useful detail is in `cause`.
    const detail = err.cause?.message ?? err.cause?.code ?? err.message;
    throw new Error(`Could not connect to ${target}: ${detail}`, { cause: err });
  }
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    body: await res.text(),
    url: res.url || target,
  };
}

export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function guessContentType(path, text) {
  if (/\.ya?ml$/i.test(path)) return "application/yaml";
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.(graphql|gql)$/i.test(path)) return "application/graphql";
  if (/\.xml$/i.test(path) || text.trimStart().startsWith("<")) return "application/xml";
  return "text/plain";
}

/** Parse "Name: value" strings from the CLI into a headers object. */
export function parseHeaderList(list = []) {
  const headers = {};
  for (const entry of list) {
    const idx = entry.indexOf(":");
    if (idx <= 0) throw new Error(`Invalid header "${entry}" - expected "Name: value"`);
    headers[entry.slice(0, idx).trim()] = entry.slice(idx + 1).trim();
  }
  return headers;
}
