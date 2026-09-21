# Postiz upstream review

- Original: https://github.com/gitroomhq/postiz-app
- Reviewed: 2026-09-21
- Default branch: `main`
- Reviewed commit: `ce6a7d28151634d953524992b211067b04a75566`
- License: GNU AGPL-3.0 (`LICENSE`)
- Classification: **architecture-only**, as required; no source was copied or ported.

## Reviewed areas

- `apps/frontend/src/components/launches/calendar.tsx`
- `apps/frontend/src/components/analytics/`
- `apps/frontend/src/components/notifications/`
- `apps/backend/src/api/routes/analytics.controller.ts`
- `apps/backend/src/api/routes/notifications.controller.ts`
- `libraries/nestjs-libraries/src/database/prisma/notifications/`

## Ideas retained

- Use calendar/list navigation and account/platform filters as an operator projection.
- Keep analytics and notifications scoped to the current organization/tenant at the controller boundary.
- Keep AI and scheduling capabilities embedded in content operations rather than creating many top-level AI tools.

## Aarin landing points

- New Aarin pages use its existing server components, services, CSS, and tenant context.
- No Postiz components, drag/drop code, service/repository code, styling, or provider logic is used.
