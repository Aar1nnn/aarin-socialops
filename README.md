# 海外社媒 AI 运营工作台（第一阶段）

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
6. 生成模拟指标和报告；页面持续标注“模拟”，缺失/不支持/读取失败不会显示为 0。

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

## 当前模拟

- 无模型凭据时的英文平台草稿，始终带 `[SIMULATED GENERATION]` 与数据库模拟标记。
- 演示客户的发布适配器和远端 ID/URL。
- 演示客户的指标快照。
- 演示产品只存在于演示客户；吕总客户没有继承这些数据。

## 尚未验证/未实现的真实连接

- Facebook、Instagram、TikTok、LinkedIn 真实账号、发布、结果查询、指标、评论和私信接口。
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

## 下一阶段首个真实连接

优先建立一个测试 Facebook Page，并用 Postiz API 作为候选适配器完成“小范围、人工批准、可查询结果”的沙盒验证。验收必须同时覆盖：账号能力探测、上传素材、创建帖子、超时后按本地幂等键/远端记录对账、拉取真实指标。通过后再扩展其他平台；Postiz 的 AGPL 部署义务需同时复核。

## 常用验证命令

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm worker:once
pnpm demo:e2e
```

上传格式仅允许经文件签名字节识别的 PNG、JPEG、WebP、MP4 和 QuickTime；声明的浏览器 MIME 不作为信任依据。`JOB_LOCK_TIMEOUT_SECONDS` 应高于发布适配器自身 30 秒超时，本地默认 60 秒。

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
