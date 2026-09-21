# BrightBean Studio upstream review

- Original: https://github.com/brightbeanxyz/brightbean-studio
- Reviewed: 2026-09-21
- Default branch: `main`
- Reviewed commit: `16dd55e8ec9123f5ebf99ba1e470e245dcc07519`
- License: GNU AGPL-3.0 (`LICENSE`)
- Classification: **architecture-only**; no source was copied or ported.

## Reviewed areas

- `apps/calendar/models.py` and `apps/calendar/services.py`
- `apps/analytics/metrics.py`, `freshness.py`, and `services.py`
- `apps/notifications/models.py`, `engine.py`, and `tasks.py`
- Related security, bulk-action, retry, and failure-notification tests in those apps.

## Ideas retained

- Calendar is a projection and mutation service over the publisher's source of truth.
- Scheduling mutations must be serialized/validated in a service, not written directly by UI code.
- Analytics needs a canonical catalog, explicit availability, period comparison, and independent freshness.
- Notification delivery state must not make the originating business transaction fail.

## Aarin landing points

- Calendar directly reads and moves existing `ContentItem`/`PublishJob` timestamps.
- Analytics aggregates existing `MetricSnapshot` rows and preserves Aarin's availability and REAL/MOCK fields.
- Notifications reuse `NotificationChannel` and `InAppNotification` with best-effort webhook/email adapters.

No Django models, scheduling algorithms, analytics functions, templates, or notification engine code is copied.
