# Meta External Acceptance

## Goal

在专用测试资产上验证现有 Meta 连接层的真实外部链路，不新增平台、不改变既有审批、发布幂等、客户隔离和人工交接规则。

本记录只保存非敏感状态与证据索引。不得写入 App Secret、access token、OAuth code、Cookie、Page access token 或加密密钥。

## Environment

- Repository branch: `feat/meta-external-acceptance`
- Preflight date: 2026-09-20
- Application: local Next.js application and PostgreSQL
- Meta Graph API target: `v26.0`
- OAuth callback transport: `VERIFIED_LOCAL_DEVELOPMENT`
  - 本地回调为 `http://localhost:3000/api/connections/meta/callback`，已通过一次完整 OAuth redirect/callback 实测。
  - Meta Dashboard 的 URI Validator 对开发模式 localhost 仍显示无效，但真实授权、state 校验与 callback 已成功；本轮没有创建公网隧道。

### Required local configuration status

| Variable | Status |
| --- | --- |
| `META_APP_ID` | `CONFIGURED` |
| `META_APP_SECRET` | `CONFIGURED` |
| `META_REDIRECT_URI` | `CONFIGURED_AND_CALLBACK_VERIFIED` |
| `META_GRAPH_API_VERSION` | `CONFIGURED` |
| `META_OAUTH_SCOPES` | `CONFIGURED` |
| `META_AUTH_BASE_URL` | `CONFIGURED` |
| `META_GRAPH_BASE_URL` | `CONFIGURED` |
| `META_REQUEST_TIMEOUT_MS` | `CONFIGURED` |
| `TOKEN_ENCRYPTION_KEY` | `CONFIGURED_VALID_32_BYTES` |
| `TOKEN_ENCRYPTION_KEY_VERSION` | `CONFIGURED` |

`.env` 存在且被 Git 忽略；上表只记录存在性与格式状态，没有记录任何 Secret、token 或密钥值。旧版 Facebook Page 测试引用仍在本地配置中，但本次连接使用新的 OAuth 配置与加密 Token Vault。

## Test assets

- Dedicated Facebook Page: `READY_BY_EXISTING_EVIDENCE`
  - 已有专用测试 Page 与旧版 Graph API 连接配置证据。
  - 正式验收时仍须确认 OAuth 授权返回的是该专用 Page，禁止选择真实客户 Page。
- Meta Developer App: `READY_AND_OAUTH_VERIFIED`
  - 已配置 Facebook Login for Business configuration、用户访问令牌流程和所需 Page 权限。
  - OAuth 实测已返回 Page 管理 scopes，并发现专用测试 Page。
- Linked Instagram Professional account: `REQUIRED_FOR_DISCOVERY_ACCEPTANCE`
  - 如要完成“关联 Instagram 账号发现”验收，必须先把一个专用 Instagram Professional account 关联到测试 Page。

## Current implementation status

### Browser to Graph API flow

1. 已登录运营者从“平台连接”页面发起 `POST /api/connections/meta/start`。
2. 服务端生成随机 OAuth state，只保存 SHA-256 摘要，并绑定 `clientId`、`userId`、provider、redirect URI 和 10 分钟有效期。
3. 浏览器被重定向到 Meta authorization endpoint。
4. Meta 回调 `GET /api/connections/meta/callback`；服务端在事务中校验并一次性消费 state，拒绝过期、重放、跨客户和跨用户请求。
5. 服务端用 code、App Secret 和完全相同的 redirect URI 换取用户令牌。
6. `MetaAuthAdapter` 调用 `/me`、`/me/permissions` 和 `/me/accounts`，发现 Page、Page access token、Page tasks 与可选的 `instagram_business_account`。
7. `TokenVault` 使用 AES-256-GCM 保存用户令牌和 Page 令牌；数据库与前端响应不保存明文令牌。
8. 发现的账号默认未选中、能力未验证；运营者必须明确选择专用测试 Page。
9. LIVE 发布仍经过最新内容版本、产品资料版本、账号绑定和人工批准门禁。
10. Worker 通过 `AdapterRegistry` 解析 `META/facebook/PUBLISH`，再由 `FacebookGraphAdapter` 调用 Graph API；远端不确定结果进入 `UNKNOWN`，禁止自动重发。

