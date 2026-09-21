# Aarin SocialOps UI Information Architecture V2

## Status

- Phase: architecture and UX planning only
- Date: 2026-09-22
- Working branch audited: `feat/brand-memory-ai-calendar-analytics`
- Working branch head: `c6d5df295a55cb43480872c8faee18d319e9cc1c`
- Baseline `main`: `859d7f05dc635800cde448fb2de17cfbf3cc57d0`
- Delivery in this phase: this document only
- Implementation status: not started
- Human review required before UI Phase 1

## Goal

Turn Aarin SocialOps from a collection of backend-shaped pages into a durable Social Operations Workspace organized around the operator's daily work:

1. prepare brand, product facts, and assets;
2. plan and create content;
3. review, schedule, publish, and reconcile results;
4. manage accounts, interactions, leads, and operational exceptions;
5. inspect trustworthy performance data and decide what to do next.

The UI must expose the existing Aarin domain clearly without creating a second content, scheduling, publishing, analytics, tenant, or approval system.

## Scope and non-goals

### In scope

- Current UI/UX audit.
- Final information architecture and route proposal.
- Core user flows.
- Page specifications.
- Component architecture.
- Backend-to-UI mapping.
- ASCII wireframes.
- Migration plan for `main`, PR #3, PR #4, and PR #5.
- Implementation phases, acceptance gates, risks, and open decisions.

### Explicitly out of scope

- No page rewrite in this phase.
- No API change.
- No Prisma schema or migration change.
- No worker, adapter, OAuth, retry, reconciliation, AI pipeline, or analytics rewrite.
- No dependency change.
- No real social publishing or external provider action.
- No design image generation.

## Evidence baseline

### Repository and pull requests

| Source | Head | State at audit | Relevant scope |
| --- | --- | --- | --- |
| `main` | `859d7f0` | baseline | V2 connection layer and externally accepted Facebook Page flow |
| PR #3 | `5876d84` | OPEN, MERGEABLE, CI PASS | quiet enterprise UI, navigation, page hierarchy, shared presentation primitives |
| PR #4 | `ede1e53` | OPEN, MERGEABLE, CI PASS | platform registry/capabilities, Instagram adapter, generalized publish query |
| PR #5 | `c6d5df2` | OPEN, MERGEABLE, CI PASS | brand/memory/AI/calendar/analytics/notifications; includes PR #3 history through merge commit |

PR #5 currently contains the complete PR #3 head. PR #4 remains independent and intentionally has almost no page-level UI changes. UI V2 implementation must begin only after the accepted combination of these branches is present on `main`.

### Existing source-of-truth entities

The following remain authoritative and must not be duplicated:

- Workspace and access: `Client`, `ClientMembership`, `User`, `Session`.
- Brand and knowledge: `BrandProfile`, `ResearchRecord`.
- Product and assets: `Product`, `ProductField`, `Asset`, `ProductAsset`.
- Content: `ContentPlan`, `ContentItem`, `ContentVersion`, `ContentVersionAsset`, `PromptVersion`.
- Approval and publishing: `Approval`, `PublishJob`, `PublishAttempt`.
- Platform access: `PlatformConnection`, `SocialAccount`, `PlatformPolicy`; PR #4 adds the code-level platform registry and capability definitions.
- Measurement and engagement: `MetricSnapshot`, `AnalyticsSyncState`, `Interaction`, `Lead`, `ManualTask`, `OperationReport`.
- Notifications and governance: `NotificationChannel`, `InAppNotification`, `NotificationDelivery`, `AuditLog`, `UsageLog`, `UsageReservation`.

---

# 1. Current UI Audit

## 1.1 Current routes

| Route | Current responsibility | Primary data/services | Main problem |
| --- | --- | --- | --- |
| `/` | attention, connection health, recent publishing, leads, notifications, manual reconciliation | direct Prisma queries across `ContentItem`, `PublishJob`, `ManualTask`, `InAppNotification`, `SocialAccount`, `PlatformConnection`, `Lead` | Good operational direction, but publishing/account actions are mixed into Dashboard because dedicated control centers do not exist. |
| `/content` | create, edit, submit, approve/reject, schedule, inspect publish history, remote-query link | `content-service`, direct Prisma content/product/account queries | One 493-line list page contains content center, composer, approval, scheduling, and publishing details. |
| `/calendar` | month/week/list filtering and drag/drop reschedule | `calendar-service`, `ContentItem`, `Approval`, `PublishJob`, `SocialAccount` | Correct data boundary, but visual/status treatment is foundation-level and there is no focused detail pattern. |
| `/products` | product creation, product facts, uploads, product assets, global asset list | `product-service`, direct Prisma queries | The domain grouping is correct, but product details and the asset library are expanded in one long page. |
| `/brand` | brand profile edit and memory counts | `brand-service`, `memory-service` | Brand, audience, rules, memory, and research are compressed into one form plus three counters; operators cannot inspect what the system remembers. |
| `/analytics` | period comparison, freshness, canonical metric table, deterministic review | `analytics-service`, `MetricSnapshot`, `AnalyticsSyncState` | Strong data semantics but only a 19-line foundation UI; content/account drilldowns and data-state operations are missing. |
| `/insights` | leads, interactions, account/post metric sync, metric history, operation reports | direct Prisma queries, `interaction-service`, `facebook-service`, `report-service` | Four different jobs share a 587-line page; analytics responsibility duplicates `/analytics`. |
| `/connections` | provider OAuth, discovery, account selection, token refresh/disconnect, capability display | `platform-connection-service`, `PlatformConnection`, `SocialAccount` | Provider connection is the visual object, while operators manage accounts and capabilities. Future providers would make this page provider-centric and fragmented. |
| `/settings` | workspace, market/brand fields, runtime, usage, AI provider, notifications, capability matrix, legacy Facebook config | direct Prisma queries and settings/notification/Facebook APIs | Business configuration, platform configuration, notifications, and legacy fallback are mixed. Brand and account capability responsibilities duplicate dedicated pages. |
| `/login` | authentication | auth/rate-limit services | Appropriate standalone route. |

### Routes missing for the current domain

- `/publishing`: no unified control center for `PublishJob`, `PublishAttempt`, queue state, `UNKNOWN`, remote query, and reconciliation.
- `/accounts`: no account-first view across providers and capabilities.
- `/content/[id]`: no focused content composer/detail workspace; every item expands inside the list.
- `/products/[id]`: no focused product detail for facts, provenance, assets, and content usage.
- Focused detail surfaces for account, publish job, and lead are absent; long inline disclosures are used instead.

## 1.2 Current navigation

The current PR #5 navigation contains nine flat top-level links:

```text
总览
内容
日历
产品
品牌
数据分析
互动与线索
平台连接
设置
```

This is materially better than the six engineering-oriented links on `main`, and PR #3 already supplies active-route indication, semantic status display, responsive behavior, and a quiet enterprise shell. The remaining problem is structural: all links have equal hierarchy and mirror modules rather than operator tasks.

