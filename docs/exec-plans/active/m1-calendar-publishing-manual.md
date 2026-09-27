# M1 Calendar + Publishing + Manual Publishing

- Branch: `codex/m1-calendar-publishing-manual`
- Base: `origin/main` at `62d3ce8c86cb537365cdb23cf7ae4ee57121c207`
- Status: PR #11 open for human review; final correctness correction verified locally

## Goal

Deliver the existing approval-to-schedule-to-publish workflow in Calendar and Publishing Center, including a truthful manual path for LinkedIn, TikTok, and YouTube.

## Boundaries

Reuse SocialAccount, ContentPlan, ContentItem, ContentVersion, Approval, PublishJob, ManualTask, and AuditLog. Add only MANUAL_PENDING and nullable ContentVersion.promptVersionId. Do not change platform API adapters, worker claim/retry/lease semantics, SocialStrategy, or the next roadmap phase.

## Milestones

- [x] Schema and manual account/content service
- [x] Manual schedule/result state and status invalidation
- [x] Calendar and Publishing operator UI
- [x] Isolated database migration, seed, tests, typecheck, build, and diff review
- [x] Initial implementation committed and submitted as PR #11
- [x] Defect-only closeout submitted to PR #11
- [x] Client mode result-recording correction verified in the isolated database

## Verification

- Isolated ephemeral PostgreSQL: 14 migrations applied; `migrate status` up to date; Prisma schema diff reported no difference.
- After the PR #11 closeout, `pnpm db:generate`, `pnpm db:seed` twice, `pnpm typecheck`, `pnpm test` (27 files, 254 tests), `pnpm build`, and `git diff --check` passed.
- Final correctness correction: existing 14 migrations deployed to a fresh isolated PostgreSQL database; `migrate status` was up to date and schema diff reported no difference. `pnpm db:generate`, `pnpm db:seed`, `pnpm typecheck`, `pnpm test` (27 files, 258 tests), and `pnpm build` passed.
- At 390px, `/accounts`, `/content`, `/calendar`, and `/publishing` loaded without document-level horizontal overflow. Browser forms created a manual account and a manual ContentPlan in the isolated DEMO database.
- In a separate isolated LIVE browser database, an operator completed manual account → manual content → review → approval → schedule → `MANUAL_PENDING` → start → `RUNNING` → `UNKNOWN` → evidence reconciliation to `FAILED`. The test evidence confirmed no external post was created; the job had no worker lease or API attempt, and audit records covered start, unknown, and failure.
- Regression tests cover strategy binding, AI prompt provenance, tenant and role gates, manual start and result concurrency, immutable `UNKNOWN` evidence, account mode changes after job creation, state invalidation, worker exclusion, Calendar date/time behavior, and DST rejection.
- Final regression confirms that a persisted LIVE manual Job can record `UNKNOWN` in DRAFT and reconcile to `FAILED` in DEMO without lease, API attempts, or redispatch; direct `PUBLISHED` and `FAILED` results remain recordable after a mode change. A `MANUAL_PENDING` Job still cannot start outside LIVE, and simulated Jobs cannot record real external results.

## Remaining risk

- Manual result evidence is an operator attestation and URL; this PR does not verify an external post through a platform API.
- `WAITING_CONFIGURATION` explains the cause and next step; it has no recovery action in this PR.
