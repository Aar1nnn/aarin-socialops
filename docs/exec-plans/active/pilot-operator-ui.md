# Aarin SocialOps v0.4 — Pilot Operator Experience

## Status

- Phase: implementation
- Branch: `feat/pilot-operator-ui`
- Baseline: `v0.3-meta-facebook-verified` / `main` at `859d7f0`
- Working objective: redesign the operator-facing UI without changing core business behavior
- Baseline verification target: preserve all existing tests (83 tests before this work)

## Goal

Turn the existing engineering-oriented interface into a restrained, trustworthy B2B social-operations workspace suitable for pilot operators, customers, and partners. The product brand is **Aarin SocialOps** and the primary product framing is **Social Operations Workspace**.

The redesign must improve information architecture, hierarchy, density, status language, form clarity, responsive behavior, and accessibility while preserving every existing backend contract and verified Meta workflow.

## Current issues

### Product identity and navigation

- The shell still presents the product as “海外社媒 AI 运营工作台”, which overstates AI as the product identity.
- Navigation labels are function descriptions rather than a stable workspace information architecture.
- The current route is not indicated visually and navigation links do not expose `aria-current`.
- Workspace context, runtime mode, membership switching, user role, and logout are visually disconnected.
- At widths below 900px, six navigation items are forced into a five-column grid, creating a cramped second row.

### Visual system

- The existing warm beige, deep green, orange, large-radius card system reads as a demo template rather than operational software.
- Most sections use elevated cards, including information that should be represented as tables, lists, dividers, and quiet panels.
- Global button and form rules make every action equally prominent and every field full-width.
- Colors, radii, spacing, focus behavior, and control sizes are hard-coded rather than expressed as semantic tokens.
- Secondary text contrast is marginal and focus treatment is inconsistent.

### Login and security presentation

- Development email and password values are rendered into the login form, including a default password in the browser DOM.
- Login copy exposes implementation details such as cookie and membership mechanics.
- Inputs lack explicit autocomplete guidance and the page has no consistent error/notice region.

### Overview

- Large metric cards dominate the page without clearly prioritizing today’s operational work.
- Attention items, connection health, publishing activity, leads, and manual tasks are presented as separate large blocks rather than an operational hierarchy.
- Raw workflow and provider states leak into primary UI.
- Action-heavy reconciliation forms occupy the dashboard instead of appearing as focused disclosures.

### Content operations

- Creation, editing, approval, rejection, scheduling, and publishing history are all expanded together.
- Content items are large nested cards rather than structured rows with progressive disclosure.
- Approval and publish state are not presented as a coherent workflow.
- `UNKNOWN` is shown as a technical failure instead of the intentional duplicate-publish safety state it represents.
- Account selection uses oversized checkbox blocks.

### Connections

- Provider IDs, raw scopes, capability enums, token metadata, and other technical data dominate the page.
- Refresh and destructive disconnect actions have similar visual weight.
- Provider capabilities are not translated into operator language.
- The destructive effect of disconnecting is not explained in business terms.

### Products and assets

- Product creation, editing, fact confirmation, asset upload, and the asset library compete on the same surface.
- Product facts are not presented as structured fact/source/status data.
- Asset presentation exposes implementation metadata before useful media context.

### Leads and data

- Leads, interactions, metrics, reports, manual import, and synchronization actions are mixed together without section navigation.
- Lead priority/status, metric availability, and data kind expose storage enums.
- Interactions are as visually heavy as qualified leads.
- Report facts are presented as technical JSON instead of layered summaries and advanced details.

### Settings

- A long, flat form combines workspace identity, market context, runtime mode, usage, providers, notifications, and legacy configuration.
- Runtime mode is a high-risk setting but is presented as an ordinary select.
- Legacy Facebook fallback configuration occupies primary settings space.

## Design direction