### Status

- Meta OAuth: `EXTERNALLY_VERIFIED`
- Page discovery: `EXTERNALLY_VERIFIED`
- Instagram linked-account discovery: `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`
- Meta Facebook publishing adapter: `TEXT_PUBLISH_EXTERNALLY_VERIFIED`
- S3: `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`
- Real social publishing: `EXECUTED_DEDICATED_TEST_PAGE`

## Manual prerequisites

1. 在 Meta Developer 后台打开专用测试应用，确认当前操作账号拥有该 App 的管理员、开发者或测试者角色，并保持开发模式用于专用资产验收。
2. 在“管理公共主页”用例中确认以下权限均处于可测试状态：`pages_show_list`、`pages_manage_posts`、`pages_read_engagement`、`pages_read_user_content`。不要增加自动私信、群组发布或自动回复权限。
3. 确认测试 Facebook Page 只用于验收，当前操作账号具有创建内容、分析和管理互动所需的 Page tasks。不要授权任何真实客户 Page。
4. 如需验收 Instagram linked-account discovery，把专用 Instagram Professional account 关联到测试 Page；普通个人 Instagram 账号不满足该发现链路。
5. 在 Meta Login / Facebook Login for Business 设置中，用系统最终选定的 callback URL 配置或验证 Valid OAuth Redirect URI，必须与 `META_REDIRECT_URI` 完全一致。先在 Meta 后台验证本地回调；若当前应用拒绝 `localhost`，再由用户决定是否使用 HTTPS tunnel。
6. 仅在本机 `.env` 配置 `META_APP_ID`、`META_APP_SECRET`、`META_REDIRECT_URI`、Graph API 版本、OAuth scopes、Meta base URLs、请求超时和 Token Vault key/version。Secret 与密钥不得粘贴到聊天、日志、数据库或 Git。
7. 如果应用使用 Facebook Login for Business configuration，配置相应的 `META_LOGIN_CONFIG_ID`；否则由现有 scope 参数路径发起授权。两种路径不得混用未验证配置。
8. 配置完成后重启 web 与 worker，再开始 OAuth Stage 1；本预检阶段不执行授权。

## Acceptance stages

| Stage | Purpose | Status |
| --- | --- | --- |
| 0 | Repository, implementation, official-source and local-config preflight | `COMPLETED` |
| 1 | OAuth redirect, callback, state validation and code exchange | `PASS` |
| 2 | Page and linked Instagram account discovery | `PAGE_PASS_INSTAGRAM_NOT_DISCOVERED` |
| 3 | Manual Page selection and capability verification | `PASS` |
| 4 | Test content creation and human approval | `PASS` |
| 5 | One real publish to the dedicated test Page | `PASS_ON_AUTHORIZED_SECOND_ATTEMPT` |
| 6 | Remote status query, metric read and test-comment import | `PASS` |
| 7 | Interaction, lead, manual-task and disconnect verification | `PASS` |

## Evidence

### Repository evidence

- Branch at preflight: `feat/meta-external-acceptance`
- Starting commit: `7fbbb95`
- Starting working tree: clean
- Preserved tags: `v0.1-baseline`, `v0.2-connection-layer`
- Existing automated verification record: 12 test files / 82 tests, typecheck and production build passed before this phase.

### Official Meta evidence checked on 2026-09-20

- Official Meta Facebook API Postman collection documents `GET /{api_version}/me/accounts?fields=name,access_token,tasks` for Page discovery and Page access tokens.
- The current official collection example includes `PROFILE_PLUS_*` task names. Existing `normalizePageTasks()` removes that prefix before capability checks, and existing tests cover this compatibility.
- Official Meta Instagram API Postman collection documents requesting `instagram_business_account` together with Page discovery and states that Facebook Login-based Instagram API access requires a linked Instagram Professional account.
- Meta's official iOS SDK changelog identifies Graph API `v26.0` as the current default in release `18.1.1` dated 2026-08-27.
- Official developer documentation URLs were requested directly but returned HTTP 429 during this preflight. Redirect-URI transport policy must therefore be confirmed in the actual Meta App dashboard before OAuth execution.

