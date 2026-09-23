# OpenSocial upstream record

- Original GitHub URL: https://github.com/0xdileep/opensocial
- Pinned commit SHA: `2a655db3408961e15572e5ba23caccee5376e12b`
- License: MIT text is embedded in `README.md`; no root `LICENSE`, `COPYING`, or `NOTICE` file was present at the pinned commit
- Last audited/synced: 2026-09-21

## Audited source areas

- `apps/api/src/ai/pipeline/content.pipeline.ts`
- `apps/api/src/ai/stages/generate.strategy.ts`
- `apps/api/src/ai/stages/critique.rewrite.ts`
- `apps/api/src/ai/stages/image.prompt.ts`
- `apps/api/src/ai/stages/image.generate.ts`
- `apps/api/src/ai/stages/image.review.ts`
- `apps/api/src/modules/brands/`

## Aarin use

- Future architecture reference for staged AI content generation, critique/rewrite, image prompt/generation/review, brand context, and recent-content memory.
- Future Aarin targets: `src/modules/brand/`, `src/modules/memory/`, and `src/modules/ai/`.

## Provenance boundary and local modifications

- This delivery does not copy OpenSocial source.
- Before a future direct port, reconfirm repository license provenance or obtain a standalone license record.
- Future implementation must write through Aarin `ContentVersion` and human `Approval`; it cannot publish directly.