- Style: quiet enterprise, editorial, operational, precise, dense but breathable.
- Base background: cold gray; primary surfaces: white; sidebar: charcoal.
- Typography: system UI stack with `Noto Sans SC` / `Microsoft YaHei` fallbacks; compact 12–30px scale and tabular numeric data.
- Borders and elevation: 1px borders, 6/8/10px radii, no default panel shadow; shadow reserved for floating layers.
- Color: restrained dark/blue action color; low-saturation semantic success, warning, danger, and info colors.
- Hierarchy: page headers, section headers, tables, structured lists, and disclosure panels instead of card grids.
- Status: dot plus readable label for operational state; compact chips only for classification.
- Motion: limited to short hover/focus/disclosure transitions; no page entrance, glow, gradient, spring, or decorative animation.
- Copy: short, business-readable Chinese; platform names and the Aarin SocialOps brand remain English.

## Information architecture

1. 总览 (`/`)
2. 内容 (`/content`)
3. 产品 (`/products`)
4. 线索与数据 (`/insights`)
5. 平台连接 (`/connections`)
6. 设置 (`/settings`)

The sidebar will expose the active workspace and mode as context, not as a large badge. Workspace switching remains a real POST operation using the existing membership IDs. User role and logout remain in the sidebar footer.

## Reusable components

Keep the component set deliberately small:

- `Button`: primary, secondary, ghost, danger; small and medium sizes.
- `StatusIndicator`: semantic tone plus localized operational label.
- `PageHeader`: title, short description, optional action.
- `SectionHeader`: section title, optional description/action.
- `EmptyState`: concise text and optional next action; no illustration.
- `Notice`: info, warning, danger, success; technical detail remains secondary.
- `FormField`: explicit label/control/helper relationship.
- `DataTable` presentation classes/primitives: semantic table retained with scroll containment.
- `PrimaryNav`: small client boundary for pathname-aware active state; the shell remains server-rendered.
- Presentation helpers under `src/lib/presentation/` for enum labels, tones, platform names, modes, and date/time formatting.

## Page plan

### Shell and login

- Rebrand to Aarin SocialOps.
- Add a semantic skip link, labeled navigation, active route, stable focus rings, workspace selector, user role, and logout footer.
- Use a compact horizontal navigation treatment below 900px without a fixed column count.
- Remove credentials from the login DOM, keep `/api/auth/login`, `email`, and `password` unchanged, and add correct autocomplete attributes.

### Overview

- One operational summary band for review, scheduling, leads, and attention counts.
- Needs-attention list ordered by severity.
- Compact connection health panel.
- Recent publishing activity table.
- Recent leads table.
- Manual tasks and `UNKNOWN` reconciliation remain available through focused disclosure panels.

### Content

- Page-level “创建内容” disclosure/composer instead of a permanently dominant form.
- Compact status navigation with real counts.
- Structured content table/rows with a one-line preview and progressive detail.
- Content detail grouped into copy, product facts/assets, approval, schedule, and publish history.
- Approval actions appear only where applicable.
- `UNKNOWN` receives dedicated operator copy, query action, and secondary manual reconciliation disclosure.

### Connections

- Provider and account readiness expressed as publishing/metrics/comments availability.
- Technical IDs, raw scopes, metadata, and token details move into an advanced disclosure.
- Account selection remains connected to the existing POST action and real account IDs.
- Refresh is a normal management action; disconnect moves to a clearly described danger zone.

### Products

- Product list with fact completeness, asset count, and update context.
- Creation in a dedicated disclosure/panel.
- Product details group overview, facts, and assets.
- Existing fact confirmation/source fields and upload/edit actions are preserved.

### Leads & Data

- Section navigation for leads, interactions, metrics, and reports.
- Leads receive the strongest hierarchy with localized intent, priority, and state.
- Interactions use a lighter activity-feed presentation.
- Metrics use a readable table with clear real/simulated and availability language.
- Reports expose summary and limitations first; raw facts remain in advanced details.