Sources:

- https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api
- https://www.postman.com/meta/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00
- https://github.com/facebook/facebook-ios-sdk/blob/main/CHANGELOG.md

## Failures

- Initial OAuth attempts failed with sanitized code `META_AUTH_NETWORK_ERROR` because the local Web process was running in a restricted network environment. A clean Web restart with Meta Graph HTTPS access resolved the blocker; no OAuth or adapter code change was required.
- `BLOCKED_OPTIONAL_ASSET`: the dedicated Page did not return a linked Instagram Professional account, so linked-account discovery remains unverified.
- The operator changed the acceptance client to `LIVE` and created exactly one authorized LIVE job for the approved `META ACCEPTANCE TEST v2` content.
- A previously running restricted-network Worker claimed that job before the planned one-shot Worker start. Its first dispatch ended in `UNKNOWN` with sanitized code `REMOTE_RESULT_UNKNOWN`; no `remotePostId`, URL or `publishedAt` was returned. The safety contract correctly prevented automatic retry and created a manual reconciliation task.
- The leftover Worker process was stopped. At that time no second job, retry or additional publish was authorized.
- Read-only Graph API reconciliation queried both `/{page-id}/published_posts` and `/{page-id}/feed`: both returned HTTP 200 with zero returned posts and zero matches for the `[META ACCEPTANCE TEST]` marker. At that point the job correctly remained `UNKNOWN` pending operator confirmation.
- The operator subsequently inspected the dedicated Page and explicitly confirmed that the acceptance post was not published. The existing job was reconciled through the application service from `UNKNOWN` to `FAILED`; its only attempt was also marked `FAILED`, the reconciliation manual task was completed, and the audit trail was retained. No second job or retry was created.
- The operator then explicitly authorized exactly one second attempt to the same dedicated test Page with the same acceptance content. An identical immutable `v3` was created and re-approved solely to produce a new idempotency key. Queue isolation confirmed it was the only active job.
- A network-enabled one-shot Worker processed the `v3` LIVE job once and exited. The job and attempt are `PUBLISHED`/`SUCCEEDED`, with a saved remote post ID, permalink and published timestamp; the active queue is empty.
- A subsequent remote status query confirmed the post remains published. Real metric snapshots were saved for `post_comments_total` and `post_reactions_total`; both were available with initial value zero.
- One operator-created test comment was imported from Facebook with its remote record ID and `facebook-graph` provenance. `Interaction` persistence passed without duplication. The comment requested generic test product information but contained no configured procurement-intent keyword, so the existing classifier correctly did not create a `Lead` or `ManualTask`.
- A second operator-created comment explicitly requested a wholesale price list and MOQ. It imported as one new `Interaction`, classified as a high-priority `CATALOG_REQUEST`, and created exactly one `Lead` plus one urgent `ManualTask`. The task requires human handling and explicitly prohibits automatic replies.
- An immediate second synchronization imported zero new comments and reported both existing comments as duplicates. Database counts remained one `Interaction`, one `Lead` and one `ManualTask` for the procurement-intent comment, confirming idempotency.
- After explicit operator confirmation, the existing disconnect service revoked the Meta token remotely and returned `remoteRevokeConfirmed: true`. The connection is `DISCONNECTED`; user, refresh and Page token ciphertext/IV/auth-tag fields are all cleared; discovered accounts are deselected and their publish, metrics and comments capabilities are `UNVERIFIED`.
- A post-disconnect remote-query attempt was blocked locally with `META_CONNECTION_UNAVAILABLE`. Historical publish jobs, metric snapshots, interactions, leads and manual tasks retained identical before/after counts.

## Code fixes

- A development-only CSP incompatibility prevented the Next/React diagnostic overlay from using `eval()` while testing the OAuth flow. `buildContentSecurityPolicy()` now adds `'unsafe-eval'` only for `NODE_ENV=development`; production remains unchanged and no source directive uses a wildcard.
- No business code, OAuth architecture, adapter, worker, schema, storage or UI was changed. The CSP change is isolated to `next.config.ts` with regression coverage.
- If an actual external request exposes an incompatibility, record the exact request stage, sanitized Meta error code and evidence before making a minimal fix.

