# OpenSocial upstream review

- Original: https://github.com/0xdileep/opensocial
- Reviewed commit: `2a655db3408961e15572e5ba23caccee5376e12b`
- License provenance: MIT text appears in `README.md`, but no root `LICENSE`, `COPYING`, or `NOTICE` existed at the reviewed commit; this is not treated as permission to copy.
- Last audited/synced: 2026-09-21

## Audited source areas

- `apps/api/src/ai/pipeline/content.pipeline.ts`
- `apps/api/src/ai/stages/`: strategy, critique/rewrite, and image prompt/generation/review boundaries.
- `apps/api/src/modules/brands/`

## Ideas and Aarin landing points

- Explicit staged content generation instead of an opaque one-shot generation call.
- Strategy followed by critique and rewrite.
- Brand and recent-content memory supplied through reusable context providers.
- Image prompt/review retained as a boundary that may remain unimplemented.
- Aarin implementations live in its brand, memory, and AI services and only persist through `ContentVersion` plus human `Approval`.

## Provenance boundary

Architecture-only reference. No OpenSocial source, prompts, or schema were copied. Direct adaptation remains prohibited unless license provenance is independently established.