If Research, Image AI, Automation, LinkedIn, TikTok, YouTube, Threads, X, and Pinterest each followed the current pattern, the sidebar would continue growing without changing how work is actually completed.

## 1.3 Duplicate and misplaced responsibilities

| Responsibility | Current locations | V2 decision |
| --- | --- | --- |
| Publishing status | Dashboard, `/content`, calendar cards | Make `/publishing` authoritative; Dashboard and content show summaries/links only. |
| `UNKNOWN` reconciliation | Dashboard and content history | Operate in `/publishing`; Dashboard only raises attention. |
| Account capability | `/connections`, `/settings`, Dashboard | Make `/accounts` authoritative; Dashboard shows health summary, Settings shows only system integration configuration. |
| Metrics | `/insights` and `/analytics` | Move metric analysis and data health to `/analytics`; `/insights` retains interaction/lead evidence only. |
| Operation reports | `/insights` while analytics review exists in `/analytics` | Present review/insight in `/analytics`; retain `OperationReport` as an existing data source, not a separate module. |
| Brand configuration | `/brand` plus market/brand fields in `/settings` | Make `/brand` authoritative; Settings retains workspace-level defaults only. |
| Notifications | Dashboard unread count plus Settings channel setup | Dashboard shows actionable notifications; Settings owns channel configuration and delivery diagnostics. |
| Content generation, editing, approval, scheduling | all expanded on `/content` | `/content` becomes center/list; `/content/[id]` becomes composer and workflow detail. |

## 1.4 Technical concepts leaking into the primary UI

The following are valid diagnostics but should not be the primary operator vocabulary:

- raw enum values such as `REVIEW_PENDING`, `WAITING_CONFIGURATION`, `READ_FAILED`, and `UNVERIFIED`;
- `Provider`, adapter names, Graph API version, Page task names, token references, and OAuth internals;
- raw `MetricSnapshot` keys, account IDs, source adapters, and JSON-shaped report facts;
- `ContentVersion`/`PromptVersion` mechanics exposed before the user asks for history;
- `PublishAttempt` failure phases and lock details exposed without an operator interpretation;
- AI stage names presented as features instead of content-workflow capabilities.

V2 keeps these available inside “Technical details”, audit history, or advanced panels, while primary UI uses operator language:

- `UNKNOWN` → **结果待确认**;
- `PERMISSION_MISSING` → **需要重新授权/权限不足**;
- `WAITING_CONFIGURATION` → **等待配置**;
- `READ_FAILED` → **同步失败，数据可能过期**;
- adapter/provider names → shown only when troubleshooting.

## 1.5 Structural findings by severity

### High

1. There is no Publishing Control Center despite publishing being a core, safety-sensitive workflow.
2. Content center combines list, composer, approval, scheduling, and execution history in one page.
3. Platform management is connection-first rather than account-first, which will not scale to multiple providers and accounts.
4. `/insights` and `/analytics` duplicate data responsibility and create two places to judge performance truth.

### Medium

1. Brand/Memory/Research exists in the domain but is not inspectable in operator terms.
2. The flat sidebar has no task groups or global workspace/account context bar.
3. Dashboard correctly emphasizes attention but lacks a clear “today's schedule” section and trusted trend summary.
4. Product and account details expand inline instead of using a repeatable list-to-detail pattern.
5. Page server components often query Prisma directly; without page-level query composition, the same read rules risk being reimplemented in several pages.

### Low

1. New foundation pages do not yet use all PR #3 visual primitives consistently.
2. Some labels remain English or raw technical values.
3. Current Calendar uses browser alerts for reschedule errors and does not expose approval/publish status with the shared status component.

## 1.6 Existing strengths to preserve

- PR #3's quiet enterprise tokens, restrained surfaces, explicit focus states, semantic `StatusIndicator`, accessible headings, and responsive shell.
- Dashboard's “需处理” first hierarchy.
- Content status filters and explicit separation of AI checks from human approval.
- Calendar's service-layer rescheduling and protected terminal/running states.
- Analytics' missing-is-not-zero and freshness semantics.
- Tenant-scoped queries and role-based action gates.
- Account selection and capability verification after OAuth.
- Publishing safety: `UNKNOWN` is not a normal retryable failure.

---

# 2. Recommended Information Architecture

## 2.1 Final sidebar

```text
Aarin SocialOps

工作台
└── 总览

运营
├── 内容中心
├── 内容日历
└── 发布中心

资产
├── 品牌与知识
└── 产品与素材

互动与分析
├── 互动与线索
└── 数据分析

系统
├── 平台与账号
└── 设置
```

The group labels are non-clickable orientation labels. The sidebar remains stable when a new provider, account, AI stage, research source, or automation type is added.

## 2.2 Route map

| Route | Label | Responsibility | Compatibility |
| --- | --- | --- | --- |
| `/` | 总览 | operational attention, today's schedule, account health, recent trend | existing route retained |
| `/content` | 内容中心 | content inventory, filters, search, bulk navigation, create entry | existing route retained |
| `/content/[id]` | Content Composer / 内容详情 | context, editor, variants, media, checks, human approval, scheduling summary | new focused route; no new persistence model |
| `/calendar` | 内容日历 | month/week/list schedule across platforms/accounts | existing route retained |
| `/publishing` | 发布中心 | queue, running, published, failed, result-pending, reconciliation | new route over existing publishing records |
| `/publishing/[id]` | 发布任务详情 | attempts, remote IDs, errors, query, reconciliation, audit | optional detail route; drawer may be used first |
| `/brand` | 品牌与知识 | profile, audience, content rules, memory, research | existing route retained and expanded |
| `/products` | 产品与素材 | product inventory and asset library | existing route retained |
| `/products/[id]` | 产品详情 | facts, sources, assets, content usage | recommended new detail route |
| `/insights` | 互动与线索 | prioritized leads, interactions, manual tasks | existing route retained; metrics/report analysis removed |
| `/analytics` | 数据分析 | overview, content performance, platform/account performance, data health, insights | existing route retained and expanded |
| `/accounts` | 平台与账号 | account-first capability and connection management | new canonical route |
| `/accounts/[id]` | 账号详情 | account capabilities, connection, token/permission health, technical detail | recommended detail route |
| `/connections` | compatibility alias | redirect to `/accounts` while preserving old bookmarks and OAuth return paths | do not remove in first migration |
| `/settings` | 设置 | workspace, runtime, providers, storage, notifications, usage, advanced | existing route retained and narrowed |
| `/login` | 登录 | authentication | unchanged |

### Route compatibility rule

During UI Phase 1, `/connections` remains a valid route or server redirect to `/accounts`. Existing OAuth `returnTo`, form actions, tests, bookmarks, and external acceptance scripts must continue working. Canonical links can move to `/accounts` only after contract tests cover the alias.

