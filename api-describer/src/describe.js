// Sends the condensed schema to Claude and gets back a written description.

import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `You are a senior technical writer. You are given the schema of a software application or API - an OpenAPI/Swagger spec, a GraphQL schema, OData metadata, or (when no formal schema exists) sample responses or page content - condensed into text.

Write a clear description of the application: what it is, what it does, who would use it, and how its pieces fit together. Infer the product's purpose from resource names, operations, and data models, and say so when you are inferring rather than reading it directly from the schema. Never invent endpoints, fields, or behaviour that the schema does not support.

Format the answer as Markdown with these sections:
1. **Overview** - two or three paragraphs on what the application is and the problem it solves.
2. **Who it's for** - the likely users and use cases.
3. **Key capabilities** - grouped bullet points, each naming the operations/endpoints that provide it.
4. **Core concepts & data model** - the main entities, what they represent, and how they relate.
5. **Typical workflows** - two to four step-by-step flows that chain real operations together.
6. **Authentication & access** - how clients authenticate, if the schema says.
7. **Notable details** - deprecations, pagination, webhooks, limits, gaps or inconsistencies in the schema.
8. **Quick start** - one short, realistic example request against this API.

Skip a section only if the schema gives nothing to say about it.`;

/**
 * @param {object} schema  result from discover()
 * @param {object} opts    { model, audience, effort, onText }
 */
export async function describe(schema, { model = DEFAULT_MODEL, audience, effort = "high", onText } = {}) {
  const client = new Anthropic();

  const userContent = buildUserContent(schema, audience);

  const stream = client.beta.messages.stream({
    model,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: { effort },
    // If a safety classifier declines, retry on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  });

  if (onText) stream.on("text", onText);
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    const reason = message.stop_details?.explanation ?? message.stop_details?.category ?? "no reason given";
    throw new Error(`Claude declined to describe this schema (${reason}).`);
  }

  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (message.stop_reason === "max_tokens") {
    return { text: `${text}\n\n> _Output stopped at the token limit; the description may be incomplete._`, usage: message.usage, model: message.model };
  }
  return { text, usage: message.usage, model: message.model };
}

function buildUserContent(schema, audience) {
  return [
    `Schema type: ${schema.kind}`,
    `Source: ${schema.source}`,
    ...(audience ? [`Audience for the description: ${audience}`] : []),
    "",
    "<schema>",
    schema.summary,
    "</schema>",
  ].join("\n");
}

/** What would be sent to Claude - used by --dry-run. */
export function buildPromptPreview(schema, { audience } = {}) {
  return `--- system ---\n${SYSTEM_PROMPT}\n\n--- user ---\n${buildUserContent(schema, audience)}`;
}
