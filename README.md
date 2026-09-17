# 海外社媒 AI 运营工作台（第二阶段：Facebook Page）

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

访问 <http://localhost:3000>。本地种子账号默认是 `operator@example.local` / `change-this-local-password`；仅用于开发，使用前请在 `.env` 修改。目录名含非 ASCII 字符时必须给 Compose 显式项目名 `-p socialops`。

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
- Facebook Page 非敏感连接配置、Page/权限/任务验证、令牌状态和错误建议；令牌只通过服务器 `env:FACEBOOK_...` 引用读取。
- Facebook Page 纯文字、单张 PNG/JPEG、单个 MP4/QuickTime 真实发布，远端 ID/链接/发布时间保存和状态查询。
- Facebook 帖子评论/回应真实计数、配置化 Page Insights，以及公开评论导入现有互动/线索/人工交接流程。
- 真实模型调用的事务性用量预占、成功结算和失败释放；登录失败按哈希后的邮箱/IP 键限速。

## 当前模拟

- 无模型凭据时的英文平台草稿，始终带 `[SIMULATED GENERATION]` 与数据库模拟标记。
- 演示客户的发布适配器和远端 ID/URL。
- 演示客户的指标快照。
- 演示产品只存在于演示客户；吕总客户没有继承这些数据。

## 已实现但仍需专用测试 Page 做外部验收

- Facebook Page 真实连接、发布、查询、帖子指标和公开评论读取已经实现并通过本地 stub/数据库测试；在提供专用测试 Page 凭据前，不声称已完成 Meta 外部连接验收。
- Page Insights 名称由设置页配置。Meta 会弃用或限制指标，系统只把 API 成功返回的数字（包括 0）保存为 `AVAILABLE/REAL`。

## 尚未实现的真实连接

- Instagram、TikTok、LinkedIn 真实账号、发布、结果查询、指标和评论接口。
- Facebook 私信自动采集、自动回复、自动私信和自动报价。
- Facebook 群组自动检索、入群或发帖；当前只能创建人工任务。
- 紧急外部通知；未配置时只保存站内通知和任务，不声称已送达。
- 图片生成、WordPress 草稿写入、对象存储；已有明确的受限适配器接口和配置状态。
- 自动客户回复、私信、报价和广告投放不存在可执行路径。

## 吕总需要补充

- 主推常规产品以及每个型号的材质、尺寸、供货范围、MOQ/交期（如允许对外使用）和对应素材。
- 候选目标国家、经销商/批发商画像、品牌语气、禁用表达和可公开联系方式。
- 四个平台账号建立后的账号 ID 与逐项能力验证结果。
- 网站与 WhatsApp 地址；至少一个紧急通知通道。
- 决定使用的文本模型凭据；凭据只放服务器环境或密钥系统，数据库仅保存引用名。

## Facebook Page 服务器配置

在服务器 `.env` 中设置专用测试 Page，而不是吕总正式 Page：

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

真实发帖有显式保护，并固定使用独立数据库客户 `facebook-phase2-test`，不会使用演示客户或吕总客户：

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

## 已执行验收（2026-09-16）

- PostgreSQL 17.11：三份迁移成功应用，种子连续执行两次无重复记录。
- `pnpm typecheck`：通过。
- `pnpm test`：2 个测试文件、30 项通过；覆盖审批撤销、原子发布门禁、租约续期、资料版本失效、并发幂等、历史未知结果对账、恢复、客户隔离、事实来源、互动去重、模拟/真实区分和恶意文件等关键风险。
- `pnpm build`：Next.js production build 成功，包含 25 个页面/API 路由和 Proxy。
- `pnpm demo:e2e`：完成素材 → 四平台草稿 → 审核 → 模拟发布 → 互动 → 线索交接 → 指标 → 复盘；最终运行 ID `574f8093`，四项发布均为带模拟标记的 `PUBLISHED`。
- production server：在 `http://localhost:3015` 实测登录页 200、登录后工作台 200，返回 CSP、`DENY` frame 和 `nosniff` 安全头。
- `pnpm audit --prod`：npm 漏洞数据库返回无已知漏洞。

本次主机的 Docker Desktop daemon 因其用户目录内既有的损坏 reparse point 无法启动，因此 Compose 路径没有在本机完成运行验证；同一迁移、种子、测试、构建和 HTTP 验收均改用独立的 PostgreSQL 17.11 临时实例完成。该限制不影响已提交的 Compose 配置，但不能表述为“Compose 已验证”。

详细上游核查见 [docs/upstream-audit.md](docs/upstream-audit.md)，架构决策见 [docs/decisions/0001-architecture.md](docs/decisions/0001-architecture.md)。

第二阶段执行状态见 [docs/exec-plans/active/phase-2-facebook-page.md](docs/exec-plans/active/phase-2-facebook-page.md)，Facebook 边界决策见 [docs/decisions/0002-facebook-live-boundary.md](docs/decisions/0002-facebook-live-boundary.md)，Meta 接口依据见 [docs/facebook-graph-reference.md](docs/facebook-graph-reference.md)。