## 2.3 Global workspace layout

### Sidebar answers “where am I going?”

- grouped, stable task navigation;
- active route;
- collapsed mode is optional for later desktop density;
- no provider-specific top-level routes.

### Context bar answers “who and what am I operating?”

```text
[ RICCIONE ▼ ]  [ All platforms ▼ ]  [ All accounts ▼ ]       [ + 新建 ] [ 通知 3 ]
```

- Workspace switch uses existing `ClientMembership` and switch-client endpoint.
- Platform/account filters are page context, not new global persisted state in Phase 1.
- Pages that cannot use an account filter may omit or disable it with explanatory text.
- Runtime mode remains visible as text plus tone; switching mode stays in Settings.
- Notifications open an in-app notification panel backed by existing `InAppNotification`.

### Global Quick Create

Initial entries:

- 新建内容 → `/content?create=1` or composer start flow;
- 上传素材 → `/products?upload=1`;
- 添加产品 → `/products?create=1`;
- 添加品牌资料 → `/brand?tab=profile`;
- 连接平台账号 → `/accounts?add=1`.

Command palette (`Cmd/Ctrl + K`) is not required for UI Phase 1.

---

# 3. Core User Flows

## 3.1 Create Content

```text
Global + 新建 / Content Center + 创建内容
  → choose product or generic content
  → choose objective, theme, target accounts/platforms
  → review Content Context (brand, audience, confirmed facts, assets, memory)
  → generate strategy/master/variants through existing pipeline
  → save resulting ContentPlan + ContentItem + ContentVersion
  → land in /content/[id]
```

Rules:

- Only `CONFIRMED` product facts enter generation context.
- AI stage output creates content versions; it never creates human approval.
- Prompt internals remain in audit/technical detail, not the main composer.
- Missing facts are visible before generation and remain missing, not invented.

## 3.2 Review Content

```text
Content Center “待审核”
  → open /content/[id]
  → inspect platform preview + source facts + content checks
  → approve or reject the current immutable ContentVersion for its account
  → Approval is stored with reviewer, decision, note, version, account
```

AI “内容检查” and human approval are two separate panels and states. Passing checks must never visually imply that a human has approved the content.

## 3.3 Schedule Content

```text
Approved content detail
  → choose NOW or SCHEDULED in workspace timezone
  → call existing schedule service
  → create/reuse PublishJob under existing idempotency rules
  → show item in Calendar and Publishing Center
```

Calendar drag/drop calls `calendar-service`; it never writes directly to Prisma from the client.

## 3.4 Publish Content

```text
PublishJob PENDING/RETRY becomes eligible
  → worker claim and final gates
  → PublishAttempt DISPATCHING
  → PUBLISHED / FAILED / UNKNOWN / WAITING_CONFIGURATION
  → Publishing Center reflects the authoritative job and attempt state
```

No UI action bypasses account capability, tenant, approval, immutable version, or product-data-version gates.

## 3.5 Handle Publish Failure or UNKNOWN

```text
Dashboard attention item or Publishing “需处理” filter
  → open publish job detail
  → inspect operator explanation, latest attempt, account health, remote identifiers
  → if remote ID exists: query remote status
  → if remote result is uncertain: reconcile using existing service and explicit evidence
  → record result and audit trail
```

- `UNKNOWN` label: **结果待确认** with Warning tone.
- `FAILED` label: **失败** with Danger tone.
- The UI must not offer generic “Retry” for `UNKNOWN`.
- Retry is shown only when the existing backend has already classified the job as safely retryable.

## 3.6 Connect Account

```text
Accounts + 添加平台账号
  → choose platform (Facebook/Instagram/LinkedIn/TikTok/YouTube)
  → supported provider starts existing OAuth flow
  → callback/state/token exchange
  → discovered SocialAccount rows
  → operator explicitly selects accounts
  → capability verification
  → Accounts table shows account-first health
```

Provider/OAuth remains implementation detail. The user chooses a platform/account outcome.

## 3.7 Fix Account Connection

```text
Dashboard account health / Accounts “需处理”
  → open account detail
  → see human-readable cause: token expiry, permission missing, disconnected, unsupported
  → reconnect/refresh where provider supports it
  → verify capabilities
  → return to account list with last-checked timestamp
```

## 3.8 Manage Brand

```text
Brand & Knowledge
  → profile/audience/content-rules tab
  → edit structured BrandProfile
  → save through existing brand service
  → inspect what content/memory/research context will be available to creation
```

Legacy `Client.brandGuidelines` remains a fallback until an explicit later migration decision.

## 3.9 Manage Product

```text
Products & Assets
  → open product detail
  → add/edit facts with status and source
  → upload/link assets
  → inspect content currently using the product/version
```

`CONFIRMED`, `PROPOSED`, and `MISSING` remain explicit and source-visible.

## 3.10 View Analytics

```text
Analytics
  → choose period + platform/account filter
  → read programmatic metric summaries
  → inspect trend and content/account tables
  → check freshness and availability
  → read labeled observation/hypothesis/recommendation
```

## 3.11 View Content Performance

```text
Analytics → 内容表现
  → sort by reach/views/engagement/publish time
  → open content detail
  → correlate factual metric changes with content/account/time
  → never present an AI hypothesis as a measured fact
```

---

# 4. Page Specifications

## 4.1 Dashboard `/`

**Purpose**

Answer in five seconds: what needs attention, what publishes today, whether accounts are healthy, and how recent performance changed.

**Primary user questions**

- What must I handle now?
- What will publish today?
- Which accounts are unhealthy?
- Is recent performance moving materially?

**Data source**

- `ContentItem`, `Approval`, `PublishJob`, `PublishAttempt`.
- `PlatformConnection`, `SocialAccount` capability fields.
- `Lead`, `ManualTask`, `InAppNotification`.
- `MetricSnapshot`, `AnalyticsSyncState` via analytics service.

**Main components**

- `WorkspaceContextBar`.
- `AttentionQueue` sorted by operational severity.
- `TodaySchedule`.
- `AccountHealthSummary`.
- `MetricSummary` with freshness.

**Primary actions**

- Open the specific object requiring action.
- Open content/publishing/account detail.

**Secondary actions**

- Quick create.
- Mark a manual task complete where existing permission allows it.

**Empty state**

“当前没有需要立即处理的问题”，while still showing today's schedule and data freshness.

**Error state**

Section-level failure; one failed summary must not blank the entire Dashboard.

**Data honesty constraint**

The current schema has per-job worker lease heartbeats (`lockedAt`/`lockedBy` renewed while running), not a durable global worker-presence record. Dashboard may report queue/job health but must not claim “Worker online” without a future separately approved source of truth.

## 4.2 Content Center `/content`

**Purpose**

Provide a searchable, filterable inventory of content and a clear entry into focused creation/review work.

**Primary user questions**

