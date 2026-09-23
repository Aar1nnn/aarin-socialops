# Postiz upstream review

- Original: https://github.com/gitroomhq/postiz-app
- Reviewed commit: `7cef69c12fd5ab486f97f70452cfd3dd3708de4b`
- License: GNU AGPL-3.0 (`LICENSE` in the reviewed checkout)
- Last audited/synced: 2026-09-21

## Audited source areas

- Integration manager, social adapter abstraction, provider interfaces, refresh service, and missing-scope handling.
- Scheduling/calendar and analytics information architecture.
- Provider capability presentation and content-operations navigation.

## Ideas and Aarin landing points

- Central provider registry and explicit provider capabilities in `src/lib/platforms/registry.ts` and `src/lib/platforms/capabilities.ts`.
- Calendar-oriented content operations and compact scheduling filters.
- Comparable analytics views organized by account, platform, and period.
- Capability-aware behavior that never presents an unsupported provider operation as available.

## License boundary

Architecture, behavior, and UX reference only. No Postiz source or design assets were copied. Aarin's registry is a clean-room TypeScript implementation, and Postiz is not introduced as a runtime service or second system of record.
