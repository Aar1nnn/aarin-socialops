# 海外社媒 AI 运营工作台（V2 Phase 1：连接层与可靠性）

面向中国企业海外内容运营的本地优先工作台。一个逻辑运营负责人调用模块化能力，确定性程序负责客户隔离、内容版本、人工审批、发布任务、幂等、重试、指标和线索交接。

## 本地启动

要求：Node.js 20.9+、pnpm 11+、Docker Desktop/兼容 Docker daemon。

```powershell
Copy-Item .env.example .env
docker compose -p socialops up -d postgres
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

另开一个终端启动持久 worker：

```powershell
pnpm worker
```

访问 <http://localhost:3000>。本地种子账号默认是 `operator@example.local` / `change-this-local-password`；仅用于开发，使用前请在 `.env` 修改。生产环境禁止使用默认 seed 密码，seed 会直接拒绝执行。目录名含非 ASCII 字符时必须给 Compose 显式项目名 `-p socialops`。

## 演示模式操作路径

1. 默认登录到“独立演示客户”。
2. 在“产品与素材”创建产品、确认字段并上传图片或已剪辑视频。
3. 在“内容审核”生成四平台草稿、提交审核、批准并排期。
4. worker 只调用模拟发布适配器，远端 URL 使用 `mock://` 且任务有 `simulated=true`。
5. 在“线索与复盘”人工导入互动，系统识别明确采购意向并创建紧急站内通知和交接任务。
6. 生成模拟指标和报告；页面持续标注“模拟”，缺失/不支持/权限不足/读取失败不会显示为 0。

也可以运行完整演示脚本：

```powershell
pnpm demo:e2e
```

## 当前真实可用

- PostgreSQL 迁移、幂等种子和多客户数据模型。
- HttpOnly 会话、服务端 membership 复核和所有业务查询的 `clientId` 范围限制。
- 产品字段确认状态、来源、产品资料版本；图片/成片视频本地存储与产品关联。
- 四平台独立内容版本；OpenAI-compatible 文本接口需同时配置服务端环境变量，并在当前客户“设置”页明确标记连接已验证，输出经 Zod schema 校验；全局密钥不会隐式启用其他客户。
- 人工提交、批准/拒绝；编辑、账号变化或产品资料升级会让旧审批不可用于当前发布。
- PostgreSQL 任务领取、唯一租约、超时恢复、有限重试、执行尝试和 `UNKNOWN` 状态；未知结果可凭远端证据人工对账，不能仅将待办标为完成。
- 人工互动导入、平台记录 ID 去重、意向分类、人工回复/转交状态。
- 指标可用性、真实/模拟数据类型、程序计算事实和基于缺口的报告。
- 站内普通任务、紧急通知、操作日志和模型使用量记录。
- Meta OAuth 连接、一次性 `state`、Page/权限/任务发现、明确账号选择、连接/令牌状态和错误建议。User token 与 Page token 使用服务器密钥 AES-256-GCM 加密，前端和日志不返回明文。
- V1 手工 Facebook Page 环境变量连接仍作为兼容 fallback；新连接优先走 `/connections` 的 OAuth 流程。
- Facebook Page 纯文字、单张 PNG/JPEG、单个 MP4/QuickTime 真实发布，远端 ID/链接/发布时间保存和状态查询。
- Facebook 帖子评论/回应真实计数、配置化 Page Insights，以及公开评论导入现有互动/线索/人工交接流程。
- 真实模型调用的事务性用量预占、成功结算和失败释放；登录失败按哈希后的邮箱/IP 键限速。
- provider/platform/capability Adapter Registry；没有实现的 provider 会明确失败或转人工任务，不会静默降级成模拟成功。
- 本地磁盘与 S3-compatible `StorageAdapter`；上传和 Facebook 媒体发布使用流，不把完整文件读入内存。
- `ffprobe` 媒体元数据检查（安装时启用，缺失时明确标为不可用）；IANA 时区排期和 DST 非法本地时间拒绝。
- worker 在长外部请求期间续租；失去租约时不会写入最终发布结果，发布后超时继续保持 `UNKNOWN`。
- 结构化 `BrandProfile` 与旧 `brandGuidelines` 兼容回退；品牌、最近内容、表现和研究记忆全部来自 PostgreSQL 权威记录。
- 阶段化内容生成上下文、策略、结构校验、AI review、humanizer/shortener 和 image-prompt 接口；输出仍是待人工审核的 `ContentVersion`，不会创建审批或发布任务。
- 内容组合服务支持单平台重生成、结构化改写、乐观并发草稿保存、不可变版本恢复/比较；任何实质改写都会创建新的 `ContentVersion`。
- 品牌资料可从粘贴文本、工作区资料和结构化输入生成经 Zod 验证的 transient 建议；只有人工明确接受的字段才会写入 `BrandProfile`，完整度由程序按关键字段计算。
- 审批协作支持结构化 `Request Changes`、版本化修订和基于版本/审批/评论/审计/发布任务组合的时间线；不提供平行聊天或审批系统。
- 素材库支持租户范围搜索、过滤、标签、SHA-256 重复检测、真实使用关系查询和统一公网可用性分类；`Asset` 仍是唯一素材事实源。
- 基于现有内容/审批/发布记录的月、周、列表日历与服务层重排；没有第二套 scheduler。
- 账号排期队列支持有限 horizon 的每周时段、下一可用槽位、冲突检测和逐项结果的批量重排；最终排期仍写入 `ContentItem` / `PublishJob` 并经过原审批与账号验证。
- 基于 `MetricSnapshot` 的 canonical metrics、周期比较和 freshness；缺失、失败和无权限继续与真实 0 分开。
- Analytics 查询支持平台/账号/内容/指标范围、最新快照、帖子/账号/周期比较、内容表现排序、最小样本模式分析和统一数据健康状态；AI review 只能读取程序结果并明确不推断因果。
- 站内通知后的 Webhook/Email HTTP 投递记录；外部投递失败保留 `NotificationDelivery` 失败证据且不回滚主业务。
- 通知规则使用有限事件 registry，支持 IN_APP/EMAIL/WEBHOOK 选择、cooldown 去重和 unread/important/all Inbox API；规则和读状态均为租户范围。

