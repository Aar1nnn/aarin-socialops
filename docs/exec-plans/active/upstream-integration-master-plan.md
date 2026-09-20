# Upstream Integration Master Plan

## Status

- Owner: Aarin SocialOps
- Branch: `feat/upstream-platform-foundation-instagram`
- Baseline: `859d7f0`
- Started: 2026-09-21
- Current delivery: Phase 1 Platform Foundation + Phase 2 Instagram
- System of record: Aarin SocialOps

## Objective

Reuse mature upstream platform and product patterns without replacing Aarin's tenant, approval, publishing, reconciliation, or audit controls. Upstream code explains how a provider works; Aarin continues to decide who may publish, which approved `ContentVersion` is eligible, which tenant/account owns the request, and whether a failed dispatch is safe to retry.

## Non-negotiable invariants

- Every data path remains scoped by `clientId`.
- `ContentVersion`, product-fact provenance, approval invalidation, and human `Approval` remain authoritative.
- LIVE and DEMO execution remain isolated.
- The worker performs the existing pre-publish recheck and uses the existing idempotency key.
- Only explicit `PRE_DISPATCH` failures may be automatically retried.
- A timeout, 5xx, or lost connection after dispatch becomes `UNKNOWN`; it is never blindly retried.
- Tokens remain encrypted by `TokenVault`; adapters never persist plaintext credentials.
- `PublishJob`, `PublishAttempt`, `MetricSnapshot`, `Interaction`, `ManualTask`, and `AuditLog` remain Aarin-owned records.
- The externally accepted Facebook adapter remains the native reference adapter and is not rewritten.

## Pinned upstream audit

| Upstream | Pinned commit | License finding | Source-use policy |
| --- | --- | --- | --- |
| Social Media Poster | `33f00657e5babcc27455758aef4b8b2b97d1eba9` | MIT (`LICENSE`) | PORT/ADAPT is permitted with attribution. |
| Postiz | `7cef69c12fd5ab486f97f70452cfd3dd3708de4b` | AGPL-3.0 (`LICENSE`) | Architecture/behavior reference only; do not copy source into Aarin. |
| TryPost | `ae0fa9eb83b2278409f261d25f6cef866150da82` | AGPL-3.0 (`LICENSE.md`) | Product-model and workflow reference only; do not copy source into Aarin. |
| OpenSocial | `2a655db3408961e15572e5ba23caccee5376e12b` | MIT text in `README.md`; no root `LICENSE`/`COPYING`/`NOTICE` found | Treat as an architecture reference until provenance is rechecked before any direct port. |
| BrightBean Studio | `16dd55e8ec9123f5ebf99ba1e470e245dcc07519` | AGPL-3.0 (`LICENSE`) | Architecture/behavior reference only; do not copy source into Aarin. |

The detailed source-area and local-use records live in `docs/upstreams/`.

## Integration map

| Module | Best Upstream | Source Area | Aarin Target | Method |
| --- | --- | --- | --- | --- |
| Instagram | Social Media Poster | `packages/platform-adapters/src/instagram/` | `src/lib/adapters/instagram-graph.ts` | PORT/ADAPT |
| LinkedIn | Social Media Poster | `packages/platform-adapters/src/linkedin/` | future `src/modules/platforms/linkedin/` | PORT |
| TikTok | Social Media Poster | `packages/platform-adapters/src/tiktok/` | future `src/modules/platforms/tiktok/` | PORT |
| YouTube | Social Media Poster | `packages/platform-adapters/src/youtube/` | future `src/modules/platforms/youtube/` | PORT |
| X | Social Media Poster | `packages/platform-adapters/src/x/` | future `src/modules/platforms/x/` | PORT |
| Shared HTTP | Social Media Poster | `packages/platform-adapters/src/http-client.ts` | `src/lib/platforms/http-client.ts` | ADAPT for Aarin retry safety |
| Error Mapping | Social Media Poster + Aarin | Meta error mapping + existing Facebook categories | `src/lib/platforms/errors.ts` | ADAPT |
| Platform Registry | Postiz + Social Media Poster | `integration.manager.ts`, adapter registry/interface | `src/lib/platforms/registry.ts` | CLEAN-ROOM ADAPT |
| Capability Model | Postiz + Aarin | provider metadata/rules + existing capability fields | `src/lib/platforms/capabilities.ts` | CLEAN-ROOM ADAPT |
| Brand | TryPost + OpenSocial | `app/Ai/`, `app/Enums/Workspace/`, `apps/api/src/modules/brands/` | future `src/modules/brand/` | CLEAN-ROOM ADAPT |
| Memory | OpenSocial + Aarin | AI pipeline/brand context + Aarin records | future `src/modules/memory/` | ADAPT |
| AI Pipeline | OpenSocial + TryPost | AI stages/agents | future `src/modules/ai/` | ADAPT |
| Calendar | BrightBean + Postiz + TryPost | calendar/queue/recurrence views and services | future `src/modules/calendar/` | CLEAN-ROOM ADAPT |
| Analytics | BrightBean | `apps/analytics/` | future `src/modules/analytics/` | CLEAN-ROOM ADAPT |
| Notification | BrightBean + Aarin | `apps/notifications/` + Aarin notification records | future `src/modules/notifications/` | CLEAN-ROOM ADAPT |

