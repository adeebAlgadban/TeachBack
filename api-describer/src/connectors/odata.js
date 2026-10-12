// OData connector: reads the service's $metadata (CSDL XML) document.
// Used by SAP, Microsoft Dynamics / Dataverse, SharePoint and many enterprise apps.

import { fetchText, isUrl } from "../http.js";

export const kind = "odata";

export async function load(target, { headers }) {
  const candidates = [target];
  if (isUrl(target) && !/\$metadata/.test(target)) {
    candidates.unshift(`${target.replace(/\/?$/, "/")}$metadata`);
  }
  for (const url of candidates) {
    let res;
    try {
      res = await fetchText(url, { headers: { Accept: "application/xml", ...headers } });
    } catch {
      continue;
    }
    if (res.status >= 400 || !/<edmx:Edmx/i.test(res.body)) continue;
    return { kind, source: res.url, title: "OData service", raw: res.body, summary: summarize(res.body) };
  }
  return null;
}

/**
 * Extract entity types, entity sets, and actions/functions from CSDL with a
 * few targeted regexes - enough for a description without an XML dependency.
 */
export function summarize(xml) {
  const lines = ["# OData service metadata"];
  const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

  for (const m of xml.matchAll(/<Schema\b[^>]*>/g)) lines.push(`Namespace: ${attr(m[0], "Namespace")}`);

  lines.push("", "## Entity sets");
  for (const m of xml.matchAll(/<EntitySet\b[^>]*>/g)) lines.push(`- ${attr(m[0], "Name")}: ${attr(m[0], "EntityType")}`);

  lines.push("", "## Entity types");
  for (const m of xml.matchAll(/<(EntityType|ComplexType)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const name = attr(m[2], "Name");
    const keys = [...m[3].matchAll(/<PropertyRef\b[^>]*Name="([^"]*)"/g)].map((k) => k[1]);
    const props = [...m[3].matchAll(/<Property\b[^>]*>/g)].map((p) => `${attr(p[0], "Name")}: ${attr(p[0], "Type")}`);
    const navs = [...m[3].matchAll(/<NavigationProperty\b[^>]*>/g)].map((p) => `${attr(p[0], "Name")} -> ${attr(p[0], "Type") ?? attr(p[0], "ToRole")}`);
    lines.push(`- ${m[1] === "ComplexType" ? "(complex) " : ""}${name}${keys.length ? ` key(${keys.join(", ")})` : ""}`);
    if (props.length) lines.push(`    fields: ${props.join(", ")}`);
    if (navs.length) lines.push(`    relations: ${navs.join(", ")}`);
  }

  const ops = [...xml.matchAll(/<(Action|Function|FunctionImport|ActionImport)\b[^>]*>/g)];
  if (ops.length) {
    lines.push("", "## Operations");
    for (const m of ops) lines.push(`- ${m[1]} ${attr(m[0], "Name")}`);
  }
  return lines.join("\n");
}