## 当前模拟

- 无模型凭据时的英文平台草稿，始终带 `[SIMULATED GENERATION]` 与数据库模拟标记。
- 演示客户的发布适配器和远端 ID/URL。
- 演示客户的指标快照。
- 演示产品只存在于演示客户；正式客户不会继承这些数据。

## 已实现但仍需专用测试 Page 做外部验收

- Facebook Page 真实连接、发布、查询、帖子指标和公开评论读取代码已经实现；本地纯单元与 PostgreSQL 集成测试已通过。在提供专用测试 Page 凭据前，不声称已完成 Meta 外部连接验收。
- Page Insights 名称由设置页配置。Meta 会弃用或限制指标，系统只把 API 成功返回的数字（包括 0）保存为 `AVAILABLE/REAL`。

## 尚未实现的真实连接

- TikTok、LinkedIn 真实账号、发布、结果查询、指标和评论接口。
- Instagram adapter、账号发现和发布/查询安全边界已经实现，但仍为 `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`，没有执行真实 Instagram external acceptance。
- Facebook 私信自动采集、自动回复、自动私信和自动报价。
- Facebook 群组自动检索、入群或发帖；当前只能创建人工任务。
- Webhook/Email 外部通知端点需要单独配置和验证；未配置时只保存站内通知和任务，不声称已送达。
- 图片生成与 WordPress 草稿写入；已有明确的受限适配器接口和配置状态。
- 自动客户回复、私信、报价和广告投放不存在可执行路径。

## 正式客户需要补充

- 主推常规产品以及每个型号的材质、尺寸、供货范围、MOQ/交期（如允许对外使用）和对应素材。
- 候选目标国家、经销商/批发商画像、品牌语气、禁用表达和可公开联系方式。
- 四个平台账号建立后的账号 ID 与逐项能力验证结果。
- 网站与 WhatsApp 地址；至少一个紧急通知通道。
- 决定使用的文本模型凭据；凭据只放服务器环境或密钥系统，数据库仅保存引用名。

## Meta OAuth 服务器配置

先生成一个只保存在服务器环境中的 32-byte vault key。例如 PowerShell：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

把输出放入本地 `.env` 的 `TOKEN_ENCRYPTION_KEY`，不要提交或粘贴到前端。配置 Meta App：

