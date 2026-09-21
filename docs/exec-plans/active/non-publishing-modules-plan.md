# Non-publishing modules implementation plan

## Objective

Build the non-publishing foundations that turn Aarin SocialOps into a broader social operations system while preserving Aarin as the single system of record. This branch is independent from PR #4 and does not change Facebook/Instagram publishing, publish retries, worker dispatch, provider adapters, or platform OAuth behavior.

## Branch and integration boundary

- Branch: `feat/brand-memory-ai-calendar-analytics`
- Base: `origin/main` at `859d7f0`
- PR #3 and PR #4 remain independent and unmodified.
- Existing `Client`, content, approval, publish, metrics, interaction, task, audit, and usage records remain authoritative.
- No vector database, second scheduler, second analytics store, or second notification store is introduced.

## Upstream review

The reviewed repositories are recorded under `docs/upstreams/`. TryPost, BrightBean Studio, and Postiz are AGPL references. OpenSocial did not expose a sufficiently clear repository license in the reviewed checkout. All implementation in this branch is therefore clean-room TypeScript based on observed module boundaries and behavior; no upstream source is copied.

## Data model additions

1. `BrandProfile`: one-to-one structured brand context for `Client`; `Client.brandGuidelines` remains the compatibility fallback.
2. `AnalyticsSyncState`: tenant-scoped operational sync state. `MetricSnapshot` remains the analytics fact source.
3. `NotificationDelivery`: append-only delivery outcome for an existing `InAppNotification` and `NotificationChannel`. `InAppNotification`, `NotificationChannel`, and `ManualTask` remain authoritative.

All schema changes are additive and delivered by one forward migration.

## Delivery phases

### Phase A — Brand and memory

- Tenant-scoped BrandProfile read/upsert service and operator page.
- Compatibility fallback to `Client.brandGuidelines` when a structured profile is absent.
- Structured brand, recent-content, performance, and research memory builders using PostgreSQL queries.
- No cross-tenant queries and no embedding/vector dependency.

### Phase B — AI foundation

- Compose only BrandProfile, confirmed product facts, content memory, performance context, and research memory.
- Explicit stages: strategy, generation, platform variants, reviewer, rewrite/humanizer, shortener, image-prompt placeholder.
- Keep structured output validation.
- Persist only `ContentPlan`, `ContentItem`, and `ContentVersion` in `DRAFT` state.
- Never create an `Approval` or `PublishJob` from the AI pipeline.

### Phase C — Calendar foundation

- Read model over existing plans, items, versions, approvals, and publish jobs.
- Month/week/list views plus platform, account, and status filters.
- Single and bulk reschedule through a tenant-scoped service.
- Refuse changes for running, published, unknown, failed, or cancelled work; preserve the approved content version and account binding.

### Phase D — Analytics foundation

- Canonical metric keys and period aggregation by post/account/platform.
- Day/week/month comparisons with current, previous, and percentage change.
- `null` for unavailable values; never coerce missing data to zero.
- Freshness states `fresh`, `stale`, `syncing`, and `failed`, backed by `AnalyticsSyncState` and snapshot timestamps.
- Programmatic calculations remain authoritative; AI review labels are explanatory only.

### Phase E — Notifications foundation

- Create the in-app notification first, then perform best-effort external dispatch.
- Webhook and generic HTTP-email adapters use server-only credential references.
- Record each delivery success/failure without rolling back the originating business event.
- Cover urgent leads, publish failures/unknown results, token/permission/connection issues, and high-priority manual tasks through a typed event boundary.

### Phase F — operator UI and verification

- Navigation: overview, content, calendar, products, brand, analytics, interactions/leads, connections, settings.
- AI capabilities remain inside the content workflow rather than becoming separate top-level tools.
- Update seed data only for deterministic demo fixtures.
- Add service-level regression tests, then run the complete quality gate.

## Acceptance criteria

- Brand: create/read/update, tenant isolation, legacy compatibility.
- Memory: recent content, performance and research context, no cross-tenant leakage.
- AI: confirmed facts only, validated output, AI review never equals human approval.
- Calendar: filters, service-layer reschedule, tenant isolation, protected terminal/running states.
- Analytics: canonical mapping, aggregation, period comparison, freshness, missing-is-not-zero.
- Notifications: event creation, webhook/email dispatch, delivery failures isolated from the main event.
- `pnpm db:generate`
- `pnpm db:migrate`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `git diff --check`

## Progress

- [x] Independent branch created from current `origin/main`.
- [x] Existing Aarin models and service boundaries audited.
- [x] Four upstream repositories reviewed and license boundary recorded.
- [x] Brand and memory foundation.
- [x] AI content pipeline foundation.
- [x] Calendar foundation.
- [x] Analytics foundation.
- [x] Notifications foundation.
- [x] Operator UI integration.
- [x] Local migration, typecheck, 14 test files / 94 tests, production build, and diff check.
- [ ] Final independent diff review and GitHub CI.
- [ ] Push branch and open an unmerged pull request.

## Current verification

- `pnpm db:generate`: PASS
- `pnpm db:migrate`: PASS for both additive migrations
- `pnpm typecheck`: PASS
- `pnpm test`: PASS — 14 files, 94 tests
- `pnpm build`: PASS — 33 application routes/pages
- `git diff --check`: PASS (Git only reports the existing Windows LF/CRLF conversion notice)

## Remaining limitations

- Image generation/review remains an explicit interface-only pipeline stage.
- Notification email uses a generic server-side HTTP endpoint; SMTP and third-party notification dependencies are intentionally not added.
- Calendar drag/drop moves a record to a date using the service layer; advanced recurrence and visual conflict resolution are not part of this foundation.
- Analytics review text is deterministic and labeled; no causal AI analysis is claimed.

## Explicit non-goals

- No Facebook/Instagram publishing changes.
- No LinkedIn, TikTok, or YouTube implementation.
- No OAuth, TokenVault, worker dispatch, publish retry, or reconciliation changes.
- No direct external social publishing.
- No dependency additions or upgrades.
