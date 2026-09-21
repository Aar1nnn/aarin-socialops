# TryPost upstream review

- Original: https://github.com/trypostit/trypost
- Reviewed commit: `ae0fa9eb83b2278409f261d25f6cef866150da82`
- License: AGPL-3.0 (`LICENSE.md` in the reviewed checkout)
- Review scope: `app/Ai/`, `app/Ai/Agents/`, `app/Actions/Ai/`, `app/Enums/Workspace/`

## Ideas adopted

- A structured brand profile with voice traits, content language, and image style.
- Separate content generation, reviewer, humanizer, and shortener responsibilities.
- Structured stage outputs and explicit platform length budgets.
- Brand context is supplied to generation rather than inferred from arbitrary source text.

## Aarin landing points

- `BrandProfile` and the brand service.
- Brand/content memory context builders.
- The staged AI content pipeline integrated into the existing content service.

## Reuse status

Architecture and behavior reference only. No TryPost source code, prompts, enums, or UI were copied. Aarin uses a clean-room TypeScript implementation compatible with its existing Prisma schema, adapters, usage accounting, approvals, and tenant isolation.