```dotenv
TOKEN_ENCRYPTION_KEY=""
TOKEN_ENCRYPTION_KEY_VERSION="v1"
META_APP_ID=""
META_APP_SECRET=""
META_REDIRECT_URI="http://localhost:3000/api/connections/meta/callback"
META_LOGIN_CONFIG_ID=""
META_OAUTH_SCOPES="pages_show_list,pages_manage_posts,pages_read_engagement,pages_read_user_content,instagram_basic,instagram_content_publish"
META_GRAPH_API_VERSION="v26.0"
META_PAGE_METRIC_KEYS=""
```

Meta App 的 Valid OAuth Redirect URI 必须与 `META_REDIRECT_URI` 完全一致。登录工作台后进入“平台连接”，点击“连接 Meta”，完成授权后明确勾选允许用于当前客户的 Page。发现的账号默认不启用，也不会按列表第一个账号自动选择。

OAuth 连接完成后，发布、远端状态查询、帖子真实计数和公开评论导入复用 V1 现有业务服务。若 Meta 没有提供 refresh token，“刷新”会明确要求重新授权。

### Instagram Professional 发布

同一 Meta OAuth 会发现 Facebook Page 关联的 Instagram Professional 账号。只有显式选择、拥有 `instagram_basic` 与 `instagram_content_publish`、且发布能力验证通过的账号才能进入 LIVE 队列。当前实现支持单图、单视频/Reels 和 2–10 项 carousel，并可通过远端 media ID 查询发布状态。

Instagram Graph API 必须能够主动拉取素材，因此素材 URL 必须是公网可达的 HTTPS URL。本地文件存储会在网络请求前以 `MEDIA_URL_UNAVAILABLE` 拒绝；生产环境应使用能够生成 HTTPS signed URL 的 S3-compatible storage。任何容器创建或 `media_publish` 写请求都不会自动重试；写请求超时、连接中断或无法确认的 5xx 会进入 `UNKNOWN` 并要求远端查询或人工对账。

当前状态：`IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`。本阶段没有执行真实 Instagram 发布，不能将其标记为 Production Ready；需要专用 Instagram Professional 测试账号完成 external acceptance。

## V1 手工 Facebook Page fallback

仅在迁移期或专用测试 Page 使用旧入口：

```powershell
FACEBOOK_GRAPH_API_VERSION="v26.0"
FACEBOOK_TEST_PAGE_ID="1234567890"
FACEBOOK_TEST_PAGE_ACCESS_TOKEN="" # 只在服务器注入真实值，不提交 Git
FACEBOOK_GRAPH_BASE_URL="https://graph.facebook.com"
FACEBOOK_REQUEST_TIMEOUT_MS="30000"
```

登录设置页，选择 `facebook` 账号，保存 `Page ID` 与 `env:FACEBOOK_TEST_PAGE_ACCESS_TOKEN` 引用，然后点击“连接并验证 Page”。默认校验 `pages_manage_posts`、`pages_read_engagement`、`pages_read_user_content` 和 Page 的 `CREATE_CONTENT` 任务；指标和评论能力还分别显示 `ANALYZE`、`MODERATE` 的验证结果。

只有客户模式为 `LIVE`、连接和令牌有效、当前内容版本已批准且产品资料版本未变化时，worker 才会调用 Graph API。请求超时或 5xx 无法确认结果时写入 `UNKNOWN`，禁止自动重发；有远端 ID 时可查询，没有远端 ID 时只能人工对账。

## 专用测试 Page 真实验收

真实发帖有显式保护，并固定使用独立数据库客户 `facebook-phase2-test`，不会使用演示客户或正式客户：

```powershell
$env:FACEBOOK_LIVE_E2E_CONFIRM="YES_PUBLISH_TO_DEDICATED_TEST_PAGE"
$env:FACEBOOK_LIVE_E2E_STAGE="publish"
pnpm facebook:live:e2e
```

脚本创建并上传一张本地生成的测试 PNG，生成带 `[PHASE2 TEST]` 的草稿、人工批准记录、真实发布一次、重复排期校验、远端状态查询和帖子真实计数读取。成功后，在输出的测试帖下由人工评论：

```text
[PHASE2 TEST] Please send your wholesale catalog and MOQ.
```

再运行：

```powershell
$env:FACEBOOK_LIVE_E2E_STAGE="complete"
pnpm facebook:live:e2e
```

第二步只读取公开评论，创建现有线索和人工任务，并把该测试任务记录为人工交接完成。系统没有自动回复、私信或报价路径。

