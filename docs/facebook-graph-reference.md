# Facebook Graph API 第二阶段接口依据

- 核查日期：2026-09-17
- 实现默认版本：`v26.0`，可通过连接配置调整
- 范围：Facebook Page，不含群组、私信、自动回复和广告

## 官方来源与采用内容

1. [Meta 官方 Instagram API Postman collection：Page access tokens](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
   - `/{api_version}/me/accounts?fields=name,access_token,tasks` 可列出用户管理的 Page、Page access token 与任务。
   - `/{page_id}?fields=name,access_token` 可获取指定 Page 信息。
   - Page access token 代表 Page 调用 Graph API。本项目不保存 collection 示例中的 token，只保存服务器环境变量引用。
2. [Meta Pages API：Page posts](https://developers.facebook.com/docs/pages-api/posts/)
   - 文本帖子使用 Page feed 发布边界；内容仍必须先经过本项目数据库审批门禁。
3. [Meta Pages API：Page photos](https://developers.facebook.com/docs/graph-api/reference/page/photos/)
   - 单图发布使用 `/{page_id}/photos`，本项目采用 multipart `source` 与 `caption`，保存返回的 `post_id`（存在时）或 `id`。
   - 官方文档列出的核心权限包括 `pages_manage_posts` 和 `pages_read_engagement`；Page token 对应人员还需具备内容创建任务。
4. [Meta Graph API：Page insights](https://developers.facebook.com/docs/graph-api/reference/page/insights/)
   - 指标通过 `/{page_id}/insights` 读取。指标可用性会随版本、Page 规模和权限变化，因此名称保存在连接配置中，不在业务代码写死为保证可用。
5. [Meta Graph API：Object comments](https://developers.facebook.com/docs/graph-api/reference/object/comments/)
   - 公开帖子评论按远端帖子 ID 读取并使用评论 ID 去重。本项目只导入，不实现评论回复。

Meta 开发者文档在核查时对部分直接请求返回限流页面；以上端点同时通过 Meta 官方 Postman collection 的当前内容交叉核对。实现不会把“源码可见”或文档示例解释为绕过 App Review、Page 任务或权限审批。

## 本项目映射

| 能力 | Graph 边界 | 本地权威状态 |
| --- | --- | --- |
| 连接验证 | Page identity、token permissions、Page tasks | `FacebookPageConnection` + `SocialAccount` capability |
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
