# TryPost upstream review

- Original: https://github.com/trypostit/trypost
- Reviewed commit: `ae0fa9eb83b2278409f261d25f6cef866150da82`
- License: GNU AGPL-3.0 (`LICENSE.md` in the reviewed checkout)
- Last audited/synced: 2026-09-21

## Audited source areas

- Brand analyzer and content generation, review, humanization, shortening, and image-regeneration agents.
- AI and workspace actions.
- Brand voice trait, content language, image style, and persona enums.

## Ideas and Aarin landing points

- Structured Brand Profile with voice traits, languages, image style, and audience context.
- Separate generation, review, rewrite/humanize, and shortening responsibilities represented as composition actions rather than independent systems.
- Structured stage outputs and explicit platform length budgets.
- Brand, product, and memory context supplied to generation instead of inferred from arbitrary text.
- Aarin persists only through its existing `BrandProfile`, content, approval, adapter, usage, and tenant models.

## License boundary

Architecture and behavior reference only. No TryPost PHP/Laravel source, prompts, enums, or UI were copied. Aarin uses a clean-room TypeScript implementation and remains the sole system of record.
