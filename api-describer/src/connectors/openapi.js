// OpenAPI 3.x / Swagger 2.0 connector.
// Accepts a direct link to a spec, a local spec file, or a base URL - in which
// case the common spec locations are probed.

import YAML from "yaml";
import { fetchText, isUrl, tryParseJson } from "../http.js";

export const kind = "openapi";

export const CANDIDATE_PATHS = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/swagger.yaml",
  "/v3/api-docs",
  "/v2/api-docs",
  "/api-docs",
  "/api/openapi.json",
  "/api/swagger.json",
  "/api/v1/openapi.json",
  "/docs/openapi.json",
  "/swagger/v1/swagger.json",
  "/.well-known/openapi.json",
  "/.well-known/openapi.yaml",
];

export function parseSpec(text) {
  const doc = tryParseJson(text) ?? safeYaml(text);
  if (doc && typeof doc === "object" && (doc.openapi || doc.swagger) && (doc.paths || doc.webhooks)) {
    return doc;
  }
  return undefined;
}

function safeYaml(text) {
  try {
    return YAML.parse(text);
  } catch {
    return undefined;
  }
}

export async function load(target, { headers }) {
  const candidates = [target];
  if (isUrl(target)) {
    const base = new URL(target);
    const dir = base.origin + base.pathname.replace(/\/?$/, "/");
    for (const path of CANDIDATE_PATHS) {
      // Probe under the given path first (https://host/api/ -> /api/openapi.json), then at the root.
      candidates.push(new URL(path.slice(1), dir).href);
      candidates.push(new URL(path, base.origin).href);
    }
  }

  for (const url of [...new Set(candidates)]) {
    let res;
    try {
      res = await fetchText(url, { headers: { Accept: "application/json, application/yaml;q=0.9, */*;q=0.5", ...headers } });
    } catch {
      continue;
    }
    if (res.status >= 400) continue;
    const doc = parseSpec(res.body);
    if (doc) {
      return { kind, source: res.url, title: doc.info?.title ?? "Untitled API", raw: doc, summary: summarize(doc) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Summarization: turn a (possibly huge) spec into compact, readable text that
// keeps everything Claude needs to explain the API, and drops the noise
// (examples, vendor extensions, repeated boilerplate).
// ---------------------------------------------------------------------------

const METHODS = ["get", "put", "post", "delete", "patch", "options", "head", "trace"];

export function summarize(doc) {
  const lines = [];
  const info = doc.info ?? {};
  lines.push(`# ${info.title ?? "Untitled API"} (${doc.openapi ? `OpenAPI ${doc.openapi}` : `Swagger ${doc.swagger}`})`);
  if (info.version) lines.push(`Version: ${info.version}`);
  if (info.description) lines.push(`Description: ${oneLine(info.description, 2000)}`);

  const servers = doc.servers?.map((s) => s.url) ?? (doc.host ? [`${doc.schemes?.[0] ?? "https"}://${doc.host}${doc.basePath ?? ""}`] : []);
  if (servers.length) lines.push(`Servers: ${servers.join(", ")}`);

  const securitySchemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  if (Object.keys(securitySchemes).length) {
    lines.push("", "## Authentication");
    for (const [name, s] of Object.entries(securitySchemes)) {
      const detail = [s.type, s.scheme, s.in && `in ${s.in}`, s.name && `name=${s.name}`, s.bearerFormat].filter(Boolean).join(", ");
      lines.push(`- ${name}: ${detail}${s.description ? ` - ${oneLine(s.description, 200)}` : ""}`);
      const flows = s.flows ?? (s.flow ? { [s.flow]: s } : null);
      if (flows) {
        for (const [flowName, flow] of Object.entries(flows)) {
          const scopes = Object.keys(flow.scopes ?? {});
          lines.push(`  - flow ${flowName}${scopes.length ? `, scopes: ${scopes.join(", ")}` : ""}`);
        }
      }
    }
  }

  if (doc.tags?.length) {
    lines.push("", "## Tags");
    for (const t of doc.tags) lines.push(`- ${t.name}${t.description ? `: ${oneLine(t.description, 300)}` : ""}`);
  }

  lines.push("", "## Endpoints");
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const resolvedItem = resolve(doc, item);
    for (const method of METHODS) {
      const op = resolvedItem?.[method];
      if (!op) continue;
      const tags = op.tags?.length ? ` [${op.tags.join(", ")}]` : "";
      const text = op.summary || op.description;
      lines.push(`- ${method.toUpperCase()} ${path}${tags}${op.deprecated ? " (deprecated)" : ""}${text ? ` - ${oneLine(text, 300)}` : ""}`);

      const params = [...(resolvedItem.parameters ?? []), ...(op.parameters ?? [])].map((p) => resolve(doc, p));
      const visible = params.filter((p) => p && p.in !== "body");
      if (visible.length) {
        lines.push(`    params: ${visible.map((p) => `${p.name} (${p.in}${p.required ? ", required" : ""})`).join("; ")}`);
      }

      const bodySchema = requestBodySchema(doc, op, params);
      if (bodySchema) lines.push(`    body: ${typeLabel(doc, bodySchema)}`);

      const success = Object.entries(op.responses ?? {}).find(([code]) => /^2/.test(code));
      if (success) {
        const schema = responseSchema(doc, resolve(doc, success[1]));
        lines.push(`    returns ${success[0]}${schema ? `: ${typeLabel(doc, schema)}` : ""}`);
      }
    }
  }

  if (doc.webhooks && Object.keys(doc.webhooks).length) {
    lines.push("", "## Webhooks");
    for (const [name, item] of Object.entries(doc.webhooks)) {
      const op = METHODS.map((m) => item[m]).find(Boolean);
      lines.push(`- ${name}${op?.summary ? ` - ${oneLine(op.summary, 200)}` : ""}`);
    }
  }

  const schemas = doc.components?.schemas ?? doc.definitions ?? {};
  if (Object.keys(schemas).length) {
    lines.push("", "## Data models");
    for (const [name, schema] of Object.entries(schemas)) {
      lines.push(describeSchema(doc, name, schema));
    }
  }

  return lines.join("\n");
}

function requestBodySchema(doc, op, params) {
  const bodyParam = params.find((p) => p?.in === "body");
  if (bodyParam) return bodyParam.schema;
  const rb = resolve(doc, op.requestBody);
  if (!rb?.content) return undefined;
  const media = rb.content["application/json"] ?? Object.values(rb.content)[0];
  return media?.schema;
}

function responseSchema(doc, response) {
  if (!response) return undefined;
  if (response.schema) return response.schema; // Swagger 2
  if (!response.content) return undefined;
  const media = response.content["application/json"] ?? Object.values(response.content)[0];
  return media?.schema;
}

function describeSchema(doc, name, schema) {
  const s = resolve(doc, schema) ?? {};
  const head = `- ${name}${s.description ? `: ${oneLine(s.description, 300)}` : ""}`;
  if (s.enum) return `${head}\n    enum: ${s.enum.slice(0, 30).join(", ")}${s.enum.length > 30 ? ", ..." : ""}`;

  const props = collectProperties(doc, s);
  if (!props.length) return `${head}\n    type: ${typeLabel(doc, s)}`;
  const required = new Set(collectRequired(doc, s));
  const fields = props.map(([prop, ps]) => `${prop}${required.has(prop) ? "*" : ""}: ${typeLabel(doc, ps)}`);
  return `${head}\n    fields: ${fields.join(", ")}`;
}

function collectProperties(doc, schema, seen = new Set()) {
  const s = resolve(doc, schema);
  if (!s || seen.has(s)) return [];
  seen.add(s);
  const own = Object.entries(s.properties ?? {});
  const inherited = (s.allOf ?? []).flatMap((part) => collectProperties(doc, part, seen));
  return [...inherited, ...own];
}

function collectRequired(doc, schema) {
  const s = resolve(doc, schema);
  if (!s) return [];
  return [...(s.required ?? []), ...(s.allOf ?? []).flatMap((part) => collectRequired(doc, part))];
}

/** Short human label for a schema: "Pet", "array<Pet>", "string(date-time)", "oneOf<Cat|Dog>". */
export function typeLabel(doc, schema, depth = 0) {
  if (!schema) return "any";
  if (schema.$ref) return refName(schema.$ref);
  if (depth > 3) return "object";
  for (const combinator of ["oneOf", "anyOf", "allOf"]) {
    if (schema[combinator]) return `${combinator}<${schema[combinator].map((s) => typeLabel(doc, s, depth + 1)).join("|")}>`;
  }
  if (schema.type === "array") return `array<${typeLabel(doc, schema.items, depth + 1)}>`;
  if (schema.enum) return `enum(${schema.enum.slice(0, 8).join("|")}${schema.enum.length > 8 ? "|..." : ""})`;
  if (schema.type === "object" && schema.properties) {
    return `{${Object.entries(schema.properties).slice(0, 12).map(([k, v]) => `${k}: ${typeLabel(doc, v, depth + 1)}`).join(", ")}}`;
  }
  const type = Array.isArray(schema.type) ? schema.type.join("|") : schema.type ?? "object";
  return schema.format ? `${type}(${schema.format})` : type;
}

function refName(ref) {
  return ref.split("/").pop();
}

/** Resolve a local "#/..." $ref; anything else is returned untouched. */
export function resolve(doc, node, depth = 0) {
  if (!node || typeof node !== "object" || !node.$ref || depth > 10) return node;
  if (!node.$ref.startsWith("#/")) return node;
  const target = node.$ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, key) => acc?.[key], doc);
  return resolve(doc, target, depth + 1);
}

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}
