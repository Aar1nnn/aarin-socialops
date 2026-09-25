# PR #6 / PR #7 closeout

## Objective and boundaries

Merge PR #6 boundary hardening, then converge and validate PR #7's seven-module expansion on current `main`. Preserve existing content, approval, publishing, analytics, and notification sources of truth. Do not implement UI V2, new publishing platforms, Instagram external acceptance, or Docker Desktop repairs as product work. Use DEMO or an explicitly authorized dedicated Facebook test path for the controlled workflow.

## Remote and workspace checkpoint (2026-09-26)

- PR #6 merged into `origin/main` as `63e826a`; PR #7 remote head remains `b56d1ca` until the validated integration branch is pushed.
- GitHub reported no reviews, inline review comments, or issue comments on either PR at this checkpoint.
- Current `codex/non-publishing-modules` worktree was clean before closeout edits.
- `D:/AI-Workspace/projects/海外内容运营` is the PR #7 branch, with five local commits ahead of remote and about 20 modified files plus an untracked migration and context file. Preserve this worktree unchanged; inspect its work as input and integrate in a separate clean worktree/branch.
- Detached worktree `7417` could not be checked by the sandboxed Git due to dubious ownership. Do not write there.

## Sequence and progress

1. [x] Review PR #6 invariants, fix only blocking defects, run relevant tests and full CI, then merge #6. Merged as `63e826a`.
2. [x] Refresh main and converge PR #7, preserving both sets of behavior and existing uncommitted user work. The clean integration branch is `codex/pr7-closeout` from local `9dc5f0b` plus `origin/main` at `63e826a`; merge commit `c974be9`.
3. [x] Verify event routing, queue concurrency and DST, Brand Autofill model path, and asset URL availability; integrate evidence-backed fixes and targeted tests.
4. [ ] Run Prisma generate/migrate/seed twice/status, typecheck, full tests, build, diff check, and controlled DEMO workflow; confirm remote CI. All local checks passed; remote CI pending.
5. [ ] Merge PR #7 and check final main commit, migrations, build, and CI.

## PR #6 review findings

- `usedFactKeys` rejects model-declared unconfirmed keys. This is not a complete proof that draft prose contains only confirmed facts; human approval remains required.
- `updateProductFacts` increments Product `dataVersion` in its transaction. Existing seed upserts do not rewrite existing demo facts. The generation path locks and rechecks Product before persistence.
- Calendar checks existing scheduled item/current version/latest account approval/active job. Its writes currently lack conditional state checks against a concurrent worker or approval change; close this race before merge.
- Channel configuration requires HTTPS and default fetch rejects redirects. Runtime env resolution currently lacks a second HTTPS check; add it before merge. These checks do not constitute complete outbound network protection.

## Verification record

- Read-only remote state, PR diff, review comments, worktrees, plans, schema, and relevant services reviewed.
- PR #6 fixes: runtime HTTPS validation immediately before notification transport; conditional Calendar item/job updates that roll back if state changed after the initial read.
- `pnpm typecheck`: PASS.
- Database-backed targeted test: 1 file / 16 tests PASS with `node --env-file=.env`.
- Full local suite: 19 files / 147 tests PASS with `node --env-file=.env`.
- `pnpm build`: PASS, 33 static pages generated.
- `git diff --check`: PASS (Windows LF/CRLF notices only).
- Defect-first review of the focused diff found no remaining blocking issue. Declared AI fact keys remain a partial claim check; HTTPS and redirect rejection are limited egress controls, not a complete outbound security boundary.
- PR #6 GitHub `verify` on `b1606de`: PASS, 19 test files and 33-page build; no review objections. PR #6 merged as `63e826a`.
- PR #7 merge conflicts were inspected in AI Pipeline, Calendar, Notification Service, and shared tests. The merged code retains PR #6 Product version lock, confirmed-fact-key gate, HTTPS/redirect checks, existing-schedule restriction, and state-conditional Calendar writes, alongside PR #7 composition context, scheduling locks/conflicts, and notification rules/cooldown.
- Original PR #7 worktree and detached worktree remain untouched and dirty; no user changes were overwritten.
- Integrated the existing PR #7 worktree's uncommitted capability fixes in this isolated branch: durable notification-delivery leases and worker recovery, account-scoped metric identities, latest-dimension health, tenant-timezone patterns, atomic BrandProfile confirmation, fresh remote asset URL resolution, and schedule slot release after approval/version invalidation. The source worktree remains unchanged.
- Preserved PR #6's runtime HTTPS endpoint check and `redirect: "error"` when integrating notification leases. These are limited transport controls, not complete SSRF or external reachability proof.
- `pnpm db:generate`: PASS; `pnpm db:migrate`: PASS with 12 migrations; seed executed twice; `node ./node_modules/prisma/build/index.js migrate status`: up to date. `pnpm exec prisma migrate status` was unavailable from the shell, so the package CLI was invoked directly.
- `pnpm typecheck`: PASS; targeted 6 files / 124 tests PASS; final full local suite 24 files / 218 tests PASS. The first full run exposed a test fixture missing a ProductAsset relation and test cleanup order; fixed both before the passing rerun.
- `pnpm build`: PASS on final code, 46 static pages generated; `git diff --check`: PASS (Windows LF/CRLF notices only).
- Defect-first review found and fixed a same-account analytics suffix collision: content metrics now require the complete, case-sensitive remote post ID after the database prefilter. A regression test covers mixed-case IDs and `other-<id>` collisions.
- Independent DEMO customer integration test: confirmed facts only -> generated version -> human change request -> immutable revised version -> human approval -> scheduled job -> simulated publish -> MOCK metric -> urgent lead/in-app notification -> manual handoff. One isolated test passed; no real customer publish.
- Asset `ready` means a locally validated HTTPS candidate. Signed URL expiry is checked and stale URLs can be refreshed via storage; platform-side fetchability remains externally unverified.
- First PR #7 CI attempt on `3caaf4c` failed in both push/PR jobs on one concurrency-test assertion. The `STALE_OPERATION` rejection added by PR #6 is another valid rollback outcome when a concurrent claim wins. The test now accepts this code and still asserts the original item/job times are unchanged; local targeted 16/16 and full 24 files / 218 tests pass. A new CI run is required before merge.

## Next action

Finish production build and final diff review, commit/push the isolated integration branch to PR #7, await remote PostgreSQL CI, then merge and verify main.
