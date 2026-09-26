# UI Architecture V2 — Phase 1 delivery

## Objective and scope

Implement the grouped operator navigation and stable shell from `ui-architecture-v2.md` on current `main`, plus canonical `/accounts` and a read-first `/publishing` center. Preserve Quiet Enterprise styling, tenant scoping, existing workspace switching, permissions, OAuth callback/return paths, and all publishing safety gates. Do not implement Phase 2/3 page rewrites or modify Prisma schema, worker, adapters, OAuth, retry, or reconciliation services.

## Baseline and protected work

- 2026-09-26 remote `main`: `e4d6e8e3bc7664685ba6172fc7edee9705d3658e`; post-merge PostgreSQL CI run `36163157978` succeeded. No open PRs at kickoff.
- New clean worktree: `C:/Users/aarinsim/AppData/Local/Temp/aarin-ui-v2-phase1-20260926`, branch `feat/ui-v2-phase1`, created from `origin/main` at that SHA.
- Original `D:/AI-Workspace/projects/海外内容运营` remains on `feat/socialops-core-capability-expansion` at `9dc5f0b` with uncommitted PR #7 backend/service/schema/test work and an untracked context document/migration. It contains no UI Phase 1 changes to inherit. Do not edit, stash, reset, or switch it.
- Repository has no tracked `AGENTS.md`; follow the global rules supplied by the user.

## Decisions

- Keep `/connections` rendering the shared account-management surface as a compatibility alias in Phase 1; keep existing `/api/connections/**` actions and Meta OAuth `returnTo=/connections` valid. Add route contract coverage before moving canonical navigation to `/accounts`.
- Quick Create links to existing content/product creation forms only, with role-aware visibility. No command palette or direct writes.
- Publishing is a tenant-scoped read projection of existing jobs and attempts. `UNKNOWN` means “结果待确认”; no generic retry control.
- Keep page-local platform/account filtering for later phases; do not introduce global persisted filter state.

## Milestones

1. [x] Add route/OAuth and status contract tests before canonical link changes.
2. [x] Implement grouped nav, workspace context bar, role-aware Quick Create, notification summary, responsive access.
3. [x] Add `/accounts` alias/entry and account-first summary without changing connection actions.
4. [x] Add read-first `/publishing` and shift only essential dashboard/content/page links and copy.
5. [x] Verify typecheck, focused and full tests, production build, route/login contracts, responsive widths, permissions, and final diff.
6. [ ] Commit, push, open Phase 1 PR, and wait for remote CI; do not merge this PR.

## Verification log

- Kickoff read-only audit: UI IA plan read in full; route, shell, status, OAuth, switch-client, current page and test boundaries inspected.
- Route contract was added first; its `/accounts` assertion failed before the alias existed, then passed after implementation. `/connections` form actions and Meta OAuth return path remained unchanged.
- `pnpm db:generate` passed after access to the pinned Prisma engine; a new local PostgreSQL database `socialops_ui_v2_phase1` received all 12 existing migrations. `pnpm db:seed` passed twice and `prisma migrate status` reported up to date. No original `socialops` database migration or seed was run.
- Final local verification: `pnpm typecheck`, full `pnpm test` (25 files / 225 tests), `pnpm build`, and `git diff --check` passed. The first full-test attempt lacked `DATABASE_URL`; it was rerun successfully with the isolated database.
- Authenticated Chrome checks used the isolated DEMO client: owner login returned 303; `/`, `/accounts`, `/connections`, `/publishing`, `/content`, `/calendar`, and `/settings` rendered at 1366, 1440, 1920, and 800px. At 390px a page-wide overflow was found, corrected by a min-width-safe page grid, then rechecked with document width 375 inside a 390px viewport. The compact mobile shell is 174px high, Quick Create opens both existing paths, and scrolling the grouped nav makes `/accounts` visibly reachable.
- The isolated DEMO workflow created four simulated publish jobs, a lead, mock metrics, and a report. One simulated job was marked `UNKNOWN` solely in that isolated database: `/publishing` showed one “结果待确认” row and no retry button. A test `VIEWER` had no Quick Create and a disabled Meta connection control. Owner workspace switch returned 303 and displayed the other test client; viewer cross-client switch returned 403. Declined Meta callback returned 400 from the existing route, not a 404.
- Local visual screenshots (not committed): `C:/Users/aarinsim/AppData/Local/Temp/aarin-ui-v2-phase1-visual/`.
- Defect-first review found and fixed the 390px grid overflow. Remaining Phase 1 risk: a real Meta OAuth success callback was not exercised because no external account authorization was performed; the path, form return value, and denied callback were verified.

## Open risks

- `/accounts` and `/connections` must not diverge in forms or return paths.
- Responsive access must work below 900px; desktop-only screenshots are insufficient.
- Local visual verification requires a running isolated PostgreSQL environment and authenticated test client; login-page HTTP 200 alone is not acceptance.
