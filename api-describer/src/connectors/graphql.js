// GraphQL connector: runs the standard introspection query against an endpoint,
// or reads a local SDL (.graphql) / introspection-result (.json) file.

import { fetchText, isUrl, tryParseJson } from "../http.js";

export const kind = "graphql";

const CANDIDATE_PATHS = ["", "/graphql", "/api/graphql", "/graphql/v1", "/query", "/gql"];

export const INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    description
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated
        args { name description type { ...TypeRef } }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } }
      interfaces { name }
      enumValues(includeDeprecated: true) { name description }
      possibleTypes { name }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`;

export async function load(target, { headers }) {
  if (!isUrl(target)) {
    const res = await fetchText(target);
    const json = tryParseJson(res.body);
    const schema = json?.data?.__schema ?? json?.__schema;
    if (schema) return result(target, schema);
    if (/\b(type|schema)\s+\w*\s*\{/.test(res.body) && /\.(graphql|gql)$/i.test(target)) {
      return { kind, source: target, title: "GraphQL API", raw: res.body, summary: `# GraphQL schema (SDL)\n\n${res.body}` };
    }
    return null;
  }

  const base = new URL(target);
  const candidates = [...new Set(CANDIDATE_PATHS.map((p) => (p ? new URL(p, base.origin).href : base.href)))];
  for (const url of candidates) {
    let res;
    try {
      res = await fetchText(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify({ query: INTROSPECTION_QUERY, operationName: "IntrospectionQuery" }),
      });
    } catch {
      continue;
    }
    const schema = tryParseJson(res.body)?.data?.__schema;
    if (schema) return result(res.url, schema);
  }
  return null;
}

function result(source, schema) {
  return { kind, source, title: "GraphQL API", raw: schema, summary: summarize(schema) };
}

/** Render introspection output as compact SDL-like text. */
export function summarize(schema) {
  const lines = ["# GraphQL schema"];
  if (schema.description) lines.push(schema.description);
  const roots = {
    query: schema.queryType?.name,
    mutation: schema.mutationType?.name,
    subscription: schema.subscriptionType?.name,
  };
  lines.push(`Root types: ${Object.entries(roots).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  const userTypes = (schema.types ?? []).filter((t) => !t.name.startsWith("__"));
  const rootNames = new Set(Object.values(roots).filter(Boolean));
  // Put the root operation types first - they describe what the API can *do*.
  const ordered = [...userTypes.filter((t) => rootNames.has(t.name)), ...userTypes.filter((t) => !rootNames.has(t.name))];

  for (const t of ordered) {
    const desc = t.description ? `  # ${flat(t.description)}` : "";
    switch (t.kind) {
      case "SCALAR":
        if (!["String", "Int", "Float", "Boolean", "ID"].includes(t.name)) lines.push(`scalar ${t.name}${desc}`);
        break;
      case "ENUM":
        lines.push(`enum ${t.name} { ${(t.enumValues ?? []).map((v) => v.name).join(" ")} }${desc}`);
        break;
      case "UNION":
        lines.push(`union ${t.name} = ${(t.possibleTypes ?? []).map((p) => p.name).join(" | ")}${desc}`);
        break;
      case "INPUT_OBJECT":
        lines.push(`input ${t.name} {${desc}`);
        for (const f of t.inputFields ?? []) lines.push(`  ${f.name}: ${typeRef(f.type)}${f.description ? `  # ${flat(f.description)}` : ""}`);
        lines.push("}");
        break;
      case "OBJECT":
      case "INTERFACE": {
        const impl = t.interfaces?.length ? ` implements ${t.interfaces.map((i) => i.name).join(" & ")}` : "";
        lines.push(`${t.kind === "OBJECT" ? "type" : "interface"} ${t.name}${impl} {${desc}`);
        for (const f of t.fields ?? []) {
          const args = f.args?.length ? `(${f.args.map((a) => `${a.name}: ${typeRef(a.type)}`).join(", ")})` : "";
          const notes = [f.isDeprecated && "DEPRECATED", f.description && flat(f.description)].filter(Boolean).join(" - ");
          lines.push(`  ${f.name}${args}: ${typeRef(f.type)}${notes ? `  # ${notes}` : ""}`);
        }
        lines.push("}");
        break;
      }
    }
  }
  return lines.join("\n");
}

function typeRef(t) {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeRef(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeRef(t.ofType)}]`;
  return t.name;
}

function flat(text) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 240)}...` : s;
}
