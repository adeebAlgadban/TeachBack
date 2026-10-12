import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../src/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function parseEvents(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => ({
      event: block.match(/^event: (.*)$/m)[1],
      data: JSON.parse(block.match(/^data: (.*)$/m)[1]),
    }));
}

test("serves the page with a strict CSP", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(await res.text(), /API Describer/);
  assert.equal((await fetch(`${base}/vendor/marked.esm.js`)).status, 200);
});

test("config lists the schema types", async () => {
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.deepEqual(config.types, ["auto", "openapi", "graphql", "odata", "generic"]);
});

test("dry run on an uploaded file streams log + schema events", async () => {
  const res = await fetch(`${base}/api/describe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dryRun: true,
      file: { name: "../../evil/petstore.yaml", content: fs.readFileSync(path.join(here, "fixtures/petstore.yaml"), "utf8") },
    }),
  });
  const events = parseEvents(await res.text());
  const schema = events.find((e) => e.event === "schema");
  assert.equal(schema.data.kind, "openapi");
  assert.equal(schema.data.title, "Mini Petstore");
  assert.match(schema.data.summary, /GET \/pets/);
  assert.equal(events.at(-1).event, "done");
});

test("errors are reported as events", async () => {
  const res = await fetch(`${base}/api/describe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "" }),
  });
  const events = parseEvents(await res.text());
  assert.deepEqual(events.at(-1), { event: "error", data: { message: "Enter a URL or choose a schema file." } });
});

test("rejects cross-origin and non-JSON requests", async () => {
  const cross = await fetch(`${base}/api/describe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: "{}",
  });
  assert.equal(cross.status, 403);
  const form = await fetch(`${base}/api/describe`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(form.status, 415);
});
