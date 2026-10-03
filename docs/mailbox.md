# 邮箱账号与投诉信箱

## 启用

1. 按 `.env.example` 配置 `DATABASE_URL`、`APP_URL`、`AUTH_SECRET` 和 `SMTP_*`。`AUTH_SECRET` 使用至少 32 字符的随机值；`SMTP_FROM` 必须是邮件服务允许的发件地址。
2. 执行 `pnpm db:generate` 和 `pnpm db:push`。现有项目采用 schema push；部署时按项目数据库变更流程应用新增的六张表，不需要修改 DevFlow 的 `User` 数据。
3. 启动应用，从底部 Dock 的「投诉信箱」进入。

`APP_URL` 必须与浏览器访问的公开地址一致（包括协议和端口），用于请求来源校验与提醒链接。生产环境使用 HTTPS；会话 Cookie 自动启用 Secure。SMTP 465 通常配合 `SMTP_SECURE=true`；587 使用 STARTTLS，生产环境强制 TLS。未配置 SMTP 会明确报错，不会返回验证码或假装发送成功。

## 页面与可见范围

| 页面         | 路径                   | 登录要求 |
| ------------ | ---------------------- | -------- |
| 登录         | `/login`               | 无       |
| 注册         | `/register`            | 无       |
| 忘记密码     | `/forgot-password`     | 无       |
| 更新密码     | `/account/password`    | 有       |
| 所有被投诉人 | `/complaints`          | 无       |
| 写投诉       | `/complaints/new`      | 有       |
| 我投诉的     | `/complaints/sent`     | 有       |
| 被投诉的     | `/complaints/received` | 有       |

OnCall、DevFlow、Gallery 继续公开访问，不引入全站登录拦截。邮箱账号使用独立 `MailboxAccount`，与 DevFlow 的演示权限用户分离。

原有公开 OnCall 的 `postgres_query` 能任意读写应用数据库，会绕过投诉权限。因此该工具现在仅使用 `ONCALL_DATABASE_URL`，未配置时明确不可用；其他 OnCall 能力照常使用。此连接必须使用不同数据库名、不同数据库账号，且不能拥有管理员权限、应用账号成员资格或服务器文件/程序权限，目标库也不能包含投诉相关表。请由数据库管理员配置最小权限的专用账号，不要给它应用数据库访问权。每次执行建立新连接并复核隔离条件，拒绝一条请求中的多条 SQL。

- 注册必须验证邮箱，密码可选。没有密码的账号只能通过邮箱验证码登录。
- 忘记密码：邮箱 + 重置验证码 + 新密码。更新密码：当前邮箱 + 更新验证码或旧密码 + 新密码。更新后所有旧会话失效，需重新登录。
- 投诉支持最多 20 个不同邮箱；邮箱去除首尾空格并统一小写，重复收件人自动合并。收件人无需预先注册，之后验证同一邮箱即可查看历史投诉。
- 正文以纯文本显示，仅投诉人及对应被投诉人可读取。公开 API 仅提供被投诉人邮箱、主题、提交时间和非匿名投诉人邮箱，不提供正文或作者账号 ID。匿名投诉人仍可在自己的「我投诉的」中看到完整记录。
- 列表每页 20 条，可翻页查看全部。公开列表按邮箱分组，按「投诉 × 被投诉人」分页，同一邮箱可跨页出现。
- 打开收件详情后单独请求标记已读；每位收件人的已读状态互相独立。详情 GET 与页面预取不会标记已读。
- 每次登录或注册都会检查未读数并显示站内提示；有未读时通过 SMTP 发送一封数量提醒，同一账号一小时内最多成功发送一次。提醒不包含投诉正文或投诉人身份。发送失败不影响登录，页面会提示失败，后续登录可重试。
- 投诉内容保存在站内信箱；SMTP 用于验证码和登录后的未读数量提醒，不发送正文副本。

## 验证与会话

- 密码使用带随机盐的 scrypt；会话为随机 token，数据库只保存 SHA-256 摘要，HttpOnly / SameSite=Lax Cookie 有效期七天。
- 验证码按注册、登录、重置、更新四种用途隔离，HMAC 摘要落库；有效期十分钟，五次尝试，单次消费。发送及消费使用数据库锁处理并发。
- 验证码发送冷却 60 秒，每邮箱每小时最多 5 次、全局每小时最多 100 次；密码登录每邮箱每 15 分钟最多 10 次；投诉每账号每小时最多 20 次。限流记录存储在 PostgreSQL，可跨进程生效。
- 写接口要求与 `APP_URL` 匹配的 Origin 和 JSON。私有接口逐次检查会话与邮件归属；返回数据不允许缓存。输入有大小限制。
- 账号与投诉接口从浏览器监控的请求采集中排除；相应页面事件不上传，面包屑清除内容，避免验证码、密码、邮箱和正文进入现有遥测。

## 回归验证

```sh
pnpm db:generate
pnpm typecheck
pnpm lint
```

`scripts/mailbox-smoke.ts` 使用真实 HTTP 接口、独立 PostgreSQL 和脚本内置的本地 SMTP 接收器。测试只允许本机服务和名为 `mailbox_test` 的数据库，生成 `example.test` 测试账号并在结束时清理。不要连接业务数据库。

准备独立测试库，在两个终端设置相同环境：

```sh
export DATABASE_URL=postgresql://test:test@127.0.0.1:15433/mailbox_test
export APP_URL=http://localhost:3100
export AUTH_SECRET=local-mailbox-smoke-secret-at-least-32-characters
export SMTP_HOST=127.0.0.1
export SMTP_PORT=18027
export SMTP_FROM=mailbox@example.test
export SMTP_SECURE=false
export SMTP_USER=
```

终端一执行 `pnpm db:push`，然后 `pnpm dev --port 3100`。可将 `FILE_DIR` 指向空目录，避免测试触发原有知识库索引。

终端二执行：

```sh
MAILBOX_SMOKE=1 pnpm exec tsx scripts/mailbox-smoke.ts
```

脚本覆盖页面访问、验证码发送/过期/尝试次数/并发单次消费/重放/用途隔离、可选密码、密码重置及两种更新方式、会话失效、匿名与越权隔离、分页、多收件人已读状态、注册前的投诉、未读邮件提醒与 SMTP 失败降级。还会创建并清理独立测试角色与数据库，验证 OnCall SQL 的数据库隔离、权限检查及多语句拒绝；测试数据库账号需要创建角色/数据库的权限，此权限仅用于测试准备。为缩短测试，仅测试数据的发送时间会前移以跨过冷却期；真正的发送冷却另有断言。

本地 SMTP 接收成功只能证明应用发信流程，不等同于真实邮箱投递验收。上线前仍需用实际 SMTP 配置验证投递、HTTPS Cookie 和公开域名来源校验。
