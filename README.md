# Telegram → Memos 同步机器人

可靠地把 Telegram 机器人收到的文字和图片同步到 Memos 与 Telegram 频道。

## 架构

- Worker：接收 Telegram webhook 与按钮回调。
- Queue：异步执行同步并对临时故障重试。
- D1：保存会话、媒体引用、任务状态与幂等记录。
- KV：迁移期保留，当前 v2 流程不再依赖 KV。

Memos 与频道是两个独立目标：一个失败不会阻断另一个，已成功目标不会在重试时重复发布。

## 本地检查

```bash
npm ci
npm run check
npm test
```

## Cloudflare 首次配置

### 1. 创建 D1

```bash
npx wrangler d1 create tg-memos-sync
```

把命令返回的 `database_id` 写入 `wrangler.toml`，替换 `REPLACE_WITH_D1_DATABASE_ID`。

### 2. 创建 Queue

```bash
npx wrangler queues create tg-memos-sync
```

### 3. 应用数据库迁移

```bash
npx wrangler d1 migrations apply tg-memos-sync --remote
```

### 4. GitHub Actions Secrets

以下值必须使用 Secret：

- `CF_API_TOKEN`
- `CF_ACCOUNT_ID`
- `TELEGRAM_TOKEN`
- `MEMOS_TOKEN`
- `SECRET_PATH`
- `TELEGRAM_WEBHOOK_SECRET`
- `ADMIN_HEALTH_SECRET`

### 5. Cloudflare Worker 普通变量

在 Worker 的 Settings > Variables and Secrets 中把以下值设置为可查看的普通文本变量：

- `MEMOS_BASE_URL`
- `CHANNEL_ID_PUBLIC`
- `CHANNEL_ID_PRIVATE`
- `ALLOWED_USER_IDS`（多个 Telegram 用户 ID 用逗号分隔）

不要把 Telegram Token、Memos Token 或 webhook secret 改为普通变量。
`wrangler.toml` 已启用 `keep_vars = true`，后续部署会保留控制台中设置的普通变量。

### 6. 设置 Telegram webhook

部署成功后调用 Telegram `setWebhook`，URL 为正式域名加 `SECRET_PATH`，同时设置与 Worker Secret 相同的 `secret_token`。

```powershell
$token = Read-Host "Bot Token"
$path = Read-Host "SECRET_PATH"
$webhookSecret = Read-Host "TELEGRAM_WEBHOOK_SECRET"
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -Body @{
  url = "https://tgmm.591694.xyz/$path"
  secret_token = $webhookSecret
  allowed_updates = '["message","callback_query"]'
}
```

## 部署规则

- `dev`：只执行语法检查和测试，不部署生产。
- Pull Request：执行检查和测试。
- `master`：测试通过后应用 D1 migration 并部署生产 Worker。

## 健康检查

配置 `ADMIN_HEALTH_SECRET` 后访问：

```text
GET /health/{ADMIN_HEALTH_SECRET}
```

响应只显示版本、绑定状态和缺失配置，不返回任何 Secret。