- Which content is draft, awaiting review, approved, scheduled, published, or blocked?
- Which account/platform/product does each item belong to?
- What should I open next?

**Data source**

- `ContentPlan`, `ContentItem`, current `ContentVersion`, latest `Approval`, latest `PublishJob`, `SocialAccount`, `Product`.

**Main components**

- `Tabs`: 全部 / 草稿 / 待审核 / 已批准 / 已排期 / 已发布 / 需处理.
- `FilterBar`: platform, account, product, date, search.
- `DataTable` or dense content rows.
- `ContentStatus`, `PlatformBadge`.

**Primary actions**

- `+ 创建内容`.
- Open content detail/composer.

**Secondary actions**

- Bulk selection may be planned only for non-destructive, service-backed operations.

**Empty state**

Filter-specific empty copy plus a safe create action.

**Error state**

List load error with preserved filters; no destructive fallback.

## 4.3 Content Composer `/content/[id]`

**Purpose**

Keep context, editing, platform variants, content checks, human approval, and scheduling in one focused workspace without exposing prompts.

**Primary user questions**

- What context produced this content?
- What is the current immutable version?
- How will it look per platform?
- What checks or human decisions remain?

**Data source**

- `BrandProfile`, existing memory service, `Product`/`ProductField`, `Asset`.
- `ContentPlan`, `ContentItem`, `ContentVersion`, `ContentVersionAsset`, `Approval`, `PublishJob`.
- Existing AI content pipeline and content service.

**Main components**

- `ContentContextPanel`.
- `ContentEditor`.
- `PlatformVariantTabs` and `PlatformPreview`.
- `ContentCheckPanel`.
- `ApprovalPanel`.
- `ScheduleSummary`.
- `VersionHistory` in secondary detail.

**Primary actions**

- Save as new version.
- Submit for review.
- Approve/reject when role and state allow.
- Schedule after valid approval.

**Empty state**

No current version: explain recovery or creation path; do not silently invent one.

**Error state**

Version mismatch, stale approval, missing product version, or account capability failure must be explicit and block scheduling.

## 4.4 Calendar `/calendar`

**Purpose**

Show and adjust the operational schedule across platforms/accounts without creating another scheduler.

**Primary user questions**

- What is scheduled on a day/week?
- Is each item approved and publish-ready?
- Which items can be safely moved?

**Data source**

- Existing `calendar-service` over `ContentItem`, current `Approval`, latest `PublishJob`, `SocialAccount`.

**Main components**

- `Tabs`: Month / Week / List.
- `FilterBar`: platform, account, content/publish status.
- `CalendarGrid`, `CalendarCard`.
- `DetailPanel` for selected item.

**Primary actions**

- Drag/drop service-backed reschedule.
- Open content or publishing detail.

**Secondary actions**

- Bulk reschedule through the existing service contract.

**Empty state**

Explain whether filters or an empty schedule caused the result.

**Error state**

Locked/running/terminal states remain immovable; show the reason inline instead of browser alert only.

## 4.5 Publishing Center `/publishing`

**Purpose**

Provide the authoritative operational view for publish queues, attempts, remote results, and reconciliation.

**Primary user questions**

- What is queued, running, published, failed, or awaiting confirmation?
- Which account and immutable content version is involved?
- Is an operator action safe and necessary?

**Data source**

- `PublishJob`, `PublishAttempt`, `ContentVersion`, `ContentItem`, `SocialAccount`, `PlatformConnection`, `ManualTask`, `AuditLog`.
- Existing publish worker, query, and reconciliation services.
- PR #4 generalized platform query service after merge.

**Main components**

- `Tabs`: 全部 / 排队中 / 发布中 / 已发布 / 失败 / 结果待确认.
- `FilterBar`: platform, account, environment, schedule/date.
- `PublishingTable`.
- `PublishJobDetailPanel` with attempt timeline.
- `ConfirmDialog` for reconciliation actions.

**Primary actions**

- Query remote status when supported.
- Open manual reconciliation for `UNKNOWN`.
- Navigate to content/account detail.

**Secondary actions**

- Copy remote post link/ID.
- Inspect technical error and audit history.

**Empty state**

Explain that publishing jobs appear after approved content is scheduled.

**Error state**

- `UNKNOWN`: Warning, “结果待确认”; no blind retry.
- explicit failure: Danger with cause and operator-safe next step.
- waiting configuration: Warning with link to account/configuration.

## 4.6 Brand & Knowledge `/brand`

**Purpose**

Make brand context and organizational memory understandable and maintainable by operators.

**Tabs**

- 品牌档案.
- 受众.
- 内容规范.
- 知识记忆.
- 研究记录.

**Data source**

- `BrandProfile`, legacy `Client.brandGuidelines` fallback.
- `ResearchRecord`.
- Existing content/performance/research memory services over authoritative records.

**Main components**

- `Tabs`, `FormField`, `MemorySummary`, `ResearchTable`, `DetailPanel`.

**Primary actions**

- Save structured brand profile.
- Inspect memory records and research evidence.

**Secondary actions**

- Filter research by `COMPETITOR`, `TREND`, `CONTENT`, `PLATFORM`, `AUDIENCE`, `KEYWORD` values when present.
- Open the source content/product/metric record.

**Empty state**

- Profile: explain which fields improve content context.
- Memory: “系统尚无已保存内容/表现/研究记录”; never show an unexplained zero only.

**Error state**

Show a section-level read failure without discarding successfully loaded brand profile data.

## 4.7 Products & Assets `/products`

**Purpose**

Manage products, confirmed facts, provenance, and reusable assets in one workspace.

**Primary user questions**

- Which product facts are confirmed, proposed, or missing?
- Where did a fact come from?
- Which assets and content use this product?

**Data source**

- `Product`, `ProductField`, `Asset`, `ProductAsset`, `ContentPlan` and linked content.
- Existing product service and storage adapter.

**Main components**

- Product list/table.
- Asset library view.
- `ProductDetailPanel` or `/products/[id]`.
- `FactStatus`, source display, asset grid.

**Primary actions**

- Add product.
- Upload asset.
- Edit product facts through existing service.

**Secondary actions**

- Link asset to product.
- Open content using the product.

**Empty state**

Separate “no products” and “no assets” explanations/actions.

**Error state**

Unsupported file, storage failure, missing provenance, or stale product version must be explicit.

## 4.8 Interactions & Leads `/insights`

**Purpose**

Prioritize high-value human follow-up while preserving interaction evidence and manual tasks.

**Hierarchy**

1. High-priority/urgent leads.
2. Normal leads.
3. Manual tasks.
4. Interaction history.

**Data source**

- `Interaction`, `Lead`, `ManualTask`, related `Product`, `SocialAccount`.
- Existing interaction and lead services.

**Main components**

- lead priority queue;
- `LeadDetailPanel`;
- task queue;
- interaction table.

**Primary actions**

- Update lead handoff status and feedback.
- Complete manual tasks.