OAuth 路径还需额外验收：连接测试用户、回调一次性消费、Page 列表与任务、明确选择账号、断开后本地密文清除、过期 token、权限不足和授权取消。没有专用 Meta 凭据时，只能验证本地安全边界，不能宣称真实 OAuth 已通过。

## 存储与媒体检查

默认 `STORAGE_PROVIDER=local`。S3-compatible 模式需要设置 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`，可选 `S3_SESSION_TOKEN`。当前实现使用 SigV4 预签名 GET；在目标对象存储上验收前不宣称兼容所有供应商。

安装 `ffprobe` 后设置 `FFPROBE_PATH`，系统可提取视频时长、宽高和音视频 codec。没有安装时上传不会伪造元数据，检查结果会明确标为不可用。

## 常用验证命令

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm worker:once
pnpm demo:e2e
pnpm facebook:live:e2e # 仅在专用测试 Page + 显式确认后
```

上传格式仅允许经文件签名字节识别的 PNG、JPEG、WebP、MP4 和 QuickTime；声明的浏览器 MIME 不作为信任依据。Facebook LIVE 进一步限制为 PNG、JPEG、MP4 或 QuickTime 单文件。`JOB_LOCK_TIMEOUT_SECONDS` 应高于发布适配器自身 30 秒超时，本地默认 60 秒。

## CI

`.github/workflows/ci.yml` 在 PR、`main` 和 `feat/**` push 上使用临时 PostgreSQL，依次执行迁移、typecheck、测试和 build。CI 只使用不可用于任何外部系统的测试占位值，不依赖仓库 Secret 才能验证本地边界。

V2 Phase 1 本地验证（2026-09-20）：5 个 migration 在全新 PostgreSQL 17-alpine 数据库成功应用，seed 连续执行两次成功，`pnpm test` 的 10 个测试文件共 74 项通过，`pnpm typecheck` 与 `pnpm build` 通过。GitHub Actions 仍需在分支推送后单独确认，Meta 和 S3 外部边界仍未验证。

Core capability expansion 本地验证（2026-09-23）：10 个 migration 均已应用且 `prisma migrate status` 为 up to date，seed 连续执行两次成功，`pnpm test` 的 21 个测试文件共 165 项通过，`pnpm typecheck`、production build 与 `git diff --check` 通过。分支没有修改 UI 或依赖文件，`.env` 仍被忽略且未跟踪；Instagram 保持 `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`。GitHub Actions 结果以对应 PR 的远程检查为准。

## V1 历史验收（2026-09-16）

- PostgreSQL 17.11：三份迁移成功应用，种子连续执行两次无重复记录。
- `pnpm typecheck`：通过。
- `pnpm test`：2 个测试文件、30 项通过；覆盖审批撤销、原子发布门禁、租约续期、资料版本失效、并发幂等、历史未知结果对账、恢复、客户隔离、事实来源、互动去重、模拟/真实区分和恶意文件等关键风险。
- `pnpm build`：Next.js production build 成功，包含 25 个页面/API 路由和 Proxy。
- `pnpm demo:e2e`：完成素材 → 四平台草稿 → 审核 → 模拟发布 → 互动 → 线索交接 → 指标 → 复盘；最终运行 ID `574f8093`，四项发布均为带模拟标记的 `PUBLISHED`。
- production server：在 `http://localhost:3015` 实测登录页 200、登录后工作台 200，返回 CSP、`DENY` frame 和 `nosniff` 安全头。
- `pnpm audit --prod`：npm 漏洞数据库返回无已知漏洞。

以上是 V1 baseline 的历史结果；当前 V2 分支的本地迁移、测试、typecheck 与 build 结果见上一节。它们不代表 GitHub Actions、Meta 或 S3 外部验收已经通过。

详细上游核查见 [docs/upstream-audit.md](docs/upstream-audit.md)，架构决策见 [docs/decisions/0001-architecture.md](docs/decisions/0001-architecture.md)。

V2 Phase 1 执行状态见 [docs/exec-plans/active/v2-phase1-connection-layer.md](docs/exec-plans/active/v2-phase1-connection-layer.md)，连接层决策见 [ADR 0003](docs/decisions/0003-platform-connection-layer.md)、[ADR 0004](docs/decisions/0004-token-vault.md) 和 [ADR 0005](docs/decisions/0005-adapter-registry.md)，Meta 接口依据见 [docs/facebook-graph-reference.md](docs/facebook-graph-reference.md)。
