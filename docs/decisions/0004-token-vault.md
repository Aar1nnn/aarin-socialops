# ADR 0004：OAuth token 加密存储

## 状态

Accepted for V2 Phase 1

## 决策

1. User token、Page token 和未来 refresh token 使用 Node.js `crypto` 的 AES-256-GCM 加密。
2. 数据库只保存 ciphertext、12-byte IV、authentication tag 和 key version；主密钥仅来自服务器环境变量 `TOKEN_ENCRYPTION_KEY`。
3. Page token 属于具体远端账号，因此密文保存在对应 `SocialAccount`；provider token 保存在 `PlatformConnection`。
4. API、页面、审计日志和异常消息不得返回 token、client secret、authorization code 或加密字段。
5. `state` 只保存 SHA-256 摘要；授权码只在 callback 内存中用于交换，成功或失败都不持久化。
6. 保留 key version 以支持后续轮换；V2 Phase 1 不实现在线 KMS 或自动轮换。

## 原因

OAuth token 不能依赖人工 `.env` 分发，也不能明文进入数据库。AES-GCM 同时提供机密性和完整性检查，并能在不引入新生产依赖的条件下建立可替换 Vault 边界。

## 后果

- 部署必须提供 32-byte base64 或 64 位 hex 的 `TOKEN_ENCRYPTION_KEY`；未配置时 OAuth 路径明确不可用。
- 数据库泄露仍需结合服务器密钥才能解密，但这不等于完整的云 KMS。生产部署应把主密钥放入平台 secret manager。
- 密钥丢失会使既有密文不可恢复；轮换前必须保留旧版本密钥读取能力。