**Secondary actions**

- Import/sync interactions where an existing service supports it.
- Open source post/account.

**Empty state**

Differentiate “no interactions imported” from “interactions exist but no leads detected”.

**Error state**

Import/sync failure must not hide already stored interactions or imply that automatic replies occurred.

## 4.9 Analytics `/analytics`

**Purpose**

Provide trustworthy performance comparison, content/account drilldown, and labeled review insights.

**Tabs**

- 总览.
- 内容表现.
- 平台与账号.
- 数据状态.

**Data source**

- `MetricSnapshot`, `AnalyticsSyncState`, `ContentItem`, `ContentVersion`, `PublishJob`, `SocialAccount`, existing `OperationReport` where useful.
- Existing analytics service for canonical metrics and period math.

**Main components**

- `MetricSummary`, `TrendIndicator`, trend chart/table.
- content performance table.
- account comparison table.
- data-status table.
- labeled insight list: FACT / OBSERVATION / HYPOTHESIS / RECOMMENDATION.

**Primary actions**

- Change period/granularity/filter.
- Open content/account detail.

**Secondary actions**

- Start an existing supported sync from Data Status.
- Generate/update an existing operation report where retained.

**Empty state**

State whether data is not fetched, unsupported, permission denied, or simply outside the selected period.

**Error state**

Freshness and availability are shown per source; missing data is never rendered as zero.

## 4.10 Platforms & Accounts `/accounts`

**Purpose**

Manage account capability and connection health across providers, with accounts as the primary object.

**Tabs/filters**

- 全部账号.
- 可发布.
- 需处理.
- 已断开.

**Data source**

- `SocialAccount`, `PlatformConnection`, capability fields, `PlatformPolicy`.
- Existing connection service.
- PR #4 `PlatformRegistry`/capability definitions after merge.

**Main components**

- `AccountTable`.
- `AccountStatus`.
- `AddAccount` flow.
- `AccountDetailPanel`.
- technical connection disclosure.

**Primary actions**

- Add/connect platform account.
- Select discovered account.
- Refresh/reconnect/disconnect where supported.

**Secondary actions**

- Inspect scopes, provider capability details, last checked, and errors.

**Empty state**

“尚未添加平台账号” with a single Add Account action.

**Error state**

Human-readable account issue plus provider-specific remediation; tokens and secrets are never displayed.

## 4.11 Settings `/settings`

**Purpose**

Contain only workspace/system configuration, not normal operational work.

**Sections**

- Workspace: name, timezone, membership context.
- Runtime: DEMO/DRAFT/LIVE with explicit impact.
- AI Provider: provider selection and verification status.
- Storage: configured storage provider/status when supported.
- Notifications: channel configuration/delivery diagnostics.
- Usage: usage and limit.
- Advanced: integration configuration and legacy diagnostics.

**Move out**

- Brand profile and content rules → `/brand`.
- Account capability and normal OAuth management → `/accounts`.
- Legacy Facebook fallback stays Advanced until an explicit deprecation decision.

---

# 5. Core Wireframes

These wireframes describe hierarchy and interaction, not final visual styling.

## 5.1 Dashboard

```text
┌ Sidebar ──────────────┬────────────────────────────────────────────────────────┐
│ Aarin SocialOps       │ [RICCIONE ▼] [All platforms ▼] [All accounts ▼] [+ 新建]│
│                      ├────────────────────────────────────────────────────────┤
│ 工作台               │ 总览                                      通知 3      │
│  • 总览              │                                                        │
│                      │ 需处理                                                 │
│ 运营                 │ ┌ 结果待确认 2 ─────────────── [打开发布中心] ┐        │
│  • 内容中心          │ │ 账号权限异常 1 ───────────── [修复账号]     │        │
│  • 内容日历          │ │ 高优先级线索 3 ───────────── [跟进]         │        │
│  • 发布中心          │ └──────────────────────────────────────────────┘        │
│                      │                                                        │
│ 资产                 │ 今日排期                     账号健康                   │
│  • 品牌与知识        │ 10:00 Instagram @brand       9 / 11 正常               │
│  • 产品与素材        │ 14:00 LinkedIn RICCIONE      2 需处理                  │
│                      │ 19:00 TikTok @brand                                     │
│ 互动与分析           │                                                        │
│  • 互动与线索        │ 最近 7 天（数据新鲜度：Fresh）                         │
│  • 数据分析          │ Reach +12%  Views +21%  Engagement -3%  Followers +4% │
└──────────────────────┴────────────────────────────────────────────────────────┘
```

## 5.2 Content Center

```text
┌ Sidebar ──────────────┬──────────────────────────────────────────────────────┐
│                      │ [Workspace] [Platform] [Account]          [+ 创建内容] │
│ 运营                 ├──────────────────────────────────────────────────────┤
│  • 内容中心          │ 内容中心                                             │
│  • 内容日历          │ [全部] [草稿] [待审核] [已批准] [已排期] [已发布] [需处理]│
│  • 发布中心          │ [搜索……] [平台 ▼] [账号 ▼] [产品 ▼] [日期 ▼]          │
│                      │                                                      │
│                      │ □ 标题/主题      平台   账号    状态      更新时间     │
│                      │ □ Factory Tour   IG     @brand  待审核    10:32        │
│                      │ □ Office Chair   LI     RICCIONE 已排期   昨天         │
│                      │ □ Catalog        FB     Page A  需处理    昨天         │
│                      │                                                      │
│                      │ 点击行 → /content/[id]                               │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 5.3 Content Composer

```text
┌ Sidebar ─────┬ Context ─────────────┬ Editor ─────────────────┬ Preview ──────┐
│              │ Brand: RICCIONE      │ Strategy                │ [Facebook]    │
│              │ Audience: B2B buyer  │ Master content          │ [Instagram]   │
│              │ Product: Office Chair│                         │ [LinkedIn]    │
│              │                      │ Platform variants       │ [TikTok]      │
│              │ Confirmed facts 8    │                         │ [YouTube]     │
│              │ Missing facts 2      │ Media                   │               │
│              │ Assets 5             │                         │ Live preview  │
│              │ Recent memory        │ 内容检查                │               │
│              │ Performance context  │ ✓ facts  ✓ tone  ! same│               │
│              │                      │                         │               │
│              │ [查看上下文详情]     │ [保存新版本] [提交审核] │               │
├──────────────┴──────────────────────┴─────────────────────────┴───────────────┤
│ 人工审批：待审核 / reviewer / note       排期：未排期      Version history ▼ │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 5.4 Calendar

