# Postiz upstream record

- Original GitHub URL: https://github.com/gitroomhq/postiz-app
- Pinned commit SHA: `7cef69c12fd5ab486f97f70452cfd3dd3708de4b`
- License: GNU AGPL-3.0, from root `LICENSE`
- Last audited/synced: 2026-09-21

## Audited source areas

- `libraries/nestjs-libraries/src/integrations/integration.manager.ts`
- `libraries/nestjs-libraries/src/integrations/social.abstract.ts`
- `libraries/nestjs-libraries/src/integrations/social/social.integrations.interface.ts`
- `libraries/nestjs-libraries/src/integrations/social/`
- `libraries/nestjs-libraries/src/integrations/refresh.integration.service.ts`
- `libraries/nestjs-libraries/src/integrations/integration.missing.scopes.ts`

## Aarin use

- Architecture/behavior reference for a central provider registry, provider visibility, capability/rule metadata, reconnect/migration concepts, and custom provider fields.
- Aarin target: `src/lib/platforms/registry.ts` and `src/lib/platforms/capabilities.ts`.

## License boundary and local modifications

- No Postiz source is copied into Aarin.
- The registry is a clean-room TypeScript implementation using Aarin's existing adapter interfaces and business safety contracts.
- Future provider migration/reconnect work must preserve Aarin account identity, jobs, approvals, and tenant scope.
