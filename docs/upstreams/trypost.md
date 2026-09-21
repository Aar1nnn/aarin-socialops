# TryPost upstream review

- Original: https://github.com/trypostit/trypost
- Reviewed: 2026-09-21
- Default branch: `main`
- Reviewed commit: `ae0fa9eb83b2278409f261d25f6cef866150da82`
- License: GNU AGPL-3.0 (`LICENSE.md`)
- Classification: **architecture-only**; no source was copied or ported.

## Reviewed areas

- `app/Ai/Agents/BrandAnalyzer.php`
- `app/Ai/Agents/PostContentGenerator.php`
- `app/Ai/Agents/PostContentReviewer.php`
- `app/Ai/Agents/PostContentHumanizer.php`
- `app/Ai/Agents/PostContentShortener.php`
- `app/Actions/Ai/AutofillBrand.php`
- `app/Enums/Workspace/`
- `app/Models/Workspace.php`

## Ideas retained

- Keep brand attributes structured and available to every AI stage.
- Give generation, review, humanization, and shortening separate contracts.
- Validate generated output structurally and carry platform length constraints through later rewrite stages.

## Aarin landing points

- `BrandProfile` holds business positioning, audience, voice, language, image, phrase, mention, and CTA rules.
- `ai-content-contracts.ts` defines independent Zod contracts for the staged pipeline.
- `ai-content-service.ts` treats AI review as advisory metadata, never `Approval`.

No TryPost PHP, prompt text, schemas, enum values, or UI code is copied into Aarin.
