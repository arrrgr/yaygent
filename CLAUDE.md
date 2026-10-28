# Yaygent

Standalone TypeScript web research API. Read README.md before editing.

## Contents
- `src/`: Fastify routes, research engines, providers, browser utilities and caches.
- `templates/`: current cycle templates plus v1 templates used by the supported ReAct mode.
- `test/`: mocked unit and API regression tests. No paid provider calls required.
- `sql/schema.sql`: optional database tables.
- `README.md`: setup, configuration, API, limitations and validation.
- `.env.example`: configuration reference; never commit real credentials.
- `Dockerfile`, `railway.toml`, `.github/workflows/ci.yml`: deployment and verification.

## Working Notes
Run `npm ci`, `npm run build`, and `npm test`. Use Node 22.13+.
Load only this repository's `.env` or explicit process environment.
Do not add production datasets, benchmark dumps, private notes or credentials.
Preserve quote verification, entity matching, and fail-open cache behavior.

## Change Log
- 2026-10-28: Added the residential proxy URL to the initial requirements and quick-start env block, including credential formatting guidance.
- 2026-10-28: Extracted current service into a standalone shareable repository; removed historical scaffold and private artifacts; added setup documentation and CI.
