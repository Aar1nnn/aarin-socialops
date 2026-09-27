# M1 Client Readiness + Monthly Review

- Branch: `codex/m1-client-readiness-monthly-review`
- Base: `origin/main` at `27811f779bad9f36a7a086f2ebeeae9bcae78f44`
- Status: implementation, local verification, and browser acceptance complete; PR and CI pending

## Goal and bounds

Deliver a real-time, client-scoped readiness projection and immutable, versioned monthly review snapshots in one PR. Keep the original dirty worktree untouched. No Prisma schema change, publishing state transition, new AI call, Content workflow change, or next-phase work.

The current zero-confirmed-facts AI workflow remains gated. Historical terminal content does not block current readiness. API publishing readiness includes the registry's external verification; manual workflow is assessed separately. `MONTHLY_V1` facts are validated before storage, and unversioned reports retain a legacy renderer.

## Milestones

- [x] Fetch and verify requested main commit; create clean independent worktree.
- [x] Shared deterministic readiness rules and `/readiness` UI.
- [x] Client-timezone monthly facts and `MONTHLY_V1` contract.
- [x] Append-only `OperationReport` and `/reviews/monthly` UI with legacy handling.
- [x] Navigation and integration verification.
- [x] Isolated database, full automated verification, browser acceptance.
- [ ] Commit, push one PR, wait for CI; stop before merging.

## Verification

Dedicated PostgreSQL database `socialops_m1_readiness_review` at `127.0.0.1:52978`, distinct from previous PR databases. No personal or shared database used.

- `pnpm install --frozen-lockfile`: passed; no lockfile change.
- `pnpm db:generate`: passed.
- `pnpm db:migrate`: applied 14 existing migrations to the new database.
- `pnpm db:seed`: passed twice.
- Prisma `migrate status`: up to date.
- Prisma schema-to-database diff with `--exit-code`: no difference.
- `pnpm typecheck`: passed.
- Final `pnpm test`: 33 files, 305 tests passed. The post-review run includes provider mismatch and older report access regressions.
- `pnpm build`: passed, including 55 static page checks and dynamic `/readiness`, `/reviews/monthly` routes.
- Browser acceptance: 28 checks across `/readiness` and `/reviews/monthly`, OWNER / OPERATOR / VIEWER, empty/populated, desktop and 390px. REAL/MOCK, current partial month, legacy/V1, two distinct report snapshots, VIEWER write denial verified. No page errors, external requests, or document-level horizontal overflow. Screenshots and machine summary: `.tmp/m1-browser-evidence/` (ignored local evidence).
- Independent defect review found and fixed two issues: account connection provider mismatch could overstate metrics/comments readiness; a selected report older than the latest 50 could not be displayed. Final 390px browser recheck verified Facebook API READY, Instagram ATTENTION, manual account READY, a report older than the latest 50 shown by ID, and a foreign-tenant ID hidden. Evidence: `.tmp/m1-browser-evidence/history-over-50-summary.json`.
- Final staged `git diff --check` and unstaged `git diff --check`: passed.

## Remaining risk

Instagram API remains implemented but not externally verified in PlatformRegistry; readiness reports it as limited. Real OAuth, publishing, and pilot outcomes remain unverified by design. The legacy `generateOperationReport()` helper remains for existing scripts/tests, but production `/api/reports` now creates `MONTHLY_V1`. Local browser form writes must use `localhost` rather than `127.0.0.1` because the existing proxy compares the Origin and request host strictly.
