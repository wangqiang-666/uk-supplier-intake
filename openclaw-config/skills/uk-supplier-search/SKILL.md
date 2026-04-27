---
name: uk-supplier-search
description: 查询英国法律服务供应商数据库 + 邮件营销全套运维。当用户需要查找英国律所/公证处/律师信息、查询统计/质量/邮件追踪、管理数据采集、发送/回复邮件、修改设置（IMAP/收件人/自动发送/邮件模板）、查询邮件健康状态时触发此技能。关键词：律所、公证、notary、solicitor、law firm、供应商、supplier、查询、搜索、统计、邮件、采集、抓取、发送、回复、退信、追踪、设置、模板、收件人、IMAP、健康检查。
metadata:
  {
    "openclaw": { "emoji": "🔍" },
  }
---

# 英国法律服务供应商 API 完整手册

API 基地址：`http://uk-supplier-api:3000`

数据库包含英国律所和公证处数据，来自 3 个数据源（SRA、Law Society、Faculty Office），每天自动更新。本系统同时承担邮件营销 / 回复管理 / 收件人管理 / 模板管理 / 自动发送调度。

---

## ⚠️ 数据回复规范（必须严格遵守）

### 核心原则
1. **所有数字必须来自 API 查询结果**，严禁自行推算、加总或估算
2. **区分"采集扫描数"和"实际入库数"**：
   - `/api/runs` 中的 `org_total` = 数据源扫描的原始总数
   - `/api/runs` 中的 `org_kept` = 筛选后保留的数量（如只保留 Immigration/Private client 领域）
   - `org_kept` **不等于新增入库数**，因为入库时还有去重（同一律所可能出现在多个数据源）
   - **数据库实际入库总数**必须通过 `/api/stats` 的 `organisations` 字段获取
3. **不同数据源的 org_kept 不能简单加总来代表入库总数**

### 回复采集相关问题时
- 必须同时调用 `/api/runs` 和 `/api/stats` 两个接口
- 采集结果表格中：用"扫描数"表示 `org_total`，用"筛选保留"表示 `org_kept`
- 表格下方必须补充说明："数据库当前实际入库 X 条（经跨数据源去重）"，X 来自 `/api/stats` 的 `organisations`
- 如果某次采集 `org_kept = 0`，状态标注为"❌ 失败"

### 回复统计相关问题时
- 供应商总数必须来自 `/api/stats` 的 `organisations` 字段
- 各数据源分别有多少条，使用 `/api/stats?source=xxx` 分别查询
- 数据质量必须来自 `/api/quality-stats` 的实际百分比

### 回复邮件相关问题时
- 已发送/未发送数量必须来自 `/api/email-stats` 的 `sent`/`unsent` 字段
- 回复信息必须来自 `/api/email/replies` 和 `/api/email/reply-stats`
- **邮件追踪数据**（送达、打开、点击、退信、投诉）必须来自 `/api/email/tracking-metrics`
- 追踪数据可能为 0（如 totalSent=0），此时**如实告知"暂无追踪数据"**，不要编造任何数字
- 追踪漏斗格式汇报：`发送 X → 送达 Y → 打开 Z → 点击 W`，所有数字必须来自 API 返回值

### 禁止的回复行为
- ❌ 不要把 `org_kept` 说成"新增"或"入库"，应说"采集保留"或"筛选通过"
- ❌ 不要把多个数据源的 `org_kept` 加总后说"总计新增 X 条"
- ❌ 不要使用"约"、"大概"等模糊词汇修饰从 API 获取的精确数字
- ❌ 不要在没有调用对应 API 的情况下回答数字类问题
- ❌ **严禁编造或猜测数据**：如果 API 返回为空、为 0、或调用失败，必须如实告知，绝对不能自行填写数字
- ❌ 不要用历史记忆中的数字回答——每次都必须实时调用 API 获取最新数据
- ❌ 不要把不同时间段的数据混淆（昨日 vs 7日 vs 30日，各有各的 API 参数）

