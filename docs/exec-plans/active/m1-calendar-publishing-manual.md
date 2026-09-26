# M1 Calendar + Publishing + Manual Publishing

- Branch: `codex/m1-calendar-publishing-manual`
- Base: `origin/main` at `62d3ce8c86cb537365cdb23cf7ae4ee57121c207`
- Status: PR #11 defect-only closeout verified locally; closeout push and CI pending

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
- [ ] Push defect-only closeout commit and await CI

## Verification

- Isolated ephemeral PostgreSQL: 14 migrations applied; `migrate status` up to date; Prisma schema diff reported no difference.
- After the PR #11 closeout, `pnpm db:generate`, `pnpm db:seed` twice, `pnpm typecheck`, `pnpm test` (27 files, 254 tests), `pnpm build`, and `git diff --check` passed.
- At 390px, `/accounts`, `/content`, `/calendar`, and `/publishing` loaded without document-level horizontal overflow. Browser forms created a manual account and a manual ContentPlan in the isolated DEMO database.
- In a separate isolated LIVE browser database, an operator completed manual account → manual content → review → approval → schedule → `MANUAL_PENDING` → start → `RUNNING` → `UNKNOWN` → evidence reconciliation to `FAILED`. The test evidence confirmed no external post was created; the job had no worker lease or API attempt, and audit records covered start, unknown, and failure.
- Regression tests cover strategy binding, AI prompt provenance, tenant and role gates, manual start and result concurrency, immutable `UNKNOWN` evidence, account mode changes after job creation, state invalidation, worker exclusion, Calendar date/time behavior, and DST rejection.

## Remaining risk

- Manual result evidence is an operator attestation and URL; this PR does not verify an external post through a platform API.
- `WAITING_CONFIGURATION` explains the cause and next step; it has no recovery action in this PR.
- If an owner changes a client from LIVE while a manual job is `RUNNING` or `UNKNOWN`, the existing result gate requires LIVE and prevents reconciliation until the mode is restored. Changing client mode semantics is outside this defect-only closeout.
