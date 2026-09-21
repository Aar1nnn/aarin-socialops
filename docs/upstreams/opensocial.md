# OpenSocial upstream review

- Original: https://github.com/0xdileep/opensocial
- Reviewed commit: `2a655db3408961e15572e5ba23caccee5376e12b`
- License: not sufficiently established from a root license file in the reviewed checkout; repository text references licensing but is not treated as permission to copy.
- Review scope: `apps/api/src/ai/`, `apps/api/src/ai/pipeline/`, `apps/api/src/ai/stages/`, `apps/api/src/modules/brands/`

## Ideas adopted

- An explicit AI pipeline instead of a single opaque generation step.
- Strategy generation followed by critique and rewrite.
- Brand service and recent-content memory as reusable context providers.
- Image prompt/review as an interface boundary that can remain unimplemented.

## Aarin landing points

- `ai-content-pipeline-service.ts` stage contracts.
- `memory-service.ts` recent-content and performance context.
- Existing `ContentVersion` remains the only generated-content record.

## Reuse status

Architecture-only reference. No OpenSocial code, prompt text, or schema was copied because license provenance was not clear enough for direct adaptation.
