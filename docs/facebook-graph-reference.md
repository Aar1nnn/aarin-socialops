# Meta OAuth 与 Facebook Graph API 接口依据

- 核查日期：2026-09-17
- 实现默认版本：`v26.0`，通过 `META_GRAPH_API_VERSION` 配置
- 范围：Facebook Page，不含群组、私信、自动回复和广告

## 官方来源与采用内容

1. [Meta 官方 Facebook API Postman workspace](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api)
   - 官方 collection 由 Meta 维护，用于交叉核对 Graph API 请求结构；它不是权限审批的替代品。
2. [Meta 官方 Instagram API Postman request：Get access tokens of Pages you manage](https://www.postman.com/meta/instagram/request/0vuw3vk/get-access-tokens-of-pages-you-manage)
   - `/{api_version}/me/accounts?fields=name,access_token,tasks` 可列出用户管理的 Page、Page access token 与任务。
   - 可同时读取 `instagram_business_account`，用于发现与 Page 关联的 Instagram 专业账号；V2 Phase 1 不启用 Instagram 发布。
   - Page access token 代表 Page 调用 Graph API。本项目以 AES-256-GCM 加密后保存在数据库，不写入日志、前端或 Git。
3. [Meta Pages API：Page posts](https://developers.facebook.com/docs/pages-api/posts/)
   - 文本帖子使用 Page feed 发布边界；内容仍必须先经过本项目数据库审批门禁。
4. [Meta Pages API：Page photos](https://developers.facebook.com/docs/graph-api/reference/page/photos/)
   - 单图发布使用 `/{page_id}/photos`，本项目采用 multipart `source` 与 `caption`，保存返回的 `post_id`（存在时）或 `id`。
   - 官方文档列出的核心权限包括 `pages_manage_posts` 和 `pages_read_engagement`；Page token 对应人员还需具备内容创建任务。
5. [Meta Graph API：Page insights](https://developers.facebook.com/docs/graph-api/reference/page/insights/)
   - 指标通过 `/{page_id}/insights` 读取。指标可用性会随版本、Page 规模和权限变化，因此名称保存在连接配置中，不在业务代码写死为保证可用。
6. [Meta Graph API：Object comments](https://developers.facebook.com/docs/graph-api/reference/object/comments/)
   - 公开帖子评论按远端帖子 ID 读取并使用评论 ID 去重。本项目只导入，不实现评论回复。

Meta 开发者文档在 2026-09-19 核查时对部分直接请求返回 HTTP 429，因此不能声称已完整读取全部页面；可访问部分已通过 Meta 官方 Postman workspace 的当前内容交叉核对。实现不会把文档示例解释为绕过 App Review、业务验证、Page 任务或权限审批。

## OAuth 安全边界

- 授权入口：`/api/connections/meta/start`；回调地址必须与 Meta App 配置及 `META_REDIRECT_URI` 完全一致。
- `state` 使用随机值，数据库只保存 SHA-256 摘要；有效期 10 分钟且回调原子消费一次。
- 授权码只在服务器端换取 token，不写数据库、不记录日志、不返回前端。
- User token、Page token 分别加密；密钥由服务器环境变量 `TOKEN_ENCRYPTION_KEY` 提供，数据库仅保存密文、IV、认证标签和密钥版本。
- 账号发现后默认不选中。运营者必须明确选择 Page，才会启用对应 capability。
- 断开连接时先尽力调用远端撤销，再清除本地密文；远端撤销失败不会阻止本地凭据清除。
- Meta 当前连接路径没有可靠 refresh token 时，刷新操作明确返回“不支持”，要求重新连接，不伪装为已刷新。

## 本项目映射

| 能力 | Graph 边界 | 本地权威状态 |
| --- | --- | --- |
| OAuth 连接 | 授权码交换、`/me`、`/me/permissions` | `OAuthState` + `PlatformConnection` |
| 账号发现与选择 | `/me/accounts`、Page tasks | `SocialAccount` capability；默认未选择 |
| V1 fallback 验证 | Page identity、token permissions、Page tasks | `FacebookPageConnection` + 环境变量引用 |
| 文字发布 | `/{page_id}/feed` | `PublishJob` / `PublishAttempt` |
| 图片发布 | `/{page_id}/photos` | 内容版本绑定的单张素材 |
| 视频发布 | `/{page_id}/videos` | 内容版本绑定的单个已剪辑视频 |
| 状态查询 | `/{remote_post_id}` fields | 远端 ID、链接、发布时间、最后查询时间 |
| 帖子计数 | comments/reactions summary | `MetricSnapshot`，`REAL` 且保留 0 |
| Page Insights | `/{page_id}/insights?metric=...` | 配置化 metric key 与可用性 |
| 评论导入 | `/{remote_post_id}/comments` | `Interaction` → `Lead` → `ManualTask` |

## 已知平台限制

- Graph API 没有本项目可依赖的 Page 发帖业务幂等键。系统以本地唯一任务防重；请求超时、连接中断或 5xx 后不能确认结果时使用 `UNKNOWN`，不自动重复 POST。
- Page Insights 可能要求 Page 达到平台阈值，且大量历史指标会被弃用。没有返回的指标记录为不可用状态，不写入伪造数值。
- 读取评论取决于 App 权限、Page 任务、帖子可见性和 API 支持；系统不承诺全量评论或私信。
- App Review、业务验证、测试 Page 权限、真实发布、真实指标和评论读取仍需要外部环境验收；本地测试只能验证边界和错误处理。
