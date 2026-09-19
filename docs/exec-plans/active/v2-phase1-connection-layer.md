# V2 Phase 1：连接层与可靠性升级执行计划

## 目标

在不改变 V1 审批、版本、幂等、客户隔离和人工交接规则的前提下，把平台连接从手工环境变量升级为可审计的 OAuth 连接层，并补齐账号选择、凭据加密、worker 租约续期、存储抽象、媒体检查、真实排期和 CI。

## 不变量

- 对外发布必须绑定当前内容版本、具体账号和有效人工批准。
- `UNKNOWN` 结果不得自动重发；只能查询或人工对账。
- 所有业务查询必须由服务端 `clientId` 作用域约束。
- 外部文本和平台响应只作为数据，不得改变审批或权限规则。
- 不实现自动私信、自动回复、自动报价、Facebook 群组自动化、LinkedIn/TikTok 真实连接。
- 不在日志、数据库明文、前端或 Git 中保存 token、app secret、授权码或 session secret。

## 交付阶段

1. **安全门与架构审计**：确认 baseline、仓库可见性、V1 边界、隐私内容和官方 Meta 资料来源。
2. **连接数据层**：新增 `PlatformConnection`、`OAuthState` 和账号连接字段；只提交向前迁移。
3. **Token Vault 与 OAuth**：AES-256-GCM 凭据封装、一次性 state、Meta OAuth、账号发现与选择。
4. **发布边界**：Adapter Registry、账号级目标、未支持能力的人工任务、V1 fallback。
5. **可靠性**：worker heartbeat、统一错误分类、重试安全、真实排期与时区转换。
6. **素材与运行基建**：StorageAdapter、本地/S3-compatible 实现、MediaInspector、生产 seed 保护。
7. **界面、CI 与文档**：连接页、账号选择、排期页、CI、环境变量、隐私和外部验收清单。
8. **质量门禁**：迁移、typecheck、测试、build、diff/安全审查。

## 当前状态

- [x] Git baseline `v0.1-baseline` 保留，工作分支为 `feat/v2-connection-layer`。
- [x] GitHub 仓库已恢复为 Private。
- [x] V1 核心服务、数据库模型、worker、Facebook 适配器、路由和测试已审计。
- [x] 当前分支文件已匿名化；baseline Git 历史仍含旧客户称呼，不重写历史以保留审计基线，仓库保持 Private。
- [x] 基线 `pnpm typecheck` 通过。
- [x] Docker Desktop 与 PostgreSQL 17-alpine 已恢复；全新数据库健康检查通过。
- [x] `PlatformConnection`、`OAuthState`、账号级加密 token 与向前 migration。
- [x] Meta OAuth adapter、一次性 state、账号发现/选择、断开和不支持 refresh 的明确边界。
- [x] account target、Adapter Registry、V1 fallback、远端查询/指标/评论复用。
- [x] worker heartbeat、统一重试安全类别、UTC 排期与 IANA timezone 转换。
- [x] Local/S3-compatible StorageAdapter、流式发布、ffprobe 媒体元数据。
- [x] 必要连接 UI、CI workflow、三份 ADR、外部验收清单和 README。
- [x] `pnpm db:generate`、Prisma schema validate、5 个 migration、双次幂等 seed、`pnpm typecheck`、10 个测试文件 74 项测试、`pnpm build`。
- [x] OAuth state、客户隔离、双 Facebook 账号目标、worker heartbeat、有限重试与 `UNKNOWN` 安全规则已在 PostgreSQL 集成测试中通过。
- [ ] GitHub Actions CI：workflow 已实现，分支未获授权 push，因此尚无远端运行结果。
- [ ] Meta 真实外部验收：没有专用 App credentials/测试 Page，状态为 `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`。

## 外部资料核查

- 2026-09-19 访问 Meta for Developers 参考页时返回 HTTP 429，不能声明已完整读取这些页面。
- Meta 官方 Postman 工作区可访问并确认：`GET /{version}/me/accounts` 使用 User Access Token 返回可管理 Page、Page access token、tasks；Instagram with Facebook Login 可通过 `instagram_business_account` 发现关联专业账号。
- OAuth 权限、App Review、业务验证和真实 Page 能力仍必须在专门测试资产上做外部验收，代码完成不等于平台验证完成。

## 验收命令

```powershell
pnpm db:generate
pnpm db:migrate
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

## 已知风险

- baseline Git 历史含客户称呼。为保持 `v0.1-baseline` 可审计，本阶段不改写历史；仓库保持 Private。若未来公开，必须在明确授权下清洗历史并重新建立 tag。
- 本地数据库验证已通过，但尚未在非本机的 PostgreSQL 环境执行兼容性验证。
- Meta 官方文档直连受 429 限制；实现采用可配置 API 版本，并把真实平台行为列入外部验收。
- S3-compatible 预签名实现已通过静态/单元边界检查，但没有目标对象存储凭据，尚未做外部兼容性验收。
