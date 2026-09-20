# ADR 0003：PlatformConnection 与 SocialAccount 分层

## 状态

Accepted for V2 Phase 1

## 决策

1. `PlatformConnection` 表示某客户对某 provider 的 OAuth 授权关系；`SocialAccount` 表示该授权发现并由运营者明确选择的具体 Page 或专业账号。
2. `OAuthState` 只保存 state 哈希、所属客户/用户、过期和消费时间。回调必须在事务中一次性消费，并校验当前 session 的用户和客户。
3. 一个 connection 可以关联多个 `SocialAccount`。发现账号后默认不启用，禁止自动选择列表第一个账号。
4. 发布任务继续以 `accountId` 作为实际目标，并保存 provider/platform 快照。`clientId + platform + externalAccountId` 是远端账号身份约束，显示名称不是身份。
5. V1 `FacebookPageConnection` 和 `credentialRef` 在过渡期保留为 fallback；新连接优先使用 `PlatformConnection`。
6. 新模型和 migration 只向前增加，不改写 V1 已执行 migration，不删除审批、幂等、`UNKNOWN`、租户边界或人工交接。

## 原因

OAuth 授权、客户资产和发布目标具有不同生命周期。分层后才能支持同一客户多个 Page、一个 Meta 授权发现多个资产，以及未来只新增 provider adapter 而不重写内容工作流。

## 后果

- 所有 connection/account 查询必须同时受服务端 `clientId` 约束。
- Meta OAuth、App Review 和真实 Page 权限仍需外部测试资产验证。
- V1 fallback 只有显式配置并验证后才可进入 LIVE，不会被 OAuth 路径静默替换。
