## What and why

<!-- Link the issue this addresses (e.g. "Closes #12") and summarise the change. -->

## Checklist

- [ ] `npm run typecheck && npm test && npm run format:check` pass locally
- [ ] Tests added or updated (bug fixes include a test that fails without the fix)
- [ ] No fabricated data: failures surface as typed `AppError`s; unknown values are `null`
- [ ] Provenance kept: every price, distance and time has `source` (and `seller` for prices) and `fetched_at`
- [ ] Unofficial sources stay behind `ENABLE_UNOFFICIAL_SOURCES`; upstream MCP tools are allow-listed and read-only
- [ ] No hardcoded credentials or keys; no copied third-party content (fixtures are synthetic)
- [ ] Tool descriptions describe rather than instruct, and name no other MCP servers
- [ ] README / CHANGELOG ("Unreleased") updated where relevant
- [ ] Data rebuilds: `data/manifest.json` row counts before and after are included below
