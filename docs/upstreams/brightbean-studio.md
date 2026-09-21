# BrightBean Studio upstream review

- Original: https://github.com/brightbeanxyz/brightbean-studio
- Reviewed commit: `16dd55e8ec9123f5ebf99ba1e470e245dcc07519`
- License: AGPL-3.0 (`LICENSE` in the reviewed checkout)
- Review scope: `apps/calendar/`, `apps/analytics/`, `apps/notifications/`, `apps/social_accounts/`, `apps/publisher/`

## Ideas adopted

- Calendar as an operational read/write layer over authoritative content and scheduling records.
- Metric normalization, period aggregation, and visible data freshness.
- Notification delivery outcomes separated from the business event that triggered them.
- Delivery failures recorded per channel without rolling back the core workflow.

## Aarin landing points

- Calendar service and month/week/list operator view over existing Aarin records.
- Analytics aggregation and `AnalyticsSyncState` over `MetricSnapshot`.
- `NotificationDelivery` and best-effort external dispatch over existing notification models.

## Reuse status

Architecture and workflow reference only. No BrightBean Studio source, templates, tasks, or models were copied. The implementation uses Aarin's existing domain and a clean-room service design.
