# PR #6 / PR #7 closeout

## Objective and boundaries

Merge PR #6 boundary hardening, then converge and validate PR #7's seven-module expansion on current `main`. Preserve existing content, approval, publishing, analytics, and notification sources of truth. Do not implement UI V2, new publishing platforms, Instagram external acceptance, or Docker Desktop repairs as product work. Use DEMO or an explicitly authorized dedicated Facebook test path for the controlled workflow.

## Remote and workspace checkpoint (2026-09-25)

- `origin/main`: `9f1e6e5`; PR #6 head `2eb3637`, OPEN/CLEAN with successful `verify`; PR #7 head `b56d1ca`, OPEN/CLEAN with successful `verify`.
- GitHub reported no reviews, inline review comments, or issue comments on either PR at this checkpoint.
- Current `codex/non-publishing-modules` worktree was clean before closeout edits.
- `D:/AI-Workspace/projects/海外内容运营` is the PR #7 branch, with five local commits ahead of remote and about 20 modified files plus an untracked migration and context file. Preserve this worktree unchanged; inspect its work as input and integrate in a separate clean worktree/branch.
- Detached worktree `7417` could not be checked by the sandboxed Git due to dubious ownership. Do not write there.

## Sequence and progress

1. [x] Review PR #6 invariants, fix only blocking defects, run relevant tests and full CI, then merge #6. Merged as `63e826a`.
2. [ ] Refresh main and converge PR #7, preserving both sets of behavior and existing uncommitted user work. The clean integration branch is `codex/pr7-closeout` from local `9dc5f0b` plus `origin/main` at `63e826a`.
3. [ ] Verify event routing, queue concurrency and DST, Brand Autofill labeling/model path, and asset URL availability; fix evidence-backed gaps.
4. [ ] Run Prisma generate/migrate/seed twice/status, typecheck, full tests, build, diff check, and controlled DEMO workflow; confirm remote CI.
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

## Next action

Verify the PR #7 merge, then inspect and selectively integrate the existing local PR #7 uncommitted work without writing to its original worktree.
