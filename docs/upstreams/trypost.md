# TryPost upstream record

- Original GitHub URL: https://github.com/trypostit/trypost
- Pinned commit SHA: `ae0fa9eb83b2278409f261d25f6cef866150da82`
- License: GNU AGPL-3.0, from root `LICENSE.md`
- Last audited/synced: 2026-09-21

## Audited source areas

- `app/Ai/Agents/BrandAnalyzer.php`
- `app/Ai/Agents/PostContentGenerator.php`
- `app/Ai/Agents/PostContentReviewer.php`
- `app/Ai/Agents/PostContentHumanizer.php`
- `app/Ai/Agents/PostContentShortener.php`
- `app/Ai/Agents/PostImageRegenerator.php`
- `app/Actions/Ai/`
- `app/Actions/Workspace/`
- `app/Enums/Workspace/BrandVoiceTrait.php`
- `app/Enums/Workspace/ContentLanguage.php`
- `app/Enums/Workspace/ImageStyle.php`
- `app/Enums/User/Persona.php`

## Aarin use

- Future product/behavior reference for structured Brand Profile, persona, language/image-style choices, and separated AI generation/review/rewrite/humanize stages.
- Future Aarin targets: `src/modules/brand/` and `src/modules/ai/`.

## License boundary and local modifications

- No TryPost PHP/Laravel source is copied into Aarin.
- Future implementation will be a clean-room TypeScript design backed by Aarin `Client`, products/facts, `PromptVersion`, `ContentVersion`, `Approval`, and usage records.
