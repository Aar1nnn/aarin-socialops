# Non-publishing modules execution plan

## Status

- State: implementation and verification complete; pull request pending
- Branch: `codex/non-publishing-modules`
- Baseline: `origin/main` at `859d7f05dc635800cde448fb2de17cfbf3cc57d0`
- Scope owner: Aarin SocialOps remains the only System of Record.

## Current objective

Deliver an independently reviewable foundation for Brand, structured PostgreSQL Memory, staged AI content creation, Calendar operations, Social Analytics, and Notifications without importing or changing the PR #4 publishing implementation.

## Verified baseline

- The worktree was clean and `HEAD`, `origin/main`, and their merge base were all `859d7f0` before the branch was created.
- PR #3 (`feat/pilot-operator-ui`, head `5876d84`) and PR #4 (`feat/upstream-platform-foundation-instagram`, head `ede1e53`) are open, mergeable, and based on `859d7f0`.
- This branch does not contain PR #3 or PR #4 commits.
- Existing `Client`, `ContentPlan`, `ContentItem`, `ContentVersion`, `Approval`, `PublishJob`, `MetricSnapshot`, `ResearchRecord`, `NotificationChannel`, `InAppNotification`, and `ManualTask` remain authoritative.
- No repository `AGENTS.md` file exists; the task-supplied global AGENTS rules are authoritative.

## Scope and constraints

### In scope

1. A one-per-client structured `BrandProfile`, with legacy `Client.brandGuidelines` fallback.
2. Query-built Brand, Content, Performance, and Research memory; no vector database.
3. Typed AI pipeline stages and separate AI review records; final output is a new `ContentVersion` that still requires human approval.
4. Calendar read models plus single/bulk rescheduling of existing scheduled content through a service transaction.
5. Canonical social metric aggregation, comparison periods, preserved availability/data-kind semantics, and freshness.
6. In-app events plus lightweight webhook/email channels with best-effort delivery isolation.
7. Operator pages, API routes, migration, tests, and documentation.

### Explicitly out of scope

- Platform Foundation, Facebook/Instagram publishing behavior, publisher adapters, and publish worker behavior. The only existing Facebook service change links post-metric snapshots to their existing `ContentItem`; it does not change publishing behavior and does not overlap PR #4's file set.
- LinkedIn, TikTok, or YouTube provider work.
- A second Workspace, Content, Post, Scheduler, Analytics, Research, or Notification database.
- Vector DBs, automatic approval, AI-created `PublishJob` rows, or heavy notification dependencies.
- Production dependency additions or upgrades.

## Architecture decisions

1. `Client` is the current tenant/workspace boundary; `BrandProfile.clientId` is unique and every service query includes `clientId`.
2. Memory is a set of typed read models assembled from current PostgreSQL tables. It is not persisted as a parallel knowledge store.
3. AI stages use Zod-validated contracts. Only `ProductField.status = CONFIRMED` values enter context. `AiContentReview` is intentionally separate from `Approval`.
4. AI generation may supersede a mutable content version but must not create a `PublishJob`; any active job for a superseded version is cancelled before the new draft becomes current.
5. Calendar mutations only move an already scheduled, approved current version and its existing active `PublishJob`; they never create scheduler records.
6. `MetricSnapshot` gains only an optional `contentItemId` link for by-post analysis. Missing availability stays distinct from numeric zero; REAL/MOCK provenance is retained.
7. Notification channel configuration extends `NotificationChannel`; `InAppNotification` remains the event record. External dispatch occurs after event persistence and catches channel failures.
8. All upstream implementation is independently written. OpenSocial informs an Adapt of module boundaries; AGPL projects are architecture/UX reference only.

## Implementation sequence

1. [completed] Schema and migration: Brand profile, AI review, optional metric-to-content link, notification channel delivery metadata.
2. [completed] Brand and Memory services, API, and operator page.
3. [completed] AI pipeline contracts, adapters, context builders, persistence service, and workflow action.
4. [completed] Calendar query/reschedule service, API, and month/week/list operator views.
5. [completed] Analytics normalization/aggregation/freshness service and operator view.
6. [completed] Notification event/channel/dispatch service and operator view.
7. [completed] Required regression and boundary tests.
8. [completed] Full verification and defect-first quality review.
9. [in progress] Clear commits, push, open unmerged PR, and attach the PR artifact.

## Acceptance criteria

- Tenant isolation is enforced and tested for Brand, Memory, Calendar, Analytics, and Notifications.
- Legacy `brandGuidelines` is used when no structured profile exists.
- Memory extracts recent content and aggregates performance/research without cross-tenant leakage.
- AI context contains confirmed facts only; all stage outputs validate; AI review creates no human approval or publish job.
- Calendar filters work and rescheduling preserves current-version approval and scheduled-job constraints.
- Analytics canonical mapping, periods, change, missing-vs-zero, REAL/MOCK, and freshness are tested.
- Notification event/channel dispatch works and a failing external dispatcher cannot roll back the persisted event.
- `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` pass.

## Modified files

- Schema/migrations: `prisma/schema.prisma`, `prisma/migrations/202609210001_non_publishing_foundations/`, and the idempotent repair migration `202609210002_non_publishing_foundations_repair/` required by the existing shared local database state.
- Services/contracts: Brand, Memory, AI content, Calendar, Analytics, and Notifications under `src/services/` and `src/lib/`.
- Operator/API: `/brand`, `/calendar`, `/analytics`, `/notifications`, their mutation routes, shell navigation, and minimal shared styling.
- Analytics linkage: only `syncFacebookPostMetrics` in `src/services/facebook-service.ts`; no publish adapter, publish worker, Instagram, connection, or platform-foundation behavior changed.
- Tests: `tests/non-publishing-modules.test.ts`.
- Documentation: README, this plan, ADR `0006`, and four upstream audit records.

## Test status

- Baseline structure and PR #3/#4 file sets: verified by read-only audit.
- `pnpm db:generate`: passed.
- `pnpm db:migrate`: passed against the existing local PostgreSQL database.
- `node node_modules/prisma/build/index.js validate`: passed; the schema is valid.
- `pnpm typecheck`: passed after the final implementation changes.
- `pnpm test tests/non-publishing-modules.test.ts --reporter=verbose`: 14/14 passed after defect fixes.
- `pnpm test`: 14 files and 97 tests passed after all defect fixes.
- `pnpm build`: passed after all defect fixes and generated 34 application routes.
- `git diff --check`: passed before and after final staging.
- Current branch UI: `http://localhost:3001` returned HTTP 200 after the expected `/login` redirect.

## Known issues and uncertainties

- PR #3 redesigns the operator shell and existing pages. This branch will add isolated pages and make only a small navigation edit; final integration should merge business pages first, then reconcile navigation/design tokens with PR #3.
- PR #4 changes publishing services. This branch avoids those files; any future integration should retain PR #4's publishing checks and use this branch's new services as separate modules.
- Email delivery uses a configurable HTTP gateway contract in this foundation; direct SMTP/provider integrations remain out of scope.
- Webhook configuration rejects obvious private/loopback literal endpoints and redirects, but production deployment should also enforce outbound network policy and DNS/IP revalidation to close DNS-rebinding paths.
- Notification event contracts are implemented, but automatic producers in PR #4's publish worker and future lead ingestion remain an integration step after branch convergence.

## Next task

Create clear commits, push this branch, open an unmerged PR, record its URL here, and attach it to the task.
