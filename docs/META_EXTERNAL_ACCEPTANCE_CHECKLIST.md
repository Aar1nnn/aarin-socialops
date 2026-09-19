# Meta OAuth 外部验收清单

当前状态：`IMPLEMENTED_NOT_EXTERNALLY_VERIFIED`

此清单只用于专门测试资产。不要使用正式客户 Page 做首次连接或首次发帖；不要把任何 secret、token 或授权码粘贴到 issue、日志、截图或 Git。

## 人工准备

- [ ] 一个由操作者控制的 Meta Developer App。
- [ ] App ID 与 App Secret，分别注入服务器 `META_APP_ID`、`META_APP_SECRET`。
- [ ] Valid OAuth Redirect URI 与 `META_REDIRECT_URI` 完全一致，例如 `http://localhost:3000/api/connections/meta/callback`。
- [ ] 测试用户或具备目标测试 Page 权限的 Meta 用户。
- [ ] 一个明确标记为测试用途的 Facebook Page，不含真实客户数据。
- [ ] App 当前模式允许该测试用户授权；若面向非角色用户，完成 Meta 要求的 App Review/业务验证。
- [ ] 根据真实能力申请并确认 `pages_show_list`、`pages_manage_posts`、`pages_read_engagement`、`pages_read_user_content`。
- [ ] 服务器生成并安全保存 32-byte `TOKEN_ENCRYPTION_KEY`。
- [ ] 至少一个由当前 Graph API 版本和该 Page 实际支持的 `META_PAGE_METRIC_KEYS` 值。

## OAuth 与账号发现

- [ ] OWNER 从 `/connections` 发起连接，非 OWNER 被拒绝。
- [ ] Meta 登录页的 App 名称、权限和 redirect URI 正确。
- [ ] 用户取消授权时不创建 CONNECTED connection，不泄漏 code/token。
- [ ] 成功 callback 后返回 `/connections`，列出全部可管理测试 Page。
- [ ] 如果 Page 关联 Instagram 专业账号，发现结果正确显示但不提供 Instagram 发布能力。
- [ ] 不自动选择第一个账号；人工勾选测试 Page 后才启用 capability。
- [ ] 同一 callback URL 重放被拒绝；过期 state 被拒绝；跨客户 session 被拒绝。
- [ ] 页面/API/应用日志/审计日志均不显示 access token、Page token、App Secret 或 authorization code。

## 真实发布闭环

- [ ] 上传一张无客户信息的测试图片。
- [ ] 创建内容并包含醒目的 `[V2 META TEST]` 标记。
- [ ] 人工批准当前版本与准确的测试 Page。
- [ ] LIVE 发布一次，保存真实远端帖子 ID、链接和发布时间。
- [ ] 重复排期同一版本/账号不创建第二个帖子。
- [ ] 使用远端 ID 查询并确认状态。
- [ ] 读取至少一个真实指标；0 保存为 `AVAILABLE/REAL`，不可用/权限不足/失败不能保存为 0。
- [ ] 在测试帖人工添加一条测试评论并导入；触发意向时只创建线索和人工任务，不自动回复。
- [ ] 完成人工跟进任务并保留审计记录。

## 故障与撤销

- [ ] 撤销或过期 token 后，系统标记 connection/account 不可用并提供重新连接建议。
- [ ] 权限不足、限流、内容拒绝、媒体错误分别显示可理解的错误分类。
- [ ] POST 后 timeout/5xx/连接中断进入 `UNKNOWN`，worker 不自动重发。
- [ ] `UNKNOWN` 有远端 ID 时可查询；无远端 ID 时只能人工对账。
- [ ] 断开连接后，本地 token 密文被清除；远端撤销失败会显示警告但不保留本地 token。

## 验收证据

记录但不要包含 secret：

- Meta App ID 的脱敏末四位。
- 测试 Page ID、帖子 ID 和可访问链接。
- 授权/选择/批准/发布/查询/评论导入/人工任务的审计记录 ID。
- 指标名称、值、来源和最后同步时间。
- token 失效、网络 timeout 和重复排期测试结果。
- 执行日期、Graph API 版本、操作者和最终清理动作（是否删除测试帖）。
