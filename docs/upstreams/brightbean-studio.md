# BrightBean Studio upstream review

- Original: https://github.com/brightbeanxyz/brightbean-studio
- Reviewed commit: `16dd55e8ec9123f5ebf99ba1e470e245dcc07519`
- License: GNU AGPL-3.0 (`LICENSE` in the reviewed checkout)
- Last audited/synced: 2026-09-21

## Audited source areas

- `apps/analytics/`: metrics, freshness, derivation, services, tasks, quota, and snapshot migrations.
- `apps/calendar/`: queue, recurrence, bulk-action, security, and operator calendar behavior.
- `apps/social_accounts/`: provider factory, OAuth, status, missing-scope, and quota handling.
- `apps/publisher/`: publish confirmation, media, and failure behavior.
- `apps/notifications/`: delivery engine, retry caps, batching, and unsubscribe behavior.

## Ideas and Aarin landing points

- Calendar remains an operational layer over Aarin content and scheduling records.
- Canonical metric normalization, period aggregation, and freshness remain backed by `MetricSnapshot` and `AnalyticsSyncState`.
- Account and publishing behavior informs Aarin's provider registry without replacing its adapter or safety contracts.
- Notification outcomes use `NotificationDelivery`; delivery failure does not roll back the originating business event.

## License boundary

Architecture and workflow reference only. No BrightBean Python/Django source, templates, tasks, or models were copied. Aarin uses clean-room TypeScript over its existing domain models and remains the only system of record.
