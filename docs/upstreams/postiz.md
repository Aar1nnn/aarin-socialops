# Postiz upstream review

- Original: https://github.com/gitroomhq/postiz-app
- Reviewed commit: `7cef69c12fd5ab486f97f70452cfd3dd3708de4b`
- License: AGPL-3.0 (`LICENSE` in the reviewed checkout)
- Review scope: scheduling/calendar UI, analytics UI, provider capability and content-operations navigation.

## Ideas adopted

- Calendar-oriented content operations and compact scheduling filters.
- Analytics views organized around account/platform and comparable time periods.
- Capability-aware UI that does not pretend unsupported provider functions are available.

## Aarin landing points

- Operator navigation and calendar/analytics information architecture.
- Existing Aarin provider capability records remain authoritative.

## Reuse status

UX and information-architecture reference only. No Postiz code or design assets were copied into Aarin. Postiz is not introduced as a runtime service or a second system of record.
