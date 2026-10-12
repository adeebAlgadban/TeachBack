# api-describer

Point it at an API or application. It finds and downloads the schema, condenses it, and has Claude write a plain-English description of what the application does: its purpose, users, capabilities, data model, typical workflows, auth, and a quick-start example.

## Setup

```bash
cd api-describer
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or: ant auth login
```

Requires Node.js 20+.

## Usage

```bash
# A direct link to an OpenAPI / Swagger spec
node bin/api-describer.js https://petstore3.swagger.io/api/v3/openapi.json

# Just a base URL - common spec locations (/openapi.json, /swagger.json, /v3/api-docs, ...) are probed
node bin/api-describer.js https://api.example.com --bearer "$TOKEN"

# GraphQL (introspection), saved to a file
node bin/api-describer.js https://countries.trevorblades.com/graphql -o countries.md

# OData services (SAP, Dynamics 365, SharePoint...)
node bin/api-describer.js https://services.odata.org/V4/TripPinServiceRW --type odata

# Local schema files work too
node bin/api-describer.js ./openapi.yaml --audience "non-technical stakeholders"

# See exactly what would be sent to Claude, without calling it
node bin/api-describer.js ./openapi.yaml --dry-run
```

| Option | Meaning |
|---|---|
| `-t, --type` | `auto` (default), `openapi`, `graphql`, `odata`, `generic` |
| `-H, --header` | Extra request header, repeatable: `-H "X-API-Key: abc"` |
| `--bearer` | Shortcut for `Authorization: Bearer <token>` |
| `-o, --out` | Write the Markdown description to a file (otherwise it streams to the terminal) |
| `--save-schema` | Also save the raw downloaded schema |
| `-a, --audience` | Who the description is for |
| `-m, --model` | Claude model (default `claude-opus-5-5`) |
| `-e, --effort` | `low` / `medium` / `high` (default) / `xhigh` / `max` |
| `--dry-run` | Download and condense only, then print the prompt |

## How it works

```
target ──► discover ──► connector ──► condensed schema text ──► Claude ──► Markdown description
```

1. **Discover** (`src/discover.js`) tries each connector until one recognizes the target, or uses the one you name with `--type`.
2. **Connectors** (`src/connectors/`) download the schema and condense it into compact text, dropping examples and boilerplate so that large specs stay readable:
   - `openapi.js`: OpenAPI 3 and Swagger 2, in JSON or YAML. Resolves `$ref`s and `allOf`.
   - `graphql.js`: runs an introspection query, or reads SDL or introspection files, and renders SDL-style text.
   - `odata.js`: parses `$metadata` CSDL into entity sets, types, relations, and operations.
   - `generic.js`: the fallback for everything else. It infers a type skeleton from JSON responses, or extracts the text and documentation links from web pages.
3. **Describe** (`src/describe.js`) streams the condensed schema to Claude with adaptive thinking. It uses server-side refusal fallbacks (`fallbacks: "default"`), so a request a safety classifier declines is retried automatically on Anthropic's recommended fallback model.

To support a new kind of application, add a module to `src/connectors/` that exports `kind` and `load(target, { headers })`. `load` returns `{ kind, source, title, raw, summary }`, or `null` if the target isn't its kind. Then register it in `src/discover.js`.

## Tests

```bash
npm test
```

The tests run every connector against a local mock server, so they need no network access or API key.

## Behind a proxy

Node's built-in `fetch` ignores `HTTPS_PROXY`. On Node 22.21+, set `NODE_USE_ENV_PROXY=1` (and `NODE_EXTRA_CA_CERTS` if your proxy uses its own CA).
