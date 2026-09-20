# ADR 0005：Provider-neutral Adapter Registry

## 状态

Accepted for V2 Phase 1

## 决策

1. worker 只处理 `PublishJob`、租约、审批门禁、执行尝试和结果状态，不了解具体平台 endpoint。
2. adapter 按 `{ provider, platform, capability }` 注册和解析。V2 Phase 1 只注册 `META + facebook + PUBLISH`。
3. 未注册 adapter 返回明确的 `ADAPTER_NOT_REGISTERED`，由任务策略转为等待配置或人工处理；绝不静默回退到模拟成功。
4. Auth adapter 与 publish adapter 分离。OAuth、token 刷新、账号发现和撤销不进入发布 adapter。
5. V1 `facebook-graph` adapter 继续复用，但由 connection resolver 提供 OAuth token 或旧环境变量 token。

## 原因

平台能力和 provider 授权并非一一对应。Registry 防止 worker 随平台增长形成 `if/else` 分支，同时保持 PostgreSQL 队列、幂等与 `UNKNOWN` 策略不变。

## 后果

- LinkedIn、TikTok、Instagram 发布仍是未实现状态；未来必须显式注册 adapter。
- Registry 只负责解析，不绕过账号 capability、人工审批或租户检查。
- 发布后的 timeout、5xx 或连接中断仍为 `UNKNOWN`，不会因为换 adapter 而自动重发。
