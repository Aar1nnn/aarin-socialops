# Social Operations Core Capability Expansion

## Status

- Branch: `feat/socialops-core-capability-expansion`
- Baseline: `main` at `9f1e6e5`
- Started: 2026-09-23
- Current phase: full regression and release verification
- UI V2: explicitly out of scope
- Instagram external acceptance: explicitly deferred

## Goal

Deepen seven existing Aarin SocialOps capabilities without creating a second content, scheduling, publishing, analytics, asset, approval, or notification system. Every write remains tenant scoped and preserves the existing publishing safety contracts.

## Fixed sources of truth

| Module | Source of truth |
| --- | --- |
| Content composition | `ContentPlan`, `ContentItem`, `ContentVersion` |
| Brand | `BrandProfile` |
| Product facts | `Product`, `ProductField` |
| Approval | `Approval`, `ContentVersion` |
| Assets | `Asset` |
| Calendar | `ContentItem`, `PublishJob` |
| Notifications | `InAppNotification`, `NotificationChannel`, `NotificationDelivery` |
| Analytics | `MetricSnapshot` |
| Research | `ResearchRecord` |

## Schema changes

The existing models cannot reliably express five required capabilities, so the following additive changes are planned:

1. `ContentVersion`: version lineage, creation source/reason, and optional creator. Existing immutable versions remain authoritative.
2. `ReviewComment`: minimal structured review feedback tied to client, item, version, and reviewer. It is not a chat system.
3. `AssetTag` / `AssetTagLink`: tenant-scoped reusable tags over existing `Asset` records.
4. `ScheduleQueue` / `ScheduleSlot`: tenant-scoped recurring slot configuration; actual schedules still become `ContentItem.scheduledAt` and `PublishJob.nextAttemptAt` through existing services.
5. `NotificationRule` plus notification event/dedupe metadata: rule matching and cooldown without replacing the existing inbox or delivery records.

All new relations use tenant-scoped compound keys where the related model supports them. Migrations are additive, forward-only, and do not delete or rewrite existing records.

## Phase A — Composition, Brand, Approval

### Content Composition Engine

- Add a composition service over existing context builders, text adapters, and AI pipeline.
- Generate or regenerate exactly one platform variant without changing sibling items.
- Support structured rewrite actions, autosave with current-version compare-and-swap, immutable restore, history, and comparison.
- Every material change creates a new `ContentVersion`; old approvals remain tied to old versions and are never reused.
- Only confirmed product facts enter generation. AI never creates `Approval` or `PublishJob`.

### Brand Autofill

- Accept pasted text, existing workspace context, product information, notes, and structured suggestions.
- Validate suggestions with Zod and return a transient `SUGGESTED` draft.
- Human confirmation merges accepted fields into `BrandProfile`; unconfirmed suggestions never overwrite stored facts.
- Completeness is calculated deterministically from required field presence.
- URL fetching remains an adapter boundary and is not implemented in this phase.

### Approval / Collaboration

- Add request-changes feedback and a revision cycle without editing an old version.
- Build a read-only timeline from versions, approvals, review comments, audits, and publish jobs.
- Preserve approval invalidation for content, product facts, account, and platform target changes.

## Phase B — Assets and Scheduling

### Asset Library

- Add tenant-scoped search/filter/tag queries, duplicate fingerprint detection, usage lookup, and public-media availability classification.
- Dimensions and duration continue to live in existing `Asset.metadata`; no duplicate metadata columns are introduced.
- Duplicate detection reports an existing asset and never deletes it automatically.

### Calendar / Scheduling

- Add account-scoped queues and recurring weekly slots with bounded horizon calculation.
- Queue assignment calls the existing publication scheduling service, preserving approval, account, timezone, capability, and `UNKNOWN` rules.
- Add structured conflict detection and partial-result bulk rescheduling.
- Running, published, unknown, failed, and cancelled work remains immutable.

## Phase C — Notifications and Analytics

### Notification Rules / Inbox

- Add a finite event registry, tenant-scoped rules, rule-based channel selection, cooldown deduplication, and unread/important/all queries.
- Support mark read, unread, and all read.
- External delivery failure is recorded only in `NotificationDelivery` and never rolls back the originating business event.

### Analytics

- Add canonical filtered queries, content/account/period comparisons, content performance sorting, explainable pattern analysis, and unified data-health output.
- `MetricSnapshot` remains the only metric fact source; latest snapshots are selected deterministically and missing values never become zero.
- Pattern conclusions require a minimum sample and otherwise return `INSUFFICIENT_DATA`.
- Review output remains `FACT`, `OBSERVATION`, `HYPOTHESIS`, and `RECOMMENDATION`; correlation is never presented as causation.

## API changes

New route handlers may expose composition actions, version history/compare/restore, brand draft/confirmation, review feedback/timeline, asset queries/tags/usage, queues/conflicts/bulk rescheduling, notification rules/inbox, and analytics queries. Every route must use `requireContext`, service-level tenant checks, role checks for writes, Zod validation, structured errors, and audit logs where appropriate.

## Key invariants

- No UI page, layout, stylesheet, sidebar, or dashboard changes.
- No new platform publishing implementation and no real external publish.
- No weakening of `UNKNOWN`, retry, approval, TokenVault, usage reservation, or tenant isolation behavior.
- No frontend-provided `userId` or trusted `clientId` boundary.
- No direct Prisma filters accepted from API callers.
- No AI suggestion becomes confirmed brand or product fact without explicit human confirmation.

## Test plan

- Phase A: tenant isolation, confirmed-facts-only generation, single-platform regenerate, rewrite/version creation, restore, compare, concurrency, brand validation/confirmation/completeness, request changes, timeline, and approval invalidation.
- Phase B: asset search/filter/tags/duplicates/usage/availability; queue next slot/timezone/conflicts/recurrence/bulk results and protected job states.
- Phase C: notification matching/channels/dedupe/failure isolation/inbox/tenant scope; canonical analytics/latest snapshot/comparisons/pattern minimum/freshness/review labels.
- Regression: Facebook, PlatformRegistry, Instagram adapter, PublishJob, `UNKNOWN`, Approval, TokenVault, usage reservation, AuditLog, and complete existing suite.

## Verification record

- PR #4 closeout: migration, seed twice, typecheck, 17 files / 128 tests, build, diff check, and GitHub CI passed; merged as `fbadf61`.
- PR #5 closeout: migration, seed twice, typecheck, 18 files / 141 tests, build, diff check, and GitHub CI passed; merged as `9f1e6e5`.
- Phase A: additive migration applied; `pnpm typecheck` passed; full suite passed with 19 files / 149 tests; `git diff --check` passed.
- Phase B: additive migration applied; `pnpm typecheck` passed; full suite passed with 20 files / 157 tests; `git diff --check` passed.
- Phase C: additive migration applied; `pnpm typecheck` passed; full suite passed with 21 files / 164 tests; `git diff --check` passed.
- Expansion branch final verification: pending.

## Remaining limitations

- No website crawler, vector database, full recurrence campaign system, UI V2, or external Instagram acceptance.
- Image generation remains an interface boundary.
- LinkedIn, TikTok, and YouTube publishing remain unimplemented.

## Next step

Run the required migration/seed/regression/build/security checks, update capability documentation, and open the feature PR without merging it.