## Phase 1 — Platform Foundation

### Deliverables

- A central `PlatformRegistry` keyed by provider/platform with auth, publish, status-query, metrics, comments, profile, media rules, content rules, and declared capabilities.
- Shared HTTP execution with timeout and structured response parsing.
- Retry mode is explicit. Mutating provider requests are single-attempt; uncertainty after dispatch is surfaced instead of hidden by an HTTP helper.
- Canonical platform error mapping with explicit `failurePhase`.
- Capability/media/content rules that the connection-selection and publishing layers can consume without adding business-level platform branches.
- Native Facebook registration remains unchanged in behavior.

### Acceptance

- Duplicate platform registration fails.
- Unknown provider/platform resolution fails predictably.
- Read-only requests may retry only configured transient failures.
- Mutating requests never receive hidden automatic retries.
- Tokens and authorization headers never appear in public error messages.

## Phase 2 — Instagram

### Deliverables

- Reuse the existing Meta OAuth state, token exchange, encrypted storage, Page discovery, and linked Instagram professional-account discovery.
- Add Instagram Content Publishing for a selected professional account using remotely reachable image/video URLs.
- Support one image, one video, and carousel container creation with video readiness polling.
- Query a known Instagram media ID for reconciliation and permalink/status confirmation.
- Route the existing publish-job query endpoint through the platform registry so Facebook and Instagram both use the selected adapter's remote-query capability.
- Translate token, permission, rate-limit, content/media, pre-dispatch, and post-dispatch uncertainty into the Aarin `PublishResult` contract.
- Keep account selection tenant-scoped and capability-driven.

### Safety boundaries

- Instagram has no text-only publish path.
- Local-only assets are rejected before dispatch because Meta must fetch a public HTTPS URL. S3-compatible storage must return a signed HTTPS URL.
- Container creation and `media_publish` are mutating calls and are never automatically retried by shared HTTP.
- If a mutating call loses its response or returns an uncertain 5xx result, the job becomes `UNKNOWN`.
- No real Instagram publishing is executed in this delivery. External acceptance remains required.

### Acceptance

- Tenant-isolated account/token resolution.
- Selected Instagram account becomes publish-capable only when the discovered capability contract is satisfied.
- Encrypted token decryption happens only at adapter construction.
- Image/video/carousel happy paths are covered with mocked provider responses.
- Invalid token, missing permission, rate limit, unsupported media, inaccessible media URL, timeout/5xx uncertainty, remote query, disconnect/token cleanup, duplicate scheduling, and `UNKNOWN` safety remain covered by tests.

## Later phases

1. LinkedIn OAuth, text/image publish, and status query.
2. TikTok OAuth, video upload/chunks, polling, and status query.
3. YouTube OAuth, resumable upload, and processing status.
4. Brand Profile and PostgreSQL-backed memory.
5. Staged AI pipeline producing new `ContentVersion` records only.
6. Calendar views and queue/recurrence controls over existing Aarin records.
7. Canonical social analytics with freshness and explicit availability semantics.
8. Webhook/email notifications whose failure cannot roll back core operations.

## Verification checklist

- [x] `pnpm typecheck`
- [x] `pnpm test` — 15 files / 99 tests
- [x] `pnpm build`
- [x] `git diff --check`
- [ ] Working tree clean after commit
- [ ] Push CI passes
- [ ] PR CI passes
- [ ] Independent PR remains unmerged
