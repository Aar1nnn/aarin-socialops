# BrightBean Studio upstream record

- Original GitHub URL: https://github.com/brightbeanxyz/brightbean-studio
- Pinned commit SHA: `16dd55e8ec9123f5ebf99ba1e470e245dcc07519`
- License: GNU AGPL-3.0, from root `LICENSE`
- Last audited/synced: 2026-09-21

## Audited source areas

- `apps/analytics/` including `metrics.py`, `freshness.py`, `derive.py`, services, tasks, quota and snapshot migrations
- `apps/calendar/` including queue, recurrence, bulk-action and security tests
- `apps/social_accounts/` including provider factory, OAuth, status, missing-scope and quota handling
- `apps/publisher/` including publish confirmation and media/failure tests
- `apps/notifications/` including delivery engine, retry caps, batching and unsubscribe behavior

## Aarin use

- Future behavior reference for canonical metric mapping, freshness/sync state, calendar views and queues, account operations, publishing confirmation, and best-effort external notifications.
- Future Aarin targets: `src/modules/analytics/`, `src/modules/calendar/`, `src/modules/notifications/`, plus existing account/publishing services.

## License boundary and local modifications

- No BrightBean Python/Django source is copied into Aarin.
- Future features will be clean-room TypeScript implementations over Aarin `MetricSnapshot`, `DataAvailability`, `DataKind`, content/scheduling records, `InAppNotification`, `NotificationChannel`, and `ManualTask`.
