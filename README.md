# Yaygent

Self-hosted web research API for company enrichment, founder and executive discovery, classification, and podcast research. Send row inputs to a YAML template and receive structured results with source URLs, supporting quotes, confidence, timing, and estimated model cost.

Built with TypeScript, Fastify, and optional Playwright. The default cycle engine searches, fetches pages, extracts candidate fields, checks evidence, and locks accepted values. A ReAct engine remains available for inline prompts and v1 templates.

## Requirements

- Node.js 22.13 or newer and npm. `.nvmrc` selects Node 22.
- An API key you choose for protecting your Yaygent server.
- Credentials for your selected LLM provider.
- A Serper API key for reliable Google web/news search.

PostgreSQL, Apify, Jina credentials, a proxy, and a browser are optional. External API calls can incur charges. Mocked tests require no provider credentials.

## Quick start

```bash
git clone https://github.com/arrrgr/yaygent.git
cd yaygent
nvm use                       # if using nvm
npm ci
cp .env.example .env
```

Edit `.env`. For the default OpenRouter provider, set these values:

```dotenv
YAYGENT_API_KEY=replace-with-a-long-random-secret
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=replace-with-your-openrouter-key
SERPER_API_KEY=replace-with-your-serper-key
BROWSER_POOL_SIZE=0
```

Generate a server key with `openssl rand -hex 32`. Never commit your `.env`.

```bash
npm run build
npm start
# Or, while developing:
npm run dev
```

The server listens on `0.0.0.0:3000` by default. It loads `.env` from the working directory; explicit process environment variables take precedence. It does not search a parent workspace for credentials. `.env.local` is not loaded automatically.

```bash
curl -fsS http://localhost:3000/health
# In your calling shell, set the same server key used in .env:
export YAYGENT_API_KEY=replace-with-a-long-random-secret
curl -fsS http://localhost:3000/v1/templates \
  -H "X-API-Key: $YAYGENT_API_KEY"
```

`/health` reports configuration readiness, not a live credential or database connectivity test. Missing Serper credentials produce a degraded health status; limited fallback searches and direct visits may still work.

## Environment variables

### Required and provider-specific settings

| Variable | Required when | Meaning |
|---|---|---|
| `YAYGENT_API_KEY` | Always | One secret or comma-separated accepted secrets for the `X-API-Key` header. |
| `LLM_PROVIDER` | Optional, defaults to `openrouter` | `openrouter`, `anthropic`, or `claude_code` for cycle extraction. |
| `OPENROUTER_API_KEY` | Default `openrouter` provider; also ReAct/inline runs | OpenRouter credential. ReAct uses OpenRouter independently of the cycle provider setting. |
| `ANTHROPIC_API_KEY` | `LLM_PROVIDER=anthropic` | Anthropic Messages API credential. |
| `SERPER_API_KEY` | Recommended for useful search | Google web/news search through Serper. The server warns, but can boot without it. |

Cycle models resolve from request override, template model, then provider default. OpenRouter uses `openai/gpt-oss-120b` by default; Anthropic uses `claude-haiku-4-5-20251001` when a template specifies an incompatible OpenRouter model ID. CLI models map to `haiku` or `sonnet`. Model availability depends on your provider account.

For direct Anthropic extraction:

```dotenv
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=replace-with-your-anthropic-key
```

For local CLI extraction, install and authenticate the `claude` executable separately, then set:

```dotenv
LLM_PROVIDER=claude_code
CLAUDE_CODE_BIN=claude
CLAUDE_CODE_CONCURRENCY=4
CLAUDE_CODE_EFFORT=low
```

The CLI provider spawns subprocesses and requires a usable local CLI session. Its reported cost is list-price accounting, marked `subscription`; the engine does not apply the dollar cap to that accounting. CLI session limits still apply. The Docker image does not install or authenticate the CLI.

### Server and concurrency

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP listening port. |
| `LOG_LEVEL` | `info` | Pino/Fastify log level. |
| `WORKER_CONCURRENCY` | `40` | Parallel batch rows. Start lower for small machines or limited provider quotas. |
| `BROWSER_POOL_SIZE` | Code: `3`; example file: `0` | Browser contexts. Zero disables browser fallback and needs no Chromium install. |
| `RAILWAY_MEMORY_MB` | `512` | Memory budget used by the batch guard, also usable outside Railway. New batches are rejected above 80% RSS. |
| `CODE_VERSION` | Railway commit prefix, else `dev` | Result-cache version. Set to a release/commit identifier to invalidate results after code changes. |
| `CLAUDE_CODE_BIN` | `claude` | CLI executable name or full path. |
| `CLAUDE_CODE_CONCURRENCY` | `4` | Maximum concurrent CLI subprocesses. |
| `CLAUDE_CODE_EFFORT` | `low` | Effort flag passed to the CLI. |