### 危险操作必须先确认
以下操作会**实际发出邮件、修改配置或触发抓取**，必须**先用自然语言向用户复述将要做什么并征得明确同意**，确认后才能调用：
- `POST /api/email/send-batch`（实际发送邮件）
- `POST /api/email/reply`（实际回信）
- `POST /api/email/auto-send/trigger`（立即触发自动发送批次）
- `POST /api/trigger-scrape`（启动数据采集）
- `POST /api/email/check-replies`（拉取最新邮件）
- `PUT /api/settings/imap`、`PUT /api/settings/autosend`、`PUT /api/settings/email-template`（修改配置）
- `POST/PUT/DELETE /api/settings/recipients/*`（增删改通知负责人）

---

## 一、数据查询类

### 1. 搜索供应商
```bash
curl -s "http://uk-supplier-api:3000/api/organisations?search=关键词&page=1&pageSize=10&source=sra_api&sort=name&order=asc"
```
参数说明：
- `search` — 按名称/城市/邮编/邮箱模糊搜索（至少2个字符）
- `page` — 页码，默认 1
- `pageSize` — 每页条数，默认 50，最大 200
- `source` — 按数据源筛选：`sra_api`、`lawsociety_scraper`、`facultyoffice`
- `sort` — 排序字段：id/name/external_id/postcode/city/country/source/created_at/updated_at
- `order` — asc 或 desc

返回字段：total、page、pageSize、totalPages、rows（每条含 name/city/postcode/telephone/email/website/work_areas/organisation_type/authorisation_status/source 等）

### 2. 按数据源筛选搜索示例
```bash
# SRA 律所
curl -s "http://uk-supplier-api:3000/api/organisations?source=sra_api&search=immigration&pageSize=10"

# Law Society 律所
curl -s "http://uk-supplier-api:3000/api/organisations?source=lawsociety_scraper&search=london&pageSize=10"

# Faculty Office 公证人
curl -s "http://uk-supplier-api:3000/api/organisations?source=facultyoffice&search=notary&pageSize=10"
```

---

## 二、统计类

### 3. 总体统计
```bash
curl -s "http://uk-supplier-api:3000/api/stats"
curl -s "http://uk-supplier-api:3000/api/stats?source=sra_api"
```
返回：organisations（总数）、lastRun（最近一次采集信息）

### 4. 数据质量统计
```bash
curl -s "http://uk-supplier-api:3000/api/quality-stats"
curl -s "http://uk-supplier-api:3000/api/quality-stats?source=facultyoffice"
```
返回：total、completeness（各字段完整率%：email/postcode/city/telephone/website/work_areas）、perSource（各数据源明细）

### 5. 邮件统计
```bash
curl -s "http://uk-supplier-api:3000/api/email-stats"
curl -s "http://uk-supplier-api:3000/api/email-stats?source=sra_api"
```
返回：sent（已发送数）、unsent（未发送数）

### 6. 邮件追踪指标（漏斗）
```bash
curl -s "http://uk-supplier-api:3000/api/email/tracking-metrics"
curl -s "http://uk-supplier-api:3000/api/email/tracking-metrics?days=30"
```
返回：totalSent、delivered、opened、clicked、bounced、complained 及对应的 deliveryRate / openRate / clickRate / bounceRate / complaintRate（百分比小数形式，如 0.96 表示 96%）

`days` 默认 7，最大 90。

### 7. 邮件追踪事件分布（按事件类型计数）
```bash
curl -s "http://uk-supplier-api:3000/api/email/tracking-stats"
```
返回 map：`{ "email.sent": N, "email.delivered": N, "email.opened": N, "email.bounced": N, ... }`

### 8. 单个供应商的邮件事件时间线
```bash
curl -s "http://uk-supplier-api:3000/api/email/events/123"
```
返回该 organisation 收到的所有事件（含时间戳）。用于回答"某律所那封邮件打开了吗"。

### 9. 退信和投诉清单
```bash
curl -s "http://uk-supplier-api:3000/api/email/bounces"
curl -s "http://uk-supplier-api:3000/api/email/bounces?limit=20"
```
返回最近的退信/投诉事件列表，含 `org_name`、`org_email`、`event_type`、`created_at`。`limit` 默认 10。

---

## 三、数据源和采集管理

### 10. 数据来源列表
```bash
curl -s "http://uk-supplier-api:3000/api/sources"
```

### 11. 采集运行历史
```bash
curl -s "http://uk-supplier-api:3000/api/runs"
curl -s "http://uk-supplier-api:3000/api/runs?source=lawsociety_scraper"
```
返回最近 30 次采集记录：
- `org_total` — 数据源扫描的**原始总数**
- `org_kept` — 按业务领域筛选后**保留的数量**
- ⚠️ `org_kept` ≠ 实际新增入库数；要看真实总数必须再调用 `/api/stats`

