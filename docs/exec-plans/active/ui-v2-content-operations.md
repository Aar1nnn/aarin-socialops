# UI V2 Phase 2 — Content operations slice

## Baseline and scope

- PR #8 merged as `86bdc3fd70cafa5e775131f8bf483810dac80ff6`; this branch starts from that `origin/main` commit in a separate clean worktree.
- The dirty original `D:\AI-Workspace\projects\海外内容运营` worktree is untouched.
- Deliver only `/content` search/filter/list and `/content/[id]` operations. Reuse ContentPlan, ContentItem, ContentVersion, Approval and PublishJob; no schema, publishing adapter, OAuth, worker, Calendar, Accounts, Products or UI Phase 3 changes.

## Evidence and design

- Existing content composition APIs already support version-bound regenerate, rewrite, draft save and restore. Change requests also require `expectedVersionId`.
- The old content page combines creation, listing and all per-item operations in expandable table rows. Move the latter to a dedicated detail page; keep creation entry and existing API paths.
- The old submit/review/schedule forms do not send the version seen by the operator. Add optional expected-version preconditions at the existing service gates and send them from the new UI, preserving legacy callers.
- AI review is advisory; only Approval records for the current version/account count as human approval. Do not expose ordinary retry for UNKNOWN jobs.
- Use a small client-side action component to show API errors and 409 version conflicts without losing the operator's draft; server rendering remains the source of truth after refresh.

## Milestones

1. Implement tenant-scoped list/detail read model and operator-facing statuses, filters and links.
2. Add version-bound interactive operations and service preconditions with regression tests.
3. Verify Prisma generate, typecheck, full tests, build, diff; perform isolated browser workflow and narrow-screen checks where local PostgreSQL is available.
4. Defect-first review, small commits, push and create an open PR; wait for CI.

## Acceptance and risks

- Isolated customer: confirmed product facts → create → revise → submit → request changes → revise → approve → schedule → status entry. DEMO only; never publish to a real account.
- Verify tenant isolation, VIEWER read-only, stale approval and version conflict, missing account/fact blockers, 390px access, and publishing/OAuth compatibility tests.
- UI may be blocked by unavailable local PostgreSQL; report browser/API/database evidence separately from remote CI and do not equate login HTTP 200 with workflow acceptance.

## Progress

- [x] Read UI architecture plan and audit PR #8, baseline and relevant API/service contracts.
- [x] Implement and test content operations. The content list now searches/filters tenant-scoped existing items, and the detail page uses the existing version, approval and job records.
- [x] Local browser acceptance and complete verification. In `socialops_ui_v2_content_ops`, all 12 migrations, seed, Prisma generate, typecheck, 25 test files / 228 tests and production build passed. Browser: confirmed DEMO product facts → content → AI rewrite v2 → review → change request → manual v3 → review → approval → DEMO schedule → publishing entry; separate VIEWER login saw no write controls and API returned 403. Search and scheduled filter returned expected items; stale UI write returned 409 with compare link. At 390px the detail edit/review controls were reachable with no document overflow; content list and publishing had no overflow at 390px, and publishing was also checked at 800/1366/1440/1920px.
- [x] Open [PR #9](https://github.com/Aar1nnn/aarin-socialops/pull/9) for review; both initial remote `verify` checks passed on `ddaf43d`. PR remains open and unmerged.

## Defect-first review notes

- Browser acceptance exposed a DEMO rewrite 500: the old copy was appended to `theme`, which the mock adapter reused as a title beyond the 200-character schema limit. The copy now travels in the composition objective while theme remains short; a real-mock-adapter regression test covers this.
- List filters now include deselected historical accounts even though creation offers only currently selected accounts; tenant-scoped regression test added.
- Version preconditions are optional for legacy API callers but mandatory in new UI requests. Concurrent stale UI operations return 409 and do not persist a new version, approval or job.
- No real platform post was sent. External Instagram acceptance and full Phase 2 Calendar/Publishing details/Accounts/Products remain out of scope.