```text
┌ Sidebar ──────────────┬──────────────────────────────────────────────────────┐
│ 运营                 │ 内容日历                             [+ 创建内容]      │
│  • 内容中心          │ [Month] [Week] [List]   [Platform] [Account] [Status]│
│  • 内容日历          │                                                      │
│  • 发布中心          │ Mon        Tue        Wed        Thu        Fri       │
│                      │ ┌ 10:00 IG ┐          ┌ 14:00 LI ┐                   │
│                      │ │ @brand   │          │ RICCIONE │                   │
│                      │ │ Approved │          │ Scheduled│                   │
│                      │ │ Queued   │          │ Ready    │                   │
│                      │ └──────────┘          └──────────┘                   │
│                      │                                                      │
│                      │ Drag/drop → calendar service; locked items explain why│
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 5.5 Publishing Center

```text
┌ Sidebar ──────────────┬──────────────────────────────────────────────────────┐
│ 运营                 │ 发布中心                                             │
│  • 内容中心          │ [全部] [排队中] [发布中] [已发布] [失败] [结果待确认] │
│  • 内容日历          │ [平台 ▼] [账号 ▼] [环境 ▼] [日期 ▼]                  │
│  • 发布中心          │                                                      │
│                      │ 内容         平台  账号     排期     状态       操作   │
│                      │ Factory Tour IG    @brand   19:00    已发布     查看   │
│                      │ Office Chair LI    RICCIONE 20:00    已排期     查看   │
│                      │ Catalog      FB    Page A   —        结果待确认 对账   │
│                      │                                                      │
│                      │ Detail panel: attempts / remote query / audit / error │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 5.6 Brand & Knowledge

```text
┌ Sidebar ──────────────┬──────────────────────────────────────────────────────┐
│ 资产                 │ 品牌与知识                                           │
│  • 品牌与知识        │ [品牌档案] [受众] [内容规范] [知识记忆] [研究记录]    │
│  • 产品与素材        │                                                      │
│                      │ 知识记忆                                             │
│                      │ 最近主题 12  Hooks 16  CTA 8  产品 6                  │
│                      │                                                      │
│                      │ 最近内容                                             │
│                      │ 标题 / 主题 / 平台 / 产品 / 状态 / 发布时间           │
│                      │                                                      │
│                      │ Performance context        Research evidence         │
│                      │ [查看指标来源]              [查看研究记录]            │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 5.7 Analytics

```text
┌ Sidebar ──────────────┬──────────────────────────────────────────────────────┐
│ 互动与分析           │ 数据分析                         Last synced 09:40 Fresh│
│  • 互动与线索        │ [总览] [内容表现] [平台与账号] [数据状态]             │
│  • 数据分析          │ [7 days ▼] [All platforms ▼] [All accounts ▼]         │
│                      │                                                      │
│                      │ Reach +12% | Views +21% | Engagement -3% | Followers │
│                      │ ─────────────────── trend / comparison ────────────── │
│                      │                                                      │
│                      │ 本期洞察                                             │
│                      │ FACT        128 metric snapshots evaluated           │
│                      │ OBSERVATION Instagram video views +18%               │
│                      │ HYPOTHESIS  Video format may be related               │
│                      │ RECOMMEND.  Continue a controlled content test       │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

## 5.8 Platforms & Accounts