### 12. 下次更新时间
```bash
curl -s "http://uk-supplier-api:3000/api/next-updates"
```
返回各数据源的调度计划和最后一次成功运行时间。

### 13. 手动触发采集（⚠️ 谨慎使用，需用户确认）
```bash
curl -s -X POST "http://uk-supplier-api:3000/api/trigger-scrape" \
  -H "Content-Type: application/json" \
  -d '{"source": "lawsociety"}'
```
`source` 可选：`sra` / `lawsociety` / `facultyoffice`

---

## 四、邮件 — 待发送/已发送

### 14. 查询或标记待发送邮件（轻量接口，不真正发邮件）
```bash
# 仅查询，不标记
curl -s -X POST "http://uk-supplier-api:3000/api/email/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "query", "count": 10}'

# 查询并把这批人标记为已发送（不真正发邮件，仅打标记）
curl -s -X POST "http://uk-supplier-api:3000/api/email/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "send", "count": 10}'

# 按数据源筛选
curl -s -X POST "http://uk-supplier-api:3000/api/email/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "query", "count": 10, "source": "sra_api"}'
```
`count` 范围 1-200。

### 15. 真实批量发送（⚠️ 会发出邮件，必须先确认）
```bash
# 先 dry-run 看预览
curl -s -X POST "http://uk-supplier-api:3000/api/email/send-batch" \
  -H "Content-Type: application/json" \
  -d '{"count": 5, "dryRun": true}'

# 真实发送
curl -s -X POST "http://uk-supplier-api:3000/api/email/send-batch" \
  -H "Content-Type: application/json" \
  -d '{"count": 5}'

# 按数据源筛选
curl -s -X POST "http://uk-supplier-api:3000/api/email/send-batch" \
  -H "Content-Type: application/json" \
  -d '{"count": 5, "source": "sra_api"}'
```
返回：requested、sent、failed、test_mode、test_to、results。`count` 上限 200。

**调用前必须先用 dryRun=true 给用户预览，并明确说出"将向 N 个供应商发邮件"，得到确认才进行真发**。

### 16. 立即触发"每日自动批次"（⚠️ 等同手动跑当日 9 点的定时任务）
```bash
curl -s -X POST "http://uk-supplier-api:3000/api/email/auto-send/trigger"
```
等同于让 scheduler 立即跑一次 9:00 的发送批次。**仅在用户明确说"现在跑一次/补发一次"时才使用**。

---

## 五、邮件 — 回复管理

### 17. 邮件回复列表
```bash
curl -s "http://uk-supplier-api:3000/api/email/replies"
curl -s "http://uk-supplier-api:3000/api/email/replies?matched=1&page=1&pageSize=20"
curl -s "http://uk-supplier-api:3000/api/email/replies?orgId=123"
```
返回所有收到的邮件回复，含 from_email、subject、body、received_at、matched（1=已匹配到供应商, 0=陌生人）、read_status（1=已读, 0=未读）。

### 18. 邮件回复统计
```bash
curl -s "http://uk-supplier-api:3000/api/email/reply-stats"
```
返回 `{ total_replies, matched, unmatched, unread, organisations_replied }`。

### 19. 标记回复为已读/未读
```bash
curl -s -X PATCH "http://uk-supplier-api:3000/api/email/replies/42" \
  -H "Content-Type: application/json" \
  -d '{"read_status": 1}'
```
`read_status`：1=已读，0=未读。

### 20. 立即去 IMAP 拉取新回复（⚠️ 触发外部连接，需用户确认）
```bash
curl -s -X POST "http://uk-supplier-api:3000/api/email/check-replies"
```
返回 `{ checked: true, new_replies: N, errors: [] }`。

### 21. 回信给某条邮件（⚠️ 真实发送，必须确认）
```bash
# 基于已有回复回信
curl -s -X POST "http://uk-supplier-api:3000/api/email/reply" \
  -H "Content-Type: application/json" \
  -d '{"reply_id": 42, "body": "Thank you for your reply..."}'

# 直接对某地址发邮件
curl -s -X POST "http://uk-supplier-api:3000/api/email/reply" \
  -H "Content-Type: application/json" \
  -d '{"to": "client@example.com", "subject": "Follow up", "body": "Hello..."}'
```
回信成功后会自动把对应 reply 标记为已读。**调用前必须把 to/subject/body 完整复述给用户审阅**。

