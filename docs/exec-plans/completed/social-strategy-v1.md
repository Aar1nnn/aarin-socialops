# SocialStrategy V1 execution record

Base: `origin/main` at `c6fb0d0ca9e2a450260c419e8cb34f651d303a6e` (PR #9 merge). Branch: `codex/social-strategy-v1`.

## Approved boundary

- A client strategy is a versioned, human-confirmed operational choice for buyer, market, platform, and content. BrandProfile remains the long-term brand source of truth; Client.targetMarkets remains the company default. Confirmed product facts and BrandProfile hard rules outrank strategy guidance.
- Gate only strategy-dependent AI generation, rewrite, regenerate, and later automatic planning for LIVE clients. Do not gate manual editing, version saving, review, approval, scheduling, or publishing.
- New content pins a strategy before calling the model and validates it again under a Client row lock before saving. Historical unbound LIVE content requires explicit binding for AI rewrite/regenerate; no implicit backfill.
- ContentVersion.sourceFacts uses stable provenance values: CONFIRMED_BINDING, DRAFT_PREVIEW, UNBOUND_FALLBACK, LEGACY_UNBOUND. Store strategy id, version, and status. Missing historical fields are interpreted as LEGACY_UNBOUND without writes.
- Confirmation AuditLog metadata snapshots BrandProfile.updatedAt and Client.targetMarkets. Effective dates are lightweight period markers. AI cannot confirm a strategy or create approval/publish jobs.
- No Client Readiness, Monthly Review, Manual Publishing, platform connection, worker, adapter, TokenVault, retry, or idempotency changes.

## Progress

- [x] PR #9 merge and clean worktree baseline verified.
- [x] Existing migrations applied to isolated PostgreSQL; baseline migrate status clean.
- [x] Schema and tenant-safe composite relation migration. Client row lock serializes DRAFT/CONFIRMED transitions; no partial unique index.
- [x] Strategy service, API, page, and content integration.
- [x] Tenant, concurrency, gate, legacy, bound rewrite, and role regression tests.
- [x] Dedicated PostgreSQL migration and status clean (13 migrations); drift probe produced only an empty migration and was removed. Seed completed twice. Prisma generate, typecheck, full tests (26 files, 237 tests), production build, and diff check passed. Chrome at 390px opened the strategy page, saved draft v1, and confirmed it; document scroll width stayed 390px throughout.
- [x] Code committed and pushed as `f1c18aafd068084e18648689aa46b80b608264da`; PR #10 opened at `https://github.com/Aar1nnn/aarin-socialops/pull/10`. Its `verify` job passed generate, migration, seed twice, migrate status, typecheck, full tests, and build.

## Remaining risks

- The single-active-version invariant is enforced by the strategy service under a Client row lock. Direct database writes that bypass the service can violate it.
- Historical unbound LIVE content remains usable manually. AI rewrite/regenerate requires a future explicit human binding action outside this V1 scope.
- Real model and Meta publishing side effects were not exercised.
