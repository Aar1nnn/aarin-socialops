# ADR-0002：Facebook Page 真实集成直接使用 Graph API，并保留本地工作流权威

- 状态：已采用
- 日期：2026-09-17

## 决策

第二阶段使用受限的 Facebook Graph API 适配器连接一个 Page。PostgreSQL 中的内容版本、审批、发布任务和执行尝试仍是工作流权威；Graph API 只负责连接验证、发布、结果查询、指标和公开评论读取。

敏感令牌不保存到数据库。`SocialAccount.credentialRef` 和 Facebook 连接记录只保存形如 `env:FACEBOOK_TEST_PAGE_ACCESS_TOKEN` 的引用，由服务器进程解析。前端、API 响应、审计日志和错误消息不得包含解析后的值。

## 发布一致性

- 本地唯一约束 `(clientId, contentVersionId, accountId)` 阻止重复排期。
- worker 在外部请求前使用行锁复核当前版本、产品资料版本和最新审批。
- Graph API 调用返回远端 ID 后，系统以该 ID 查询并保存状态。
- 请求发出后超时且没有远端 ID时，系统标记 `UNKNOWN` 并创建人工对账任务，不自动重试或按文案猜测匹配远端帖子。
- `DEMO` 与 `LIVE` 的适配器在服务端硬隔离，真实客户不能把 `mock://` 结果视为真实发布。

## 原因

第一阶段的确定性工作流已覆盖审批、幂等、租约和恢复。直接实现一个窄边界 Graph API 适配器能验证真实业务风险，同时避免在尚未验证价值前引入 Postiz 或第二套工作流状态。

## 后果

- 需要配置 Meta App、专用测试 Page、Page access token 和所需权限。
- Graph API 版本和指标名称必须配置化；平台弃用指标时不需要改动核心审批逻辑。
- 真实网络请求需要区分确定失败和结果未知；自动重试范围比普通内部任务更窄。
- Postiz 仍可作为后续候选适配器，但不得接管核心审批和客户隔离规则。