---

## 六、邮件 — 健康检查

### 22. SMTP / IMAP 连接状态
```bash
curl -s "http://uk-supplier-api:3000/api/email/health"
```
返回：
- `smtp` — `{ connected, host, provider, error? }`
- `imap` — IMAP 连接状态
- `monitor` — IMAP 监听状态
- `last_reply_check` — 上次拉取时间
- `test_mode` / `test_to` — 是否处于测试模式（邮件转发到测试邮箱）

用户问"邮件服务正常吗 / Resend 还能用吗 / IMAP 通吗"时调用此接口。

---

## 七、设置 — IMAP

### 23. 获取 IMAP 配置
```bash
curl -s "http://uk-supplier-api:3000/api/settings/imap"
```
返回 host、port、user、tls、checkIntervalMinutes、configured；密码字段 `pass` 为掩码。

### 24. 修改 IMAP 配置（⚠️ 修改后会重启监听，需用户确认）
```bash
curl -s -X PUT "http://uk-supplier-api:3000/api/settings/imap" \
  -H "Content-Type: application/json" \
  -d '{"host":"imap.exmail.qq.com","port":993,"user":"jacky@inotary.com","pass":"newpass","tls":true,"checkIntervalMinutes":5}'
```
- `pass` 传 `""` 或 `****` 时会被忽略（保留原值）
- 保存后会**自动**用新配置重启 IMAP 监听并验证连接
- IMAP 用户邮箱会**同步**作为外发邮件的 Reply-To

---

## 八、设置 — 通知负责人（企业微信收件人）

### 25. 列出所有负责人
```bash
curl -s "http://uk-supplier-api:3000/api/settings/recipients"
```
返回每条 `{ id, name, wecom_userid, enabled, created_at }`。

### 26. 新增负责人
```bash
curl -s -X POST "http://uk-supplier-api:3000/api/settings/recipients" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tom","wecom_userid":"TomZhang","enabled":1}'
```

### 27. 修改负责人
```bash
curl -s -X PUT "http://uk-supplier-api:3000/api/settings/recipients/3" \
  -H "Content-Type: application/json" \
  -d '{"enabled":0}'
```
可只传需要改的字段。

### 28. 删除负责人
```bash
curl -s -X DELETE "http://uk-supplier-api:3000/api/settings/recipients/3"
```

### 29. 给某负责人发测试推送
```bash
curl -s -X POST "http://uk-supplier-api:3000/api/settings/recipients/3/test"
```
立即发一条"🔔 测试通知"到该负责人的企业微信，用于验证 wecom_userid 是否正确。

---

## 九、设置 — 自动发送

### 30. 查看自动发送配置和状态
```bash
curl -s "http://uk-supplier-api:3000/api/settings/autosend"
```
返回：
- `enabled` — 是否启用（true/false）
- `dailyCount` — 每日批次大小
- `running` — 此刻是否正在跑
- `lastRun` — 上次跑的统计
- `todaySent` — 今日累计已发数
- `remaining` — 各数据源还剩多少未发
- `dailyLimit` — 系统硬上限

### 31. 修改自动发送配置（⚠️ 影响后续每天行为）
```bash
# 关闭自动发送
curl -s -X PUT "http://uk-supplier-api:3000/api/settings/autosend" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# 调整每日批次
curl -s -X PUT "http://uk-supplier-api:3000/api/settings/autosend" \
  -H "Content-Type: application/json" \
  -d '{"dailyCount": 200}'
```

---

## 十、设置 — 邮件模板

### 32. 查看当前邮件模板
```bash
curl -s "http://uk-supplier-api:3000/api/settings/email-template"
```
返回 subject、body、可用 variables 列表（org_name / org_city / salutation 等）。

### 33. 修改邮件模板（⚠️ 会立刻影响下一封发出的邮件）
```bash
curl -s -X PUT "http://uk-supplier-api:3000/api/settings/email-template" \
  -H "Content-Type: application/json" \
  -d '{"subject":"New Subject","body":"Dear {{salutation}}, ..."}'
```
可只传 subject 或 body 之一。返回会带一段用样例数据渲染的预览。**修改前必须把新内容复述给用户确认**。