### Search, fetching, and browser fallback

| Variable | Default | Meaning |
|---|---|---|
| `SERPER_QPS` | `5` | Search rate limiter. |
| `JINA_API_KEY` | Unset | Optional Jina Reader authentication. |
| `JINA_RPM` | `15` unkeyed, `150` keyed | Reader request limit. Leave blank to select automatically. |
| `PROXY_URL_ROTATE` | Unset | Rotating proxy gateway for target-site requests and Bing fallback. |
| `PROXY_URL` | Unset | Legacy fallback if `PROXY_URL_ROTATE` is absent. |
| `FETCH_BUDGET_MS` | `15000` | Total time budget per visit across fetch tiers. |
| `PARSE_CONCURRENCY` | `8` | Maximum concurrent HTML parses. |
| `HOST_LIMIT` | `2` | Per-host concurrency. |
| `HOST_TOLERANT_LIMIT` | `8` | Higher cap for hosts designated tolerant in code. |
| `MIN_CONTENT_CHARS` | `120` | Minimum content length before a fetch tier is accepted. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Unset | Optional installed Chromium executable path. Docker sets `/usr/bin/chromium`. |

Search uses Serper, with Google News RSS and Bing over a proxy as limited fallbacks. Visits try cache, direct HTTP, proxy, Jina Reader, then Playwright within the shared budget. Proxy sticky-session derivation follows the Webshare username convention; other providers may need adapter changes.

To enable browser fallback locally:

```bash
npx playwright install --with-deps chromium
# Then set BROWSER_POOL_SIZE=3 in .env and restart.
```

### Optional persistence and additional strategies

| Variable | Default | Meaning |
|---|---|---|
| `YAYGENT_DATABASE_URL` | Unset | PostgreSQL connection URL for durable caches and profile evidence. Without it, page/result caches stay in memory. |
| `APIFY_API_TOKEN` | Unset | LinkedIn profile/company enrichment. Profile scraping is wired only when both this token and the database URL are configured. |
| `JEV_API_KEY` | Unset | Optional typed classifier used by `qualify_company`; absent or failed classification falls through to later strategies. |

For persistence, run `psql "$YAYGENT_DATABASE_URL" -f sql/schema.sql` against your own database. The runtime does not create tables automatically. Database errors fail open, so monitor logs if cache hits disappear. Use a private database role; do not expose these tables through an unauthenticated data API. For verified TLS use a URL with `sslmode=verify-full` and a valid server certificate. `sslmode=require` encrypts without certificate verification in this implementation.

## API

Every route except `/health` requires `X-API-Key`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Configuration and browser-pool status. |
| GET | `/v1/templates` | List templates and input variables. |
| GET | `/v1/templates/:name` | Read a template. |
| POST | `/v1/templates` | Save a template with `name` and `yaml_content`. |
| POST | `/v1/run` | Run one research row synchronously. |
| POST | `/v1/run/batch` | Start an asynchronous batch, up to 500 rows. |
| GET | `/v1/run/batch/:job_id` | Poll batch progress and final results. |

### Single row

```bash
curl -fsS http://localhost:3000/v1/run \
  -H "X-API-Key: $YAYGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"template":"classify_vertical","inputs":{"company_name":"Stripe","website":"stripe.com"}}'
```

Cycle responses include `data`, `status`, `_meta`, `result`, and timing fields. `result` is the serialized `data` for compatibility. `completed` means all required fields locked; `partial` means required information remains missing. Inspect `_meta.locked` for supporting quotes and source URLs, `_meta.candidates` for rejected/unconfirmed values, and `_meta.stop_reason` for budget/completion details. Confidence is computed from evidence rules and is not a calibrated probability of correctness.

### Batch

```bash
curl -fsS http://localhost:3000/v1/run/batch \
  -H "X-API-Key: $YAYGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"template":"classify_vertical","rows":[{"company_name":"Stripe","website":"stripe.com"},{"company_name":"Shopify","website":"shopify.com"}]}'
# Returns HTTP 202 with job_id and poll_url.

curl -fsS http://localhost:3000/v1/run/batch/REPLACE_WITH_JOB_ID \
  -H "X-API-Key: $YAYGENT_API_KEY"
```

Results appear when the job completes, ordered by input row index. Jobs expire one hour after completion and are held in process memory, including when PostgreSQL is enabled. Restarting loses jobs; polling through multiple replicas needs sticky routing or a single instance. Batches have a 15-minute hard cap. Use smaller chunks for slow research and tune concurrency to provider limits.