```text
┌ Sidebar ──────────────┬──────────────────────────────────────────────────────┐
│ 系统                 │ 平台与账号                         [+ 添加平台账号]    │
│  • 平台与账号        │ [全部账号] [可发布] [需处理] [已断开]                 │
│  • 设置              │                                                      │
│                      │ Platform  Account    Publish Analytics Comments Status│
│                      │ Facebook  RICCIONE   ✓       ✓         ✓        正常  │
│                      │ Instagram @riccione  ✓       —         —        正常  │
│                      │ LinkedIn  RICCIONE   —       —         —        待接入│
│                      │                                                      │
│                      │ Click row → capability + connection detail panel      │
│                      │ OAuth/scopes/token diagnostics stay secondary         │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

---

# 6. Component Architecture

## 6.1 Preserve from PR #3

- `PageHeader`.
- `SectionHeader`.
- `StatusIndicator`.
- `Button` variants.
- `Notice`.
- `EmptyState`.
- `FormField`.
- semantic color/status presentation and quiet enterprise CSS tokens.
- accessible active navigation and responsive shell behavior.

These remain the visual foundation; UI V2 should extend them rather than introduce a parallel component system.

## 6.2 Add a limited set of semantic components

| Component | Responsibility | Must not own |
| --- | --- | --- |
| `WorkspaceContextBar` | workspace identity, optional platform/account filter context, quick create, notification entry | tenant authorization or persistence rules |
| `GroupedPrimaryNav` | stable IA groups and active route | provider capability logic |
| `QuickCreate` | route/action menu for common creation flows | direct database writes |
| `Tabs` | page-local stable sub-navigation | domain state transitions |
| `FilterBar` | query-string filters and search | business filtering rules hidden from services |
| `DataTable` | accessible dense tabular layout, empty/loading/error slots | domain-specific status interpretation |
| `DetailPanel` | repeatable list-to-detail drawer/sheet pattern | object mutation rules |
| `ConfirmDialog` | explicit confirmation for destructive/high-risk actions | server authorization |
| `ContentStatus` | content-domain label/tone/action hint | status mutation |
| `AccountStatus` | connection and capability summary | token handling |
| `PlatformBadge` | platform name/icon/text | provider logic |
| `MetricSummary` | value/change/period/freshness | metric computation |
| `TrendIndicator` | direction + signed value + text | causal interpretation |
| `ContentCheckPanel` | fact/brand/platform checks with evidence | human Approval |
| `PublishAttemptTimeline` | chronological attempts and remote evidence | retry decision |

## 6.3 List/detail interaction pattern

Use one of two consistent patterns:

1. **List → Detail Page** for complex, shareable workflows: content, product.
2. **List → Detail Panel** for fast operational inspection: account, publish job, lead, memory record.

Every detail surface has:

- identity and status header;
- primary facts;
- operator actions gated by role/state;
- history/audit section;
- technical details collapsed by default;
- explicit empty and error state.

## 6.4 Responsive behavior

- Desktop target: 1366×768, 1440×900, 1920×1080.
- Below 1100px: reduce columns; detail panels may become full-width overlays.
- Below 900px: sidebar becomes a compact top navigation or accessible drawer; context filters wrap into rows.
- Tables use horizontal scroll with sticky identity/status columns only when tested; never crop actions silently.
- Composer three columns collapse to Context → Editor → Preview stacked sections or tabs.
- Forms become one column; action bars remain reachable without overlay.
- No mobile-first reduction that removes essential operations from the desktop product.

## 6.5 Visual language

Continue PR #3's direction:

- cold gray background;
- white primary surfaces;
- charcoal sidebar;
- 1px borders;
- small radii;
- minimal shadows;
- dense, readable tables;
- strong text hierarchy;
- restrained semantic tones.

Do not add gradients, glow, glassmorphism, AI orbs, decorative motion, exaggerated radii, or oversized KPI cards.

---

# 7. Unified Status System

## 7.1 Semantic tones

| Tone | Meaning | Examples |
| --- | --- | --- |
| Neutral | inactive, draft, unsupported, completed history without urgency | Draft, Disconnected, Unsupported, Cancelled |
| Info | active workflow or ordinary new work | Review Pending, Scheduled, Running, New Lead |
| Success | verified or successfully completed | Approved, Published, Connected, Fresh |
| Warning | operator attention or uncertain outcome | Result Pending (`UNKNOWN`), Token Expiring, Permission Missing, Stale |
| Danger | explicit failure or blocking invalid state | Failed, Token Expired, Sync Failed |

Every status uses color **and text**. Icons are optional reinforcement and never the sole signal.

## 7.2 Domain presentation decisions

| Raw state | Primary label | Tone | Operator meaning |
| --- | --- | --- | --- |
| `DRAFT` | 草稿 | Neutral | work not submitted |
| `REVIEW_PENDING` | 待审核 | Info | human decision required |
| `APPROVED` | 已批准 | Success | current version/account approval exists |
| `SCHEDULED` | 已排期 | Info | scheduled but not running |
| `RUNNING` | 发布中 | Info | worker holds current job |
| `PUBLISHED` | 已发布 | Success | remote result confirmed |
| `UNKNOWN` | 结果待确认 | Warning | remote side effect cannot be confirmed; do not blind retry |
| `FAILED` | 失败 | Danger | explicit terminal failure |
| `CONNECTED` | 正常连接 | Success | connection usable at connection level |
| `TOKEN_EXPIRING` | 凭据即将到期 | Warning | reconnect/refresh soon |
| `PERMISSION_MISSING` | 权限不足 | Warning | reconnect or fix provider role/scope |
| `DISCONNECTED` | 已断开 | Neutral | no active connection |
| `VERIFIED` capability | 可用 | Success | capability was verified |
| `UNVERIFIED` capability | 未验证 | Warning | do not assume capability |
| `UNSUPPORTED` | 不支持 | Neutral | not available by design |
| `FRESH` | 数据新鲜 | Success | data within freshness policy |
| `STALE` | 数据已过期 | Warning | refresh before decisions |
| `SYNCING` | 同步中 | Info | active read operation |
| `READ_FAILED`/sync `FAILED` | 同步失败 | Danger | retain old data with warning |

Permission missing is operationally Warning rather than Danger in list summaries because it is usually recoverable. A blocking form may still use a danger notice when a requested action cannot continue.

---

# 8. Backend Mapping

UI V2 composes existing services/models. It does not introduce parallel state.

| UI surface | Service/read composition | Authoritative models | Write boundary |
| --- | --- | --- | --- |
| Dashboard | thin dashboard query composition; existing analytics read | content/publishing/account/lead/task/notification/metric models | existing task, query, reconciliation routes only |
| Content Center | content list query over current content relationships | `ContentPlan`, `ContentItem`, `ContentVersion`, `Approval`, `PublishJob` | existing content service |
| Content Composer | content service + AI pipeline + memory/brand/product reads | content models, `BrandProfile`, `ProductField`, `Asset`, `PromptVersion` | new version/submit/review/schedule through existing service methods |
| Calendar | `listCalendarEntries`, `rescheduleCalendarItems` | `ContentItem`, `Approval`, `PublishJob`, `SocialAccount` | `calendar-service` only |
| Publishing Center | publishing read composition; existing query/reconcile/worker services | `PublishJob`, `PublishAttempt`, `ManualTask`, `AuditLog` | query/reconcile routes; worker owns dispatch |
| Brand & Knowledge | `brand-service`, `memory-service` | `BrandProfile`, `ResearchRecord`, content/metric records | existing brand service; research writes require separate approved scope |
| Products & Assets | `product-service`, storage adapter | `Product`, `ProductField`, `Asset`, `ProductAsset`, `ContentPlan` | existing product/asset routes |
| Interactions & Leads | `interaction-service`, existing comment import/task routes | `Interaction`, `Lead`, `ManualTask` | existing lead/task/import routes |
| Analytics | `analytics-service`, supported sync services | `MetricSnapshot`, `AnalyticsSyncState`, `OperationReport`, content/account relations | provider sync services only |
| Platforms & Accounts | `platform-connection-service`; PR #4 registry service after merge | `PlatformConnection`, `SocialAccount`, `PlatformPolicy` | existing OAuth/select/refresh/disconnect services |
| Settings | existing settings route plus integration/notification reads | `Client`, `IntegrationConfig`, `NotificationChannel`, `UsageLog` | existing settings/notification routes |

### Query composition rule

Server pages may initially compose reads from Prisma as they do today, but UI Phase 2 should extract repeated, tenant-scoped view queries into thin query functions where the same interpretation appears in multiple pages. These functions are not repositories or new sources of truth; they only shape existing records for UI.

### No duplicated state rule

- Content status comes from `ContentItem` and related approval/job records.
- Schedule comes from `ContentItem.scheduledAt` and `PublishJob.nextAttemptAt` under existing service rules.
- Publishing result comes from `PublishJob`/`PublishAttempt`.
- Account health comes from `PlatformConnection` and `SocialAccount` capabilities.
- Analytics values come from `MetricSnapshot`; freshness comes from `AnalyticsSyncState` and timestamps.
- Memory is a read projection over Aarin records, not a second memory database.

---

# 9. PR #3 / #4 / #5 Migration

## 9.1 PR #3: retain

Retain:

- product identity as Aarin SocialOps;
- quiet enterprise visual tokens and shell;
- shared presentation primitives;
- active navigation and accessibility behavior;
- progressive disclosure for technical information;
- redesigned Dashboard/content/products/connections/insights/settings visual patterns.

Reorganize later:

- flat navigation becomes grouped IA;
- long inline pages adopt list/detail patterns;
- Dashboard publish reconciliation moves to Publishing Center;
- metrics/report sections move from Insights to Analytics;
- Connections becomes account-first Accounts.

PR #5 already contains PR #3's head as merge parent, so implementation must avoid creating a second UI system or repeating this merge manually.

## 9.2 PR #4: integrate into Accounts and Publishing

PR #4 contributes:

- `PlatformRegistry` and platform capability definitions;
- shared HTTP/error semantics;
- Instagram publish/query support;
- account capability derivation;
- generalized platform publish query.

UI use:

- Accounts reads declared capability/support and verified account capability.
- Add Account lists supported/planned platforms without creating provider-specific main pages.
- Publishing uses generalized remote query and platform labels.
- Unsupported or not-yet-implemented platforms remain clear, disabled choices—not fake connected cards.

Do not turn PR #4 adapters or registry entries into new sidebar items.

## 9.3 PR #5: reorganize, do not duplicate

PR #5 contributes:

- structured Brand Profile and memory projections;
- staged AI content pipeline;
- Calendar service/page;
- canonical analytics and freshness;
- notification delivery foundation;
- PR #3 UI history.

UI use:

- `/brand` becomes Brand & Knowledge tabs.
- AI stages appear inside Content Composer and Content Checks.
- `/calendar` becomes a core Operations route.
- `/analytics` becomes the sole analysis/data-health workspace.
- notification delivery configuration remains in Settings; urgent in-app notifications appear in Dashboard/context bar.

Do not create separate primary pages for Memory, AI Reviewer, Humanizer, Image Prompt, or Notifications.

## 9.4 Recommended branch convergence before implementation

Two safe convergence paths exist; a human maintainer must choose one:

### Preferred if PR #3 is still reviewed independently

1. Merge PR #3 to establish the accepted visual baseline.
2. Merge PR #4 and resolve only real platform/content-service conflicts.
3. Update PR #5 from the new `main`; Git should recognize the included PR #3 ancestry.
4. Re-run full migration/tests/build/CI and merge PR #5.
5. Create UI V2 implementation branch from the resulting `main`.

### Alternative if PR #5 supersedes PR #3

1. Merge PR #4.
2. Update PR #5 from the new `main` and resolve platform/content-service conflicts.
3. Verify PR #5 still contains all PR #3 commits and UI contract tests.
4. Merge PR #5; only then mark PR #3 superseded through a human decision.
5. Create UI V2 implementation branch from the resulting `main`.

In both paths, do not implement UI V2 directly on any of the three current feature branches.

---

# 10. Implementation Phases

## UI Phase 1 — Information Architecture

**Goal:** establish the durable shell and route ownership without rewriting domain workflows.

Deliverables:

- grouped sidebar IA;
- `WorkspaceContextBar` with existing workspace switching;
- global Quick Create menu;
- canonical `/accounts` route plus `/connections` compatibility;
- `/publishing` read-first control-center shell over existing data;
- move primary links and summaries to their canonical destination;
- unified status vocabulary and semantic components;
- route/page contract tests and responsive shell verification.

Non-goals:

- no new provider implementation;
- no publishing behavior change;
- no schema change;
- no complete composer rewrite.

Acceptance:

- stable grouped navigation at 1366, 1440, and 1920 widths;
- no route or OAuth return-path regression;
- old `/connections` links remain valid;
- Dashboard links to canonical object pages;
- Publishing displays `UNKNOWN` as result pending and offers no unsafe retry.

## UI Phase 2 — Core Operations

**Goal:** make daily content, schedule, publishing, account, and product work efficient.

Deliverables:

- Content Center table/list and focused Content Composer;
- Calendar production UI with service-backed drag/drop and detail panel;
- Publishing filters, table, job detail, attempts, query/reconciliation;
- Accounts table, Add Account flow, account detail;
- Products list/detail and asset workspace;
- Dashboard today's schedule and account health.

Acceptance:

- create → review → schedule → publish status is navigable end to end;
- approval and AI check are visibly distinct;
- locked calendar items cannot be moved;
- account capabilities and connection status are not conflated;
- all writes continue through existing service gates.

## UI Phase 3 — Intelligence & Analytics

**Goal:** make brand context, memory, interaction priority, and performance evidence understandable.

Deliverables:

- Brand & Knowledge tabs and inspectable memory/research;
- Analytics tabs, content/account performance, data status;
- labeled insight review;
- reorganized Interactions & Leads hierarchy;
- contextual links between content, performance, product, account, and lead detail.

Acceptance:

- no raw JSON in primary views;
- missing metrics never become zero;
- FACT/OBSERVATION/HYPOTHESIS/RECOMMENDATION are visually and semantically distinct;
- high-priority leads outrank ordinary interactions;
- memory shows what Aarin remembers and where it came from.

---

# 11. Risks and Controls

| Risk | Impact | Control |
| --- | --- | --- |
| Implementing before PR convergence | repeated conflicts and divergent UI foundations | start UI V2 branch only after accepted PR #3/#4/#5 combination reaches `main` |
| Creating a second scheduler/publishing view model | split truth and unsafe operations | read/write existing services/models only; no duplicate domain tables |
| Confusing AI review with human approval | unauthorized content progression | separate `ContentCheckPanel` and `ApprovalPanel`; tests assert AI never creates `Approval` |
| Treating `UNKNOWN` as failure/retry | duplicate real-world posts | Warning label, reconciliation workflow, no generic retry action |
| Account status flattening | showing unusable accounts as healthy | present connection status and each capability separately |
| Dashboard overpromises worker health | false operational confidence | show queue/job evidence only until a durable worker presence source is separately approved |
| Analytics overclaims causality | bad decisions | programmatic math; labeled hypothesis/recommendation; freshness always visible |
| Large page rewrite breaks server actions | behavior regression | migrate route by route with form/API contract tests from PR #3 preserved |
| Responsive table actions become unreachable | operational dead ends | explicit 1366/1440/1920 and <900px interaction tests |
| Provider-specific UI fragmentation | sidebar growth and inconsistent behavior | account-first UI backed by registry/capabilities, provider detail secondary |
| Legacy `/connections` breakage | OAuth/bookmark/test regression | alias/redirect and return-path contract coverage |

---

# 12. Human Review Decisions Before Implementation

1. Approve the grouped sidebar and canonical routes.
2. Choose PR convergence path: merge PR #3 independently or treat it as contained by PR #5.
3. Confirm Content Composer uses `/content/[id]` rather than an oversized drawer.
4. Confirm Product detail uses a route or detail panel in the first implementation slice.
5. Confirm `/connections` behavior: server redirect or temporary alias rendering the Accounts page.
6. Confirm initial Quick Create entries; Command Palette remains later.
7. Decide whether a true global Worker health source is needed in a later backend task. It is not part of UI V2 planning or Phase 1 implementation.
8. Confirm whether ResearchRecord editing/creation exists in a separate future scope; this plan only guarantees inspection of existing records.

---

# 13. Verification and Handoff State

## Completed in this planning phase

- Audited current routes, navigation, page responsibilities, API endpoints, services, Prisma entities, and status enums.
- Compared `main`, PR #3, PR #4, and PR #5 by current remote head and changed-file scope.
- Defined final IA, routes, page ownership, user flows, wireframes, component map, backend mapping, migration phases, and risks.

## Modified files

- `docs/exec-plans/active/ui-architecture-v2.md` only.

## Tests

- Not run in this phase because no application code, schema, configuration, or dependency was changed.
- Document structure, required sections, and repository diff were checked before handoff.
- `git diff --check` reported no whitespace errors.

## Known limitations / unverified items

- No human visual usability review has been performed for these wireframes.
- No route or component in this proposal has been implemented.
- PR #3/#4/#5 remain open at the time of audit.
- Real Instagram external acceptance remains separate from this UI plan.
- Global Worker online/offline health cannot be truthfully represented from the current durable data model.

## Next step

Stop after this document and wait for human architecture review. Do not begin UI Phase 1 until the IA, route ownership, PR convergence path, and open decisions above are approved.