---

## 十一、导出

### 34. 导出 CSV
```bash
curl -s "http://uk-supplier-api:3000/api/export-orgs"
curl -s "http://uk-supplier-api:3000/api/export-orgs?source=sra_api&search=london"
```

---

## 自动调度（已配置，无需手动干预）

| 任务 | 频率 | 时间 | 时区 |
|---|---|---|---|
| SRA 采集 | 每周一 | 02:00 | Asia/Shanghai |
| Law Society 采集 | 每天 | 03:00 | Asia/Shanghai |
| Faculty Office 采集 | 每周一 | 04:00 | Asia/Shanghai |
| 自动邮件发送 | 工作日 | 09:03 | Europe/London |
| 邮件状态同步 | 每天 | 08:07-22:07 每小时 | Europe/London |
| 邮件周报推送 | 每周一 | 09:05 | Europe/London |

---

## 用户意图 → 接口映射

| 用户说 | 调用接口 |
|---|---|
| 查找伦敦的律所 | `/api/organisations?search=london` |
| 有多少供应商 | `/api/stats` |
| 数据质量怎么样 | `/api/quality-stats` |
| 邮件发了多少 | `/api/email-stats` |
| 邮件追踪情况 / 漏斗 / 转化率 | `/api/email/tracking-metrics?days=7` |
| 昨天邮件情况 | `/api/email/tracking-metrics?days=1` |
| 最近一个月邮件 | `/api/email/tracking-metrics?days=30` |
| 各事件总量 | `/api/email/tracking-stats` |
| 某律所邮件打开了吗 | `/api/email/events/{orgId}` |
| 哪些邮箱退信了 / 投诉了 | `/api/email/bounces?limit=20` |
| 最近采集情况 / 今天爬取了多少 | `/api/runs` **+** `/api/stats`（两者都要） |
| 手动抓一下 Law Society | ⚠️ 先确认 → `POST /api/trigger-scrape` |
| 取10个未发邮件的（不实发） | `POST /api/email/action {query, 10}` |
| 帮我发10封邮件 | ⚠️ 先 dryRun → 用户确认 → `POST /api/email/send-batch {count:10}` |
| 现在跑一次自动发送 | ⚠️ 先确认 → `POST /api/email/auto-send/trigger` |
| 有人回复邮件吗 | `/api/email/replies` + `/api/email/reply-stats` |
| 现在去看看有没有新回复 | ⚠️ 先确认 → `POST /api/email/check-replies` |
| 把第 42 条标记已读 | `PATCH /api/email/replies/42 {read_status:1}` |
| 回复一下第 42 条 | ⚠️ 先复述 → `POST /api/email/reply {reply_id:42,body:...}` |
| 邮件服务正常吗 / IMAP 通吗 | `/api/email/health` |
| 看下 IMAP 设置 | `/api/settings/imap` |
| 改下 IMAP 密码 | ⚠️ 先确认 → `PUT /api/settings/imap` |
| 看下通知负责人 | `/api/settings/recipients` |
| 加一个负责人 | ⚠️ 先确认 → `POST /api/settings/recipients` |
| 给某负责人发个测试 | `POST /api/settings/recipients/{id}/test` |
| 暂停自动发送 / 改每日批次 | ⚠️ 先确认 → `PUT /api/settings/autosend` |
| 看下当前邮件模板 | `/api/settings/email-template` |
| 改邮件主题/正文 | ⚠️ 先复述新内容 → `PUT /api/settings/email-template` |
| 导出所有数据 | `/api/export-orgs` |

### 邮件追踪汇报格式

当用户询问邮件追踪相关问题时，使用漏斗格式展示：

```
📊 邮件追踪漏斗（最近7日）
发送 {totalSent} → 送达 {delivered} → 打开 {opened}

送达率 {deliveryRate}% ｜ 打开率 {openRate}%

（如有退信/投诉）
⚠️ 退信 {bounced} ｜ 投诉 {complained}
```

**注意**：所有数字必须来自 `/api/email/tracking-metrics` 的实时返回值。如果 totalSent 为 0，回复"该时间段暂无追踪数据"。邮件中没有链接，所以不要汇报点击率（clicked/clickRate 字段忽略）。