### Inline prompts and ReAct compatibility

```bash
curl -fsS http://localhost:3000/v1/run \
  -H "X-API-Key: $YAYGENT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Find the CEO of Stripe and cite the source.","model":"openai/gpt-oss-120b","max_turns":4}'
```

Inline prompts use ReAct and require OpenRouter credentials. Named v2 templates default to cycle mode. `mode: "react"` serves the matching v1 template when available. `templates/v1/` is retained because this supported mode uses it. `prompt_extension` is rejected for cycle templates.

## Included templates

| Template | Inputs and behavior |
|---|---|
| `classify_vertical` | `company_name`, `website`; returns one vertical label. |
| `company_enrichment` | Company description, ICP and dated news. See YAML for required and optional inputs. |
| `find_founders` | Requires `company_name`, `domain`; optional company LinkedIn URL, industry, description, founding year and locality improve disambiguation. |
| `find_executives` | Company leadership research with role and personal profile evidence. |
| `find_founder_nationality` | Country-of-origin research with education/early-career evidence; inferred fields require human review. |
| `qualify_company` | Business model, SaaS qualification, category and buyer classification; optionally uses Jev. |
| `find_podcast_appearances` | Podcast guest research with person/company mention checks. |

The YAML files define exact variables, required inputs, output fields, strategy order, thresholds and budgets. Retrieve a template through the API or read its file before building an integration. Founder confirmation may need optional profile evidence and can return partial results without it. Search snippets can be stale or match a namesake; review evidence before relying on a result.

## Docker and Railway

```bash
docker build -t yaygent .
docker run --rm --env-file .env -p 3000:3000 yaygent
```

The multi-stage image installs system Chromium and copies compiled code, production dependencies and templates. `.dockerignore` excludes credentials and local artifacts. Set `LLM_PROVIDER=openrouter` or `anthropic` for this image.

On Railway, deploy this repository from its root using the included Dockerfile and `railway.toml`, and set the environment variables in the service. `/health` is the health-check route. Deploying this repository creates your own service; no shared hosted API or credentials are included. Template writes use local disk and need a persistent volume or source-controlled redeployment to survive replacement containers.

## Development and checks

```bash
npm ci
npm run build
npm test
npm audit
```

Tests mock providers, HTTP requests, browser operations and database boundaries. They exercise extraction, evidence gates, entity matching, casting, caching, template validation, API auth, routes, batching, and fetch fallbacks. They do not establish live search quality, provider availability, browser compatibility on every host, or database connectivity. CI builds and tests on Node 22 and 24.

Repository layout:

```text
src/agent/       Cycle and ReAct engines, evidence validation
src/browser/     Search, fetching, pruning, browser pool and proxy handling
src/cache/       In-memory and optional PostgreSQL caches
src/llm/         OpenRouter, Anthropic, local CLI and Jev providers
src/routes/      Fastify API routes
src/templates/   YAML loading, validation and input resolution
templates/       Current templates and supported ReAct counterparts
test/            Mocked unit and regression tests
sql/schema.sql   Optional persistence tables
```

This standalone snapshot excludes the old Python scaffold, scraped datasets, benchmark outputs, internal reviews, production configuration and workspace git history. It contains no historical accuracy claims; evaluate it against your own task and data.

## Operational limits

API keys grant access to research and template-writing routes; there are no per-user quotas or tenant isolation. Deploy for trusted callers behind appropriate network controls. Research tools fetch supplied URLs, so public untrusted access requires outbound network restrictions. Missing evidence is returned as partial/null rather than a guaranteed answer. Provider failures, rate limits, blocked sites and budget exhaustion can reduce coverage.

Dependency audit after cleanup: no critical, high or moderate findings. Three low-severity findings remain in the optional stealth browser dependency chain (`deepmerge` and its parent packages); the advisory has no patched release in that chain. Browser fallback is disabled in the example configuration.

Local verification: build and 286 mocked tests passed, including a run on Node 22.23.4. HTTP startup, health, template listing, template detail and unauthorized access were checked. Docker execution requires a running Docker daemon; image execution and live PostgreSQL integration were not verified in this cleanup.

The live OpenRouter smoke check reached Serper and fetched the company website, but the available workspace key returned HTTP 401 (`User not found`). End-to-end OpenRouter output was therefore not verified with that credential. Use your own active provider key.

A live Serper + local CLI cycle request completed successfully: `classify_vertical` returned `FinTech` for Stripe in approximately 8.6 seconds with one evidence-backed field lock. This is a single functional smoke check, not an accuracy benchmark.
