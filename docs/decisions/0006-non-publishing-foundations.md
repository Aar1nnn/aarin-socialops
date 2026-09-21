# 0006 — Non-publishing foundations reuse Aarin Core

## Status

Accepted for the independent non-publishing modules PR.

## Context

Aarin needs Brand, Memory, AI authoring, Calendar, Social Analytics, and Notifications while PR #4 independently changes platform/publishing internals. Duplicating workspace, post, schedule, metrics, research, or notification storage would split the System of Record and make later reconciliation unsafe.

## Decision

1. `Client` remains the tenant/workspace boundary. `BrandProfile` is one-to-one with `Client`; the legacy `brandGuidelines` value remains readable as fallback.
2. Memory is a typed read layer over `BrandProfile`, `ContentItem`/`ContentVersion`, `MetricSnapshot`, and `ResearchRecord`. No vector store or memory table is introduced.
3. The AI pipeline is staged and schema-validated, but its only content-side write is a new current `ContentVersion` plus an advisory `AiContentReview`. It cannot create an `Approval` or `PublishJob`.
4. Calendar is an operational projection. It moves only an already scheduled, currently approved version and its existing active job in one service transaction.
5. Social analytics extends `MetricSnapshot` with an optional `contentItemId` link. Availability and REAL/MOCK provenance are first-class; freshness is computed, not guessed from a missing numeric value.
6. Notification events persist to `InAppNotification` before external delivery. Webhook and email-gateway failures are caught per channel and written to `NotificationChannel.lastError`.
7. TryPost, BrightBean Studio, and Postiz are AGPL architecture/UX references only. OpenSocial's service boundaries are adapted independently under the MIT notice in its README. No upstream source is copied.

## Consequences

- PR #4 can continue changing publisher/provider code without this branch importing those changes.
- PR #3 will need a small navigation/design reconciliation when both branches are integrated.
- Existing metric producers may gradually populate `contentItemId`; account-level snapshots remain valid with it null.
- Direct SMTP/provider-specific email and automatic publisher-event wiring remain follow-up work, because this PR deliberately does not modify the publishing worker.