### Settings

- Organize into Workspace, Markets & Brand, Runtime, Usage, Integrations, Notifications, and Advanced.
- Treat runtime mode as a risk-aware setting without changing its existing API behavior.
- Move V1 Facebook fallback into an explicitly labeled legacy advanced disclosure.

## Protected contracts

The following are immutable for this work:

- Prisma schema and migrations.
- Meta OAuth core, `PlatformConnection`, `OAuthState`, and `TokenVault` semantics.
- `FacebookGraphAdapter` publishing behavior.
- `PublishJob`, `PublishAttempt`, retry, `UNKNOWN`, worker claim, and heartbeat behavior.
- Approval rules and `ContentVersion` semantics.
- Product `dataVersion` invalidation.
- Tenant isolation, authentication cryptography, cookies, and session behavior.
- Lead classification, interaction deduplication, and S3 implementation.
- Existing route paths, HTTP methods, form action URLs, and hidden identifiers including `clientId`, `accountId`, `publishJobId`, `contentItemId`, and `connectionId`.
- Real Meta OAuth, discovery, publishing, remote-query, metrics, comments, leads, and disconnect behavior verified in v0.3.

No production dependency will be added unless an unavoidable need is demonstrated. No fake operational data will be introduced.

## Acceptance criteria

- Brand is Aarin SocialOps; navigation matches the new information architecture.
- No gradient, glassmorphism, glow, oversized hero, excessive card, or obvious AI-assistant aesthetic.
- Primary UI contains no raw database enums or low-level provider codes.
- Overview communicates current work and risk within five seconds.
- Content is workflow-oriented and keeps creation/edit/review/scheduling progressively disclosed.
- `UNKNOWN` clearly explains duplicate-publish protection and preserves query/reconciliation actions.
- Connections are business-readable; technical data is secondary and disconnect is isolated.
- Products/assets, leads/interactions/metrics/reports, and settings are structurally distinct and usable.
- Existing real data is used throughout; zero-data states are intentional and useful.
- Desktop targets 1366×768, 1440×900, and 1920×1080; below 900px has no clipped forms, overlapping controls, or fixed five-column navigation.
- Keyboard focus is visible, current navigation is programmatically exposed, labels remain associated, tables remain semantic, and status is not color-only.
- Existing backend behavior remains unchanged.
- `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check` pass.
- GitHub Actions passes on `feat/pilot-operator-ui`; a PR is created and remains unmerged for human visual review.

## Progress

- [x] Confirm clean `main` baseline and create `feat/pilot-operator-ui`.
- [x] Audit shell, global styling, login, and all primary workspace pages.
- [x] Record design direction, IA, constraints, and acceptance criteria.
- [ ] Establish design tokens, reusable primitives, shell, responsive navigation, and login.
- [ ] Redesign Overview.
- [ ] Redesign Content operations.
- [ ] Redesign Connections.
- [ ] Redesign Products and assets.
- [ ] Redesign Leads & Data.
- [ ] Reorganize Settings.
- [ ] Verify responsive behavior, accessibility, and operator copy.
- [ ] Run the complete test/typecheck/build/diff verification set.
- [ ] Commit, push, wait for CI, and create an unmerged PR.

## Known risks and controls

- The shell must remain a Server Component because it reads the database; pathname-aware navigation will be isolated in a small Client Component.
- The workspace selector must continue to submit a real membership-scoped `clientId`; it must never become local-only UI state.
- Global CSS classes are shared across all pages, so compatibility styles will remain until every page has migrated.
- Removing visible development credentials may affect local convenience, but it must not change the login API or authentication behavior.
- Page-level query changes are avoided unless required to display already-supported real records; any such change must remain presentation-scoped and tested.

## Next step

Implement the global token system, compact UI primitives, server-safe operator shell, responsive primary navigation, and production-appropriate login page; then run an early typecheck before proceeding to page redesigns.
