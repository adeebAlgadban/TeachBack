#!/usr/bin/env node
// Local web UI for api-describer. Serves the page in public/ and exposes one
// streaming endpoint that runs discover() + describe() and reports progress as
// Server-Sent Events.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { discover, CONNECTORS } from "./discover.js";
import { describe, DEFAULT_MODEL } from "./describe.js";
import { parseHeaderList } from "./http.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(root, "public");

const STATIC = {
  "/": [path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8"],
  "/app.js": [path.join(PUBLIC_DIR, "app.js"), "text/javascript; charset=utf-8"],
  "/styles.css": [path.join(PUBLIC_DIR, "styles.css"), "text/css; charset=utf-8"],
  "/vendor/marked.esm.js": [path.join(root, "node_modules/marked/lib/marked.esm.js"), "text/javascript; charset=utf-8"],
};

// Generated descriptions come from untrusted schemas, so the page may only run its own scripts.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const MAX_BODY = 20 * 1024 * 1024;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (req.method === "GET" && pathname === "/api/config") {
        return sendJson(res, 200, {
          defaultModel: DEFAULT_MODEL,
          types: ["auto", ...Object.keys(CONNECTORS)],
          efforts: EFFORTS,
          hasCredentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE),
        });
      }
      if (req.method === "POST" && pathname === "/api/describe") return await handleDescribe(req, res);
      if (req.method === "GET" && STATIC[pathname]) {
        const [file, type] = STATIC[pathname];
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
        return res.end(await fs.readFile(file));
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    }
  });
}

async function handleDescribe(req, res) {
  // Only accept JSON from this page. A JSON content type forces a CORS
  // preflight, so other websites can't drive the server (and spend API credit).
  if (!/^application\/json/.test(req.headers["content-type"] ?? "")) return sendJson(res, 415, { error: "Expected application/json" });
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return sendJson(res, 403, { error: "Cross-origin requests are not allowed" });

  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, 400, { error: `Invalid request: ${err.message}` });
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Stop calling Claude if the user cancels or closes the tab.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let tempDir;
  try {
    const headers = parseHeaderList(String(input.headers ?? "").split("\n").map((h) => h.trim()).filter(Boolean));
    if (input.bearer) headers.Authorization = `Bearer ${input.bearer}`;

    let target = String(input.target ?? "").trim();
    if (input.file?.content) {
      // Uploaded schema: write it to a temp file so the connectors can read it like any local file.
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "api-describer-"));
      target = path.join(tempDir, path.basename(input.file.name || "schema.txt"));
      await fs.writeFile(target, input.file.content);
    }
    if (!target) throw new Error("Enter a URL or choose a schema file.");

    send("log", { message: `Connecting to ${input.file?.name ?? target}` });
    const schema = await discover(target, { type: input.type || "auto", headers, log: (message) => send("log", { message }) });
    const source = input.file ? input.file.name : schema.source;
    send("schema", {
      kind: schema.kind,
      title: schema.title,
      source,
      summary: schema.summary,
      raw: typeof schema.raw === "string" ? schema.raw : JSON.stringify(schema.raw, null, 2),
    });
    send("log", { message: `Found ${schema.kind} schema (${schema.summary.length.toLocaleString()} chars condensed)` });

    if (input.dryRun) {
      send("done", { dryRun: true });
      return res.end();
    }

    const model = input.model || DEFAULT_MODEL;
    const effort = EFFORTS.includes(input.effort) ? input.effort : "high";
    send("log", { message: `Asking ${model} to describe it...` });
    const result = await describe({ ...schema, source }, {
      model,
      effort,
      audience: input.audience || undefined,
      signal: abort.signal,
      onText: (text) => send("text", { text }),
    });
    send("done", { usage: result.usage, model: result.model, text: result.text });
  } catch (err) {
    if (!abort.signal.aborted) send("error", { message: friendlyError(err) });
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    res.end();
  }
}

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError || /Could not resolve authentication/.test(err.message)) {
    return "Anthropic API authentication failed. Set ANTHROPIC_API_KEY (or run `ant auth login`) before starting the server. You can still use \"Preview schema\" without a key.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API - wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return err.message;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Request too large (20 MB max)"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 3000;
  // Loopback only by default: the server fetches arbitrary URLs on request, so
  // it shouldn't be reachable from the network unless you opt in with HOST.
  const host = process.env.HOST || "127.0.0.1";
  createServer().listen(port, host, () => {
    console.log(`api-describer UI running at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  });
}
