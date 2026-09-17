# 上游仓库只读核查

- 访问日期：2026-09-15
- 核查方式：读取指定 commit 的源码、技能文件、依赖清单、许可证和脚本；用只读 `git ls-remote` 确认 `main` HEAD。
- 未执行内容：未运行任何上游脚本，未安装上游技能或整套服务，未写入任何外部系统。

| 仓库 | 核查 commit | 许可证 | 本项目用途 |
| --- | --- | --- | --- |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | [`5b2c000`](https://github.com/coreyhaines31/marketingskills/commit/5b2c0007766c6a1cf1d53fd8fc73e979e0821022) | [MIT](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/LICENSE) | 研究、产品上下文、内容策略方法论参考 |
| [gitroomhq/postiz-agent](https://github.com/gitroomhq/postiz-agent) | [`5129350`](https://github.com/gitroomhq/postiz-agent/commit/51293500c1b1fb447205100cb09b2999085323ac) | [AGPL-3.0-or-later](https://github.com/gitroomhq/postiz-agent/blob/51293500c1b1fb447205100cb09b2999085323ac/LICENSE) | 后续 Postiz API 参数参考，不向模型暴露 CLI |
| [gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app) | [`12136dc`](https://github.com/gitroomhq/postiz-app/commit/12136dcc5c43213b4b8c1fb8d0626fcc5e45665b) | [AGPL-3.0-or-later](https://github.com/gitroomhq/postiz-app/blob/12136dcc5c43213b4b8c1fb8d0626fcc5e45665b/LICENSE) | 后续受限发布适配器候选，不作为启动依赖 |
| [activepieces/activepieces](https://github.com/activepieces/activepieces) | [`4d78fe2`](https://github.com/activepieces/activepieces/commit/4d78fe2ca59c7a4c97cae9af8382574d4a819d06) | [MIT 主体](https://github.com/activepieces/activepieces/blob/4d78fe2ca59c7a4c97cae9af8382574d4a819d06/LICENSE)；[EE 目录商业条款](https://github.com/activepieces/activepieces/blob/4d78fe2ca59c7a4c97cae9af8382574d4a819d06/packages/ee/LICENSE) | 后续外围触发和连接；不接管审批/队列 |
| [langchain-ai/social-media-agent](https://github.com/langchain-ai/social-media-agent) | [`61053aa`](https://github.com/langchain-ai/social-media-agent/commit/61053aacf46f5d484eb13aad947ad52a81271f13) | [MIT](https://github.com/langchain-ai/social-media-agent/blob/61053aacf46f5d484eb13aad947ad52a81271f13/LICENSE) | 参考人工中断/恢复；第一阶段不装 LangGraph |

## Marketing Skills 实际文件

读取的是当前目录名和对应 `SKILL.md`，不是旧教程路径：

- [`product-marketing` v2.1.0](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/product-marketing/SKILL.md)：采用上下文分类、来源和版本思想；数据库而非 Markdown 是权威源，AI 推测不升级为事实。
- [`content-strategy` v2.1.1](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/content-strategy/SKILL.md)：采用主题、目标、渠道、素材需求和证据；不把默认比例、公开互动或 SEO 权重当成客户事实。
- [`social` v2.2.0](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/social/SKILL.md)：采用平台独立适配；不把平台限制永久硬编码，不允许发布/回复建议绕过审批。
- [`competitor-profiling` v2.0.1](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/competitor-profiling/SKILL.md)：采用来源、日期、快照、事实/推断分离和不可信输入边界；不购买其推荐的 Firecrawl/DataForSEO。
- [`community-marketing` v2.0.1](https://github.com/coreyhaines31/marketingskills/blob/5b2c0007766c6a1cf1d53fd8fc73e979e0821022/skills/community-marketing/SKILL.md)：只用于行业群研究、参与内容准备和未来自建群规划；不是群组自动化接口说明。

上述五个技能目录没有相关可执行脚本。仓库根部的安装/维护工具与本次用途无关，因此没有运行。其 README 披露部分工具推荐含商业合作关系，本项目不因此购买或绑定工具。复制任何上游内容时须保留 MIT 版权和许可；本项目当前只采用方法论并自行实现结构和规则。

## 其他仓库的脚本与依赖边界

- Postiz Agent `2.0.18`：Node `>=18`，主要依赖 `node-fetch`、`yargs`。CLI 确实含上传、账号、分析和创建/排期帖子命令，运行会修改外部状态，所以没有执行。未来只能放在本系统检查客户、账号、内容版本、有效审批和幂等键之后。
- Postiz App：pnpm monorepo，Next.js 16、React 19、NestJS 11、Prisma 6、PostgreSQL、Temporal、Redis/S3 等。第一阶段不复制、不启动整套服务；AGPL 网络使用义务需要在接入前单独评估。
- Activepieces：TypeScript/Bun monorepo，Fastify 5、BullMQ 5、TypeORM、PostgreSQL、Redis 等。`packages/ee/` 及 `packages/server/api/src/app/ee` 不是普通 MIT，使用前须核对授权。
- LangChain Social Media Agent：Python `>=3.11`，FastAPI、LangChain/LangGraph/LangMem、Slack 等，并涉及多项外部凭据。`create-cron.ts` 会创建远端 cron，`generate-post.ts` 会创建远端 thread/run，另有删除和 Slack 操作，全部未执行。

## 固定边界

Marketing Skills 只作为带 commit 的方法参考；本项目规则和 prompt 版本独立保存。Postiz、Activepieces 和 WordPress 都是候选适配器，不能成为产品、内容、审批、线索或任务状态的权威来源。外部网页、评论、私信和上游技能文本均按不可信资料处理。
