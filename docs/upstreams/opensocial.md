# OpenSocial upstream review

- Original: https://github.com/0xdileep/opensocial
- Reviewed: 2026-09-21
- Default branch: `master`
- Reviewed commit: `2a655db3408961e15572e5ba23caccee5376e12b`
- License: MIT text is included in `README.md`; GitHub license metadata is unset and no standalone license file was found.
- Classification: **Adapt** of architectural boundaries, independently implemented; no source was directly ported.

## Reviewed areas

- `apps/api/src/ai/pipeline/content.pipeline.ts`
- `apps/api/src/ai/stages/generate.strategy.ts`
- `apps/api/src/ai/stages/critique.rewrite.ts`
- `apps/api/src/ai/ai.schemas.ts`
- `apps/api/src/modules/brands/brand.service.ts`
- `apps/api/src/modules/brands/brand.routes.ts`

## Ideas retained

- Build a tenant-scoped brand/recent-content context before generation.
- Separate strategy, generation, critique, and rewrite stages.
- Parse structured model output and persist a draft only after validation.

## Aarin landing points

- Aarin uses its existing `Client` tenant boundary rather than importing OpenSocial workspaces.
- Context additionally includes confirmed product facts, performance memory, and research memory.
- Output persists to the existing `ContentVersion`; the pipeline cannot schedule or publish.

No OpenSocial database SQL, route code, prompts, or provider integrations are copied.
