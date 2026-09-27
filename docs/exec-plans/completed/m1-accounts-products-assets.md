# M1 Accounts + Products + Assets

- Branch: `codex/m1-accounts-products-assets`
- Base: `origin/main` at `482452ad79f0fb26498373b68a26334d3706fda4`
- Status: implementation and local verification complete; PR and CI are external review gates

## Goal

Deliver account-first operations, fact-first product inventory/detail, and a usable asset library in one PR. Reuse existing SocialAccount, PlatformConnection, ProductField, Asset, ProductAsset, ContentVersionAsset, capability, availability, and publishing boundaries.

## Boundaries

No schema change, new platform API, OAuth or worker protocol rewrite, Publishing state-machine change, Client Readiness, Monthly Review, or real external publishing. Keep the original dirty worktree untouched. Historical PublishJob execution mode comes from `job.adapter`.

## Milestones

- [x] Fetch and verify the requested main commit; create a clean independent worktree.
- [x] Accounts account-first UI and safe account mutation guards.
- [x] Products inventory/detail and fact version concurrency guards.
- [x] Assets library, pagination, tags, duplicate upload and linking guards.
- [x] Cross-module navigation and next actions.
- [x] Isolated database and full verification, including production build and browser acceptance.
- [ ] One PR and GitHub CI; report these external results with the final delivery.

## Verification

Isolated PostgreSQL 17 at `127.0.0.1:52978/socialops_m1_apa` only; no personal or shared database was used.

- `pnpm install --frozen-lockfile`: passed.
- `pnpm db:generate`: passed.
- `pnpm db:migrate`: applied 14 existing migrations.
- `pnpm db:seed`: passed twice.
- `prisma migrate status`: up to date.
- `prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-url <isolated database> --exit-code`: no difference.
- Final `pnpm test`: 30 files, 282 tests passed. Earlier static tests bound to the old account selection form source layout were updated to check the actual component and action contract.
- Browser walkthrough: desktop and 390px owner, operator, viewer, populated and empty Accounts/Products/Assets; product create/edit, asset upload/tag/filter/link; no document-level horizontal overflow. Final production-server 390px recheck passed for Accounts, Products, product detail, Assets and asset detail. The product facts table scrolls inside its 320px container (620px table width) without document overflow. Evidence is under the isolated browser runner Temp directory.
- `pnpm typecheck`: passed.
- `pnpm build`: passed, including TypeScript and 53 static route generation checks.
- `git diff --check`: passed; Git emits a line-ending normalization warning for `src/app/products/page.tsx` only.
- GitHub PR and CI pending; they do not modify the code or local verification results.

## Remaining risk

Existing ProductField, ProductAsset and ContentVersionAsset relations lack composite tenant foreign keys. New reads/writes scope related rows to the active client, and legacy product fact consumers were filtered and regression-tested. Remote revoke happens after local disconnect commit by design and cannot be atomic with a later reconnect at the external provider.