## Final closeout verification

| Check | Result |
| --- | --- |
| Meta OAuth | `EXTERNALLY_VERIFIED` |
| Facebook Page discovery | `EXTERNALLY_VERIFIED` |
| Facebook real publish | `PASS` |
| Remote query | `PASS` |
| Real metrics | `PASS` |
| Comment import | `PASS` |
| Interaction | `PASS` |
| Lead | `PASS` |
| ManualTask | `PASS` |
| Duplicate sync | `PASS` |
| Disconnect | `PASS` |
| Remote revoke | `PASS` |
| Token cleanup | `PASS` |
| Publish capability after disconnect | `UNVERIFIED` |
| Metrics capability after disconnect | `UNVERIFIED` |
| Comments capability after disconnect | `UNVERIFIED` |
| Post-disconnect query | `BLOCKED_BY_META_CONNECTION_UNAVAILABLE` |
| Historical PublishJob preserved | `PASS` |
| Historical MetricSnapshot preserved | `PASS` |
| Historical Interaction preserved | `PASS` |
| Historical Lead preserved | `PASS` |
| Historical ManualTask preserved | `PASS` |
| Already published Facebook test post retained | `PASS` |
| Auto reply | `NOT_EXECUTED` |
| Instagram linked-account discovery | `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED` |
| S3 | `IMPLEMENTED_NOT_EXTERNALLY_VERIFIED` |

The disconnect operation only revoked authorization and cleared local credential material. It did not issue a remote post deletion request; the accepted Facebook test post and its stored remote identifiers remain part of the preserved historical record.

## External verification status

- PRECHECK: `PASS`
- META APP: `PASS`
- OAUTH START: `PASS`
- CALLBACK: `PASS`
- TOKEN EXCHANGE: `PASS`
- ACCOUNT DISCOVERY: `PAGE_PASS_INSTAGRAM_NOT_DISCOVERED`
- ACCOUNT SELECTION: `PASS`
- TOKEN STORAGE: `PASS_ENCRYPTED`
- TEXT PUBLISH: `PASS`
- IMAGE PUBLISH: `NOT_STARTED`
- REMOTE QUERY: `PASS_PUBLISHED`
- METRICS: `PASS_REAL_POST_METRICS`
- COMMENT IMPORT: `PASS_INTERACTION_IMPORTED`
- LEAD CREATION: `PASS`
- DISCONNECT: `PASS_REMOTE_REVOKED_LOCAL_TOKENS_CLEARED_HISTORY_PRESERVED`
- META EXTERNAL VERIFICATION: `FACEBOOK_PAGE_FLOW_PASS_INSTAGRAM_NOT_EXTERNALLY_VERIFIED`
- Ready to start OAuth: `COMPLETED`
- Current capability result after disconnect: dedicated Facebook Page publish, metrics and comments are all `UNVERIFIED`; the account is deselected and all local encrypted Meta token material is cleared.
- Published test content: immutable version `v3` titled `META ACCEPTANCE TEST` was approved, published once to the dedicated test Page, remotely queried and retained in history.
- Real-publish authorization: the operator separately authorized the initial `v2` attempt and exactly one second `v3` attempt to `Overseas Furniture Operations Test` on 2026-09-20. No additional post, retry or other Page was authorized.
- First publish job: `FAILED` after manual reconciliation, attempt count 1, no remote identifier, manual task `COMPLETED`, and no automatic retry.
- Second authorized publish job: `PUBLISHED`, attempt count 1, remote ID and permalink saved, remote query passed, and the queue is empty.
- Interaction/Lead/ManualTask result: `PASS_IDEMPOTENT`; no automatic reply was sent.
- Final connection state: `DISCONNECTED`; all local encrypted Meta token material is cleared and subsequent Meta operations require a new OAuth connection.
- No additional publish, reconnect, automated reply or external operation is authorized. The remaining optional blocker is linking a dedicated Instagram Professional account if linked-account discovery must also be externally verified.
