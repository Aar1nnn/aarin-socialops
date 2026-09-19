# 海外社媒 AI 运营工作台：第一阶段完成记录

- 状态：完成
- 完成日期：2026-09-16

## 交付目标与范围

已交付默认演示模式启动的 Next.js + PostgreSQL 单体工作台与独立 worker，跑通产品/素材录入、四平台草稿、人工审批、持久化模拟发布、互动导入、线索交接、指标覆盖和运营复盘。未注册账号、未购买服务、未真实发帖，也没有自动回复、私信、报价或广告执行路径。

## 关键决策

- Web 与 worker 共享 PostgreSQL 权威状态；浏览器不承担审批或任务可靠性。
- 每次发布同时绑定客户、平台账号、不可变内容版本、最新有效审批和幂等键；外部调用前在数据库行锁内执行最终门禁并将内容置为 `RUNNING`。
- 发布领取使用 `SKIP LOCKED` 与唯一租约 token；外部调用前保存 `DISPATCHING`，失联后转 `UNKNOWN` 并创建精确绑定 `publishJobId` 的人工对账任务。
- 产品资料 `dataVersion` 更新会使未发布内容进入需修改并取消队列任务。
- 文本模型按客户的已验证集成决定是否调用；全局环境密钥不能隐式启用其他客户，真实调用受客户月度上限约束。
- 外部互动仅作为不可信数据分类；系统没有外发回复接口。

## Done 标准结果

1. 三份 Prisma migration 已在 PostgreSQL 17.11 应用；seed 连续执行两次成功。
2. Web 与 worker 可独立启动；演示客户与正式客户 A 隔离，正式客户产品数为 0。
3. 工作台、产品与素材、内容审核、线索与复盘、设置五个主要页面可执行本阶段动作。
4. 服务端实现 membership/client 范围、内容版本审批、并发幂等、UNKNOWN 禁止自动重试、三次重试上限、租约恢复和人工对账。
5. 自动测试 30 项通过；端到端运行 `574f8093` 的 4 个平台模拟发布均成功并明确标记 simulated。
6. TypeScript 检查、production build、生产 HTTP 登录与工作台访问、生产依赖审计均实际通过。

## 已执行命令与结果

- `pnpm db:generate`：成功。
- `pnpm db:migrate`：3 migrations 成功应用。
- `pnpm db:seed`（连续两次）：成功。
- `pnpm typecheck`：成功。
- `pnpm test`：2 files / 30 tests passed。
- `pnpm demo:e2e`：成功，运行 ID `574f8093`。
- `pnpm build`：成功，25 个页面/API 路由和 Proxy 完成构建。
- `pnpm audit --prod`：No known vulnerabilities found。
- `pnpm start` + HTTP 请求：登录页 200，登录后 `/` 200，客户名与安全头校验成功。

## 环境限制和剩余风险

- Docker Desktop daemon 因主机已有损坏 reparse point 无法运行；Compose 本机未验证。验证改用 PostgreSQL 17.11 临时实例，不影响数据库路径的运行证据。
- 四个平台、外部通知、WordPress、对象存储和图片生成仍是未验证适配器；LIVE 模式不会实际发布。
- 当前是最小本地身份体系，没有登录限速、密码找回、多级团队权限或外部 SaaS 注册。
- 跨实体复合 tenant 外键尚未覆盖全部表；服务层均按 `clientId` 校验，`PublishAttempt` 已补 `clientId`，下一阶段应继续把数据库层复合约束扩展到高风险关联。
- worker 没有长任务 heartbeat；当前适配器请求超时 30 秒、锁默认 60 秒，未来真实适配器若有更长调用必须增加续租。

## 下一阶段入口

先验证单个 Facebook Page 的最小真实连接：账号能力探测、测试素材、人工审批后的发布、结果查询和超时对账、真实指标读取。Postiz 是候选发布适配器，但接入前需完成 AGPL 部署义务评估。
