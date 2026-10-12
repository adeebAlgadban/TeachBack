// Picks the right connector for a target. With an explicit --type only that
// connector runs; otherwise each is tried in turn until one recognises the target.

import * as openapi from "./connectors/openapi.js";
import * as graphql from "./connectors/graphql.js";
import * as odata from "./connectors/odata.js";
import * as generic from "./connectors/generic.js";

export const CONNECTORS = { openapi, graphql, odata, generic };

export async function discover(target, { type = "auto", headers = {}, log = () => {} } = {}) {
  if (type !== "auto") {
    const connector = CONNECTORS[type];
    if (!connector) throw new Error(`Unknown --type "${type}". Use one of: auto, ${Object.keys(CONNECTORS).join(", ")}`);
    const result = await connector.load(target, { headers });
    if (!result) throw new Error(`Could not load a ${type} schema from ${target}`);
    return result;
  }

  const order = /graphql|\/gql\b|\.(graphql|gql)$/i.test(target)
    ? [graphql, openapi, odata, generic]
    : [openapi, graphql, odata, generic];

  for (const connector of order) {
    log(`Trying ${connector.kind}...`);
    try {
      const result = await connector.load(target, { headers });
      if (result) return result;
    } catch (err) {
      // The generic connector is the last resort, so its error is the one to report.
      if (connector === generic) throw err;
      log(`  ${connector.kind}: ${err.message}`);
    }
  }
  throw new Error(`Nothing could be loaded from ${target}`);
}
