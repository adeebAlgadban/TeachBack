import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover } from "../src/discover.js";
import { summarize as summarizeGraphql } from "../src/connectors/graphql.js";
import { inferShape } from "../src/connectors/generic.js";
import { parseHeaderList } from "../src/http.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, "fixtures", name);

// A tiny fake server hosting one of each kind of API.
const graphqlSchema = {
  queryType: { name: "Query" },
  mutationType: null,
  subscriptionType: null,
  types: [
    {
      kind: "OBJECT",
      name: "Query",
      fields: [
        {
          name: "country",
          description: "Look up a country by code",
          isDeprecated: false,
          args: [{ name: "code", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "ID" } } }],
          type: { kind: "OBJECT", name: "Country" },
        },
      ],
      interfaces: [],
    },
    {
      kind: "OBJECT",
      name: "Country",
      fields: [{ name: "name", args: [], type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } } }],
      interfaces: [],
    },
    { kind: "ENUM", name: "Continent", enumValues: [{ name: "AF" }, { name: "EU" }] },
    { kind: "OBJECT", name: "__Schema", fields: [] },
  ],
};

let server;
let base;
let seenAuth;

before(async () => {
  server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/openapi-app/") && url.pathname.endsWith("/openapi.yaml")) {
      res.setHeader("content-type", "application/yaml");
      return res.end(fs.readFileSync(fixture("petstore.yaml")));
    }
    if (url.pathname === "/gql-app/graphql" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: { __schema: graphqlSchema } }));
    }
    if (url.pathname === "/odata-app/$metadata") {
      res.setHeader("content-type", "application/xml");
      return res.end(fs.readFileSync(fixture("metadata.xml")));
    }
    if (url.pathname === "/json-app/users") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify([{ id: 1, name: "Ada", email: "a@x.io" }, { id: 2, name: "Bob", admin: true }]));
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("finds an OpenAPI spec by probing a base URL", async () => {
  const schema = await discover(`${base}/openapi-app/`);
  assert.equal(schema.kind, "openapi");
  assert.equal(schema.title, "Mini Petstore");
  assert.match(schema.summary, /GET \/pets \[pets\] - List pets/);
  assert.match(schema.summary, /returns 200: array<Pet>/);
  assert.match(schema.summary, /DELETE \/pets\/\{petId\} \[pets\] \(deprecated\)/);
  assert.match(schema.summary, /params: petId \(path, required\)/);
  assert.match(schema.summary, /apiKey: apiKey, in header, name=X-API-Key/);
  // allOf inheritance should surface the parent's fields.
  assert.match(schema.summary, /- NewPet\n {4}fields: id\*: integer\(int64\), name\*: string, status: enum\(available\|pending\|sold\), tag: string/);
});

test("reads a local OpenAPI file", async () => {
  const schema = await discover(fixture("petstore.yaml"));
  assert.equal(schema.kind, "openapi");
  assert.match(schema.summary, /POST \/pets .*body: NewPet/s);
});

test("introspects a GraphQL endpoint and forwards auth headers", async () => {
  const schema = await discover(`${base}/gql-app/graphql`, { headers: { Authorization: "Bearer t0k" } });
  assert.equal(schema.kind, "graphql");
  assert.equal(seenAuth, "Bearer t0k");
  assert.match(schema.summary, /country\(code: ID!\): Country {2}# Look up a country by code/);
  assert.match(schema.summary, /enum Continent \{ AF EU \}/);
  assert.doesNotMatch(schema.summary, /__Schema/);
});

test("reads OData $metadata from a service root", async () => {
  const schema = await discover(`${base}/odata-app`, { type: "odata" });
  assert.equal(schema.kind, "odata");
  assert.match(schema.summary, /- People: Trippin.Person/);
  assert.match(schema.summary, /- Person key\(UserName\)/);
  assert.match(schema.summary, /relations: Trips -> Collection\(Trippin.Trip\)/);
  assert.match(schema.summary, /Function GetFavoriteAirline/);
});

test("falls back to inferring structure from plain JSON", async () => {
  const schema = await discover(`${base}/json-app/users`);
  assert.equal(schema.kind, "generic");
  assert.deepEqual(schema.raw.inferredShape, [{ id: "number", name: "string", email: "string", admin: "boolean" }]);
});

test("reports HTTP errors from the fallback connector", async () => {
  await assert.rejects(discover(`${base}/missing`), /HTTP 404/);
});

test("graphql summary orders root types first", () => {
  const text = summarizeGraphql({ ...graphqlSchema, types: [...graphqlSchema.types].reverse() });
  assert.ok(text.indexOf("type Query") < text.indexOf("type Country"));
});

test("inferShape handles nesting and nulls", () => {
  assert.deepEqual(inferShape({ a: [{ b: null }], c: "x" }), { a: [{ b: "null" }], c: "string" });
});

test("parseHeaderList", () => {
  assert.deepEqual(parseHeaderList(["X-Key: a:b", "Accept:json"]), { "X-Key": "a:b", Accept: "json" });
  assert.throws(() => parseHeaderList(["nope"]), /Invalid header/);
});
