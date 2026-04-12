# UK Supplier Intake — 技术方案

## 一、项目概述

### 1.1 项目背景

为拓展英国法律服务供应商合作网络，需要一套自动化系统，能够持续采集英国律所和公证人数据，筛选目标领域（Immigration / Private Client），通过邮件自动触达，监听回复，并将关键事件通知到企业微信，形成**供应商开发的完整自动化闭环**。

### 1.2 核心目标

| 目标 | 说明 |
|------|------|
| 数据采集 | 自动从 3 个英国官方数据源采集律所和公证人信息 |
| 数据治理 | 跨数据源去重、地址解析、数据质量评分 |
| 邮件触达 | 工作日自动发送合作邀请邮件，支持每日限额和失败重试 |
| 回复闭环 | IMAP 轮询监听回复，自动匹配供应商，推送企微通知 |
| 运维管理 | Web UI 管理界面 + 企微 AI 助手查询 |

### 1.3 系统架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                     定时任务调度 (node-cron)                  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐          │
│  │ SRA API  │  │ Law Society  │  │ Faculty Office│          │
│  │ 每周一    │  │  Puppeteer   │  │   Cheerio     │          │
│  │ 02:00    │  │ 每天 03:00   │  │  每周一 04:00  │          │
│  └────┬─────┘  └──────┬───────┘  └───────┬───────┘          │
│       │               │                  │                   │
│       └───────────────┼──────────────────┘                   │
│                       ▼                                      │
│           ┌──────────────────────┐                           │
│           │   数据入库 (ingest)   │                           │
│           │  筛选 → 去重 → 入库   │                           │
│           └──────────┬───────────┘                           │
│                      ▼                                       │
│  ┌──────────────────────────────────────────┐                │
│  │         SQLite (WAL 模式)                 │                │
│  │  organisations / runs / email_replies     │                │
│  │  settings / notify_recipients             │                │
│  └──────────────────┬───────────────────────┘                │
│                     │                                        │
│       ┌─────────────┼─────────────┐                          │
│       ▼             ▼             ▼                          │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐                    │
│  │自动发邮件│  │IMAP 监听 │  │ REST API │                    │
│  │工作日    │  │每分钟轮询 │  │ + Web UI │                    │
│  │09:03 UK │  │          │  │ 端口 3000│                    │
│  └────┬────┘  └────┬─────┘  └──────────┘                    │
│       │            │                                         │
│       │            ▼                                         │
│       │    ┌───────────────┐      ┌──────────────────┐       │
│       │    │ 企微推送通知   │◄────│ openclaw-gateway  │       │
│       │    │ (docker exec) │      │  AI 查询助手      │       │
│       └────┤               │      │  端口 18789/18790│       │
│            └───────────────┘      └──────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

---

## 二、数据源设计

### 2.1 三个数据源对比

| 维度 | SRA (律师监管局) | Law Society (律师协会) | Faculty Office (公证处) |
|------|-----------------|----------------------|----------------------|
| 数据量 | ~25,000 条原始 → ~1,800 条筛选后 | 每天 ~100 条 (5页) | ~750 条 |
| 采集方式 | REST API | Puppeteer 浏览器爬虫 | HTTP + Cheerio 解析 |
| 反爬机制 | API Key 鉴权 | reCAPTCHA Enterprise | 无 |
| 采集频率 | 每周一 02:00 | 每天 03:00 | 每周一 04:00 |
| 时区 | Asia/Shanghai | Asia/Shanghai | Asia/Shanghai |
| 数据特点 | 全量拉取，含监管状态 | 增量分页，含专业领域 | 全量拉取，含 Apostille 资质 |

### 2.2 SRA 数据源

**接口**: `https://sra-prod-apim.azure-api.net/datashare/api/V1/organisation/GetAll`

**鉴权**: HTTP Header `Ocp-Apim-Subscription-Key`

**流程**:
1. 单次 HTTP GET 拉取全量 JSON (~25,000 条)
2. 按 `WorkArea` 字段筛选目标领域 (Immigration / Private client)
3. 过滤条件: 有邮箱地址、国家为英国
4. 筛选后约 1,800 条进入入库流程

### 2.3 Law Society 数据源

**目标站点**: `https://solicitors.lawsociety.org.uk/search/results`

**技术方案**:
- **Puppeteer + puppeteer-extra-plugin-stealth**: 使用隐身插件规避浏览器指纹检测
- **Xvfb 虚拟显示**: Docker 容器内使用虚拟帧缓冲，以 headful 模式运行 (非 headless)，提高 reCAPTCHA 通过率
- **分辨率**: 1920×1080，模拟真实桌面环境

**reCAPTCHA Enterprise 处理策略**:

Law Society 使用 Google reCAPTCHA Enterprise 做浏览器验证，验证流程为:
1. 页面返回 503 + reCAPTCHA JS
2. JS 自动执行 `grecaptcha.enterprise.execute()` 获取 token
3. JS 自动 POST token 到同一 URL
4. 服务器验证 token 评分，通过则返回 302 + fastoken cookie
5. 浏览器跟随 302 重定向，加载搜索结果页

**核心解决方案**: 不设置 `waitUntil` 参数 (让页面自然完成整个验证+重定向流程)，然后以 5 秒间隔轮询检查 `section.solicitor-outer` DOM 元素是否出现，整个过程通常需要 10-50 秒，最长等待 120 秒。

**分页策略**:
- 状态文件 `data/lawsociety-state.json` 记录爬取进度
- 每天爬取 5 页 (~100 条)，从上次结束的位置继续
- 完成一轮后自动重新开始

### 2.4 Faculty Office 数据源

**目标站点**: `https://notarypro.facultyoffice.org.uk/find-a-notary`

**技术方案**: axios HTTP 请求 + cheerio HTML 解析，无反爬机制

**特殊处理**:
- 所有 Faculty Office 记录标记 `apostille_qualified = 1` (Hague Apostille 认证资质)
- 提取字段: 姓名、公司、地址、电话、邮箱、网站、语言、AML 监管状态

---

## 三、数据治理

### 3.1 四层入库门控

每条数据进入数据库前经过严格的四层过滤:

```
原始数据
  │
  ▼
① 邮箱门控 ── 无邮箱地址 → 跳过 (无法触达)
  │
  ▼
② 领域筛选 ── work_areas 不匹配 Immigration/Private client → 跳过
  │
  ▼
③ 跨源去重 ── 名称在其他数据源已存在 → 跳过 (防重复触达)
  │
  ▼
④ 同源判重 ── (source, external_id) 已存在？
  │            ├─ 不存在 → INSERT 新记录
  │            ├─ 存在但字段变更 → UPDATE
  │            └─ 存在且无变化 → 仅更新 last_seen_run
  │
  ▼
入库完成
```

### 3.2 跨数据源去重

```sql
SELECT id FROM organisations
WHERE source != ? AND LOWER(TRIM(name)) = LOWER(TRIM(?))
```

同一律所可能同时出现在 SRA 和 Law Society 中，通过名称精确匹配 (忽略大小写和首尾空白) 进行去重，确保同一供应商不会收到多封邮件。

### 3.3 地址解析

`src/lib/validate.js` 中的 `parseUkAddress()` 函数将逗号分隔的英国地址字符串解析为结构化字段:

- 正则提取英国邮编: `/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i`
- 内置 30+ 个英国主要城市名识别
- 启发式识别 county 名称

### 3.4 数据质量评分

加权评分模型 (满分 100):

| 字段 | 权重 | 说明 |
|------|------|------|
| name | 3 | 机构名称 |
| external_id | 3 | 数据源 ID |
| email | 3 | 邮箱地址 |
| postcode | 2 | 英国邮编 |
| city | 2 | 城市 |
| telephone | 2 | 电话号码 |
| authorisation_status | 1 | 授权状态 |
| address_line1 | 1 | 地址 |
| website | 1 | 网站 |
| organisation_type | 1 | 机构类型 |
| work_areas | 1 | 专业领域 |

### 3.5 联系方式标准化

| 字段 | 标准化规则 |
|------|-----------|
| 邮箱 | 转小写、去空白、格式校验 |
| 电话 | 统一为 `+44` 格式或 `0` 前缀，校验 9-11 位数字 |
| 邮编 | 转大写、标准格式化 (如 `EC1A 1BB`) |

---

## 四、邮件系统

### 4.1 发送架构

```
                    ┌─────────────────┐
                    │  auto-sender.js │
                    │ 工作日 09:03 UK  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ 每日限额  │  │ 模板渲染  │  │ 失败重试  │
        │ 450封/天  │  │ 变量替换  │  │ 3次重试   │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             │             │             │
             └─────────────┼─────────────┘
                           ▼
              ┌─────────────────────────┐
              │     email-sender.js     │
              │  主: Resend API         │
              │  备: Nodemailer SMTP    │
              └─────────────────────────┘
```

### 4.2 发送策略

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 每日发送量 | 450 封 | 可通过 Web UI 调整 |
| 发送间隔 | 2000ms | 邮件之间的等待时间 |
| 发送时间 | 工作日 09:03 | 欧洲/伦敦时区，自动处理夏令时 |
| 失败重试 | 3 次 | 每次间隔 2 秒 |
| 成功率报警 | < 90% | 低于此值触发企微报警 |

### 4.3 邮件模板

支持变量替换的邮件模板系统:

| 变量 | 说明 |
|------|------|
| `{{salutation}}` | 称呼 (Mr/Mrs/Ms/Dr + 姓氏，或 Sir/Madam) |
| `{{org_name}}` | 机构名称 |
| `{{org_city}}` | 所在城市 |
| `{{work_areas}}` | 专业领域 |
| `{{from_name}}` | 发件人姓名 |
| `{{from_email}}` | 发件人邮箱 |

### 4.4 回复监听

```
邮箱服务器 (IMAP)
      │
      │ 每分钟轮询 UNSEEN 邮件
      ▼
┌──────────────────┐
│ email-monitor.js │
│                  │
│ 1. IMAP 连接     │
│ 2. 搜索未读邮件  │
│ 3. 解析邮件内容  │
│ 4. message_id 去重│
│ 5. 匹配发件人    │
│ 6. 入库          │
│ 7. 推送企微通知  │
└──────────────────┘
```

- **协议**: IMAP over SSL (端口 993)
- **轮询间隔**: 1 分钟 (可通过 Web UI 调整)
- **去重**: 基于邮件的 `message_id` 字段
- **匹配逻辑**: 发件人邮箱与 `organisations.email` 做 case-insensitive 匹配
- **回复清洗**: 剥离引用历史 (Original Message)、签名、多余空白，只保留新内容
- **代理支持**: 支持 HTTP CONNECT 隧道代理连接 IMAP 服务器

---

## 五、企微通知系统

### 5.1 推送架构

```
uk-supplier-api 容器
      │
      │ docker exec
      ▼
openclaw-gateway 容器
      │
      │ openclaw message send
      │ --channel wecom
      │ --target wecom:<userid>
      ▼
企业微信服务器 (WebSocket)
      │
      ▼
负责人手机收到推送
```

**前提条件**: `uk-supplier-api` 容器挂载宿主机的 `/var/run/docker.sock`，可以通过 `docker exec` 调用 `openclaw-gateway` 容器内的 CLI。

### 5.2 三种通知类型

| 通知类型 | 触发时机 | 内容 |
|---------|---------|------|
| 回复通知 | 检测到新邮件回复 | 供应商资料 + 回复内容预览 (限 200 字) |
| 每日发送报告 | 自动发送完成后 | 发送统计、成功率、剩余待发送量 |
| 异常报警 | 发送成功率 < 90% | 失败详情和错误信息 |

### 5.3 AI 查询助手

`openclaw-gateway` 同时作为企微 AI 机器人运行，接收用户消息，通过技能文件 (`SKILL.md`) 定义的 API 映射，调用 `uk-supplier-api` 的 REST 接口查询数据后回复。

支持的查询能力:
- 供应商搜索 (按名称、城市、数据源)
- 数据统计 (总数、各源明细)
- 采集运行状态
- 邮件发送/回复统计
- 数据质量报告
- 手动触发采集

---

## 六、数据库设计

### 6.1 技术选型

- **数据库**: SQLite 3 (better-sqlite3 驱动)
- **日志模式**: WAL (Write-Ahead Logging)，支持并发读
- **时区**: 所有时间戳统一为 Asia/Shanghai
- **存储路径**: `/app/data/supplier-intake.db`

### 6.2 ER 关系图

```
sources (数据源注册表)
  code ←────────── runs.source
  code ←────────── organisations.source

runs (采集运行记录)
  run_id ←──────── organisations.first_seen_run
  run_id ←──────── organisations.last_seen_run

organisations (供应商主表)
  id ←──────────── email_replies.organisation_id

settings (运行时配置 KV 表)

email_monitor_state (IMAP 轮询状态 KV 表)

notify_recipients (企微通知负责人)
```

### 6.3 核心表结构

#### organisations (供应商)

| 列名 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 ID |
| source | TEXT | 数据源 (sra_api / lawsociety_scraper / facultyoffice) |
| external_id | TEXT | 数据源内唯一 ID |
| name | TEXT | 机构名称 |
| authorisation_status | TEXT | 授权状态 |
| organisation_type | TEXT | 机构类型 |
| work_areas | TEXT | 专业领域 (JSON 数组) |
| address_line1~3 | TEXT | 地址行 |
| city | TEXT | 城市 |
| county | TEXT | 郡县 |
| postcode | TEXT | 邮编 |
| country | TEXT | 国家 |
| telephone | TEXT | 电话 |
| email | TEXT | 邮箱 |
| website | TEXT | 网站 |
| email_sent | INTEGER | 是否已发送邮件 (0/1) |
| email_sent_at | TEXT | 最近发送时间 |
| email_send_count | INTEGER | 发送次数 |
| apostille_qualified | INTEGER | Apostille 认证资质 (0/1) |
| raw_json | TEXT | 原始数据 JSON |
| 唯一约束 | | UNIQUE(source, external_id) |

#### email_replies (邮件回复)

| 列名 | 类型 | 说明 |
|------|------|------|
| id | INTEGER PK | 自增 ID |
| organisation_id | INTEGER FK | 关联的供应商 (可空 = 未匹配) |
| from_email | TEXT | 发件人邮箱 |
| subject | TEXT | 邮件主题 |
| body | TEXT | 邮件正文 (限 10,000 字符) |
| message_id | TEXT | 邮件 Message-ID (用于去重) |
| received_at | TEXT | 接收时间 |
| matched | INTEGER | 是否匹配到供应商 (0/1) |
| read_status | INTEGER | 已读状态 (0/1) |

---

## 七、部署架构

### 7.1 容器架构

```
┌──────────────── Docker Host (Mac Mini) ────────────────┐
│                                                         │
│  ┌─────────────────────────────────────┐                │
│  │        uk-supplier-api              │                │
│  │        (node:20-slim)               │                │
│  │                                     │                │
│  │  Chromium + Xvfb + Docker CLI       │                │
│  │  PM2 → server.js                   │                │
│  │                                     │                │
│  │  端口: 3000                         │                │
│  │  内存限制: 2GB                      │                │
│  │  CPU 限制: 2 核                     │                │
│  │                                     │                │
│  │  Volumes:                           │                │
│  │    ./data → /app/data               │                │
│  │    ./logs → /app/logs               │                │
│  │    ./output → /app/output           │                │
│  │    docker.sock → docker.sock        │                │
│  └────────────────┬────────────────────┘                │
│                   │ app-network                          │
│  ┌────────────────┴────────────────────┐                │
│  │        openclaw-gateway             │                │
│  │        (ghcr.io/openclaw/openclaw)  │                │
│  │                                     │                │
│  │  AI 助手 + 企微 WebSocket 通道       │                │
│  │                                     │                │
│  │  端口: 18789 (控制台), 18790         │                │
│  │  内存限制: 4GB                      │                │
│  │  CPU 限制: 2 核                     │                │
│  │                                     │                │
│  │  Volumes:                           │                │
│  │    ./openclaw-config → /home/node/  │                │
│  │                        .openclaw    │                │
│  └─────────────────────────────────────┘                │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 7.2 进程管理

容器内使用 PM2 管理 Node.js 进程:
- 单实例运行 `server.js`
- 内存超过 500MB 自动重启
- 日志输出到 `logs/web-out.log` 和 `logs/web-error.log`
- 启动前先启动 Xvfb 虚拟显示服务 (Law Society 爬虫依赖)

### 7.3 网络访问

- **Tailscale VPN**: 通过 Tailscale 虚拟局域网访问 Mac Mini (100.68.34.25)
- 无需公网 IP，只有加入 Tailscale 网络的设备可访问
- Web UI: `http://100.68.34.25:3000`
- OpenClaw 控制台: `http://100.68.34.25:18789`

---

## 八、定时任务总览

| 任务 | Cron 表达式 | 时区 | 说明 |
|------|------------|------|------|
| SRA 数据采集 | `0 2 * * 1` | Asia/Shanghai | 每周一 02:00 |
| Law Society 爬取 | `0 3 * * *` | Asia/Shanghai | 每天 03:00 |
| Faculty Office 爬取 | `0 4 * * 1` | Asia/Shanghai | 每周一 04:00 |
| 自动邮件发送 | `3 9 * * 1-5` | Europe/London | 英国工作日 09:03 |
| IMAP 回复检查 | setInterval | - | 每 1 分钟 |

采集任务运行在**子进程**中 (child_process.fork)，与主服务进程隔离，防止爬虫异常影响 API 服务。

---

## 九、Web 管理界面

### 9.1 功能模块

单页面应用 (SPA)，纯原生 JS 实现，无框架依赖。

| 模块 | 功能 |
|------|------|
| 数据概览 | 供应商总数、已发送邮件数、待发送数 |
| 采集倒计时 | 各数据源下次采集的倒计时显示 |
| 数据质量面板 | 各数据源字段完整率可视化 |
| 供应商列表 | 分页表格，支持搜索、筛选、排序 |
| CSV 导出 | 全量或筛选导出，UTF-8 BOM 兼容 Excel |
| IMAP 配置 | 收件监听邮箱配置，保存后热重启 |
| 通知管理 | 企微负责人增删、启停、测试推送 |
| 自动发送设置 | 开关、每日发送量、手动触发 |

---

## 十、REST API 接口

### 10.1 数据查询

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/sources | 数据源列表 |
| GET | /api/runs | 采集运行历史 (含 db_total 实际入库数) |
| GET | /api/next-updates | 各数据源下次采集时间 |
| GET | /api/organisations | 供应商列表 (分页/搜索/筛选/排序) |
| GET | /api/stats | 数据统计 (可按数据源筛选) |
| GET | /api/quality-stats | 数据质量统计 |
| GET | /api/export-orgs | 导出 CSV |

### 10.2 邮件管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/email-stats | 邮件发送统计 |
| POST | /api/email/action | 查询/标记待发送 |
| POST | /api/email/send-batch | 批量发送 |
| POST | /api/email/check-replies | 手动触发 IMAP 检查 |
| GET | /api/email/replies | 回复列表 |
| GET | /api/email/reply-stats | 回复统计 |
| GET | /api/email/health | SMTP/IMAP 连接状态 |

### 10.3 系统配置

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/PUT | /api/settings/imap | IMAP 配置 |
| GET/PUT | /api/settings/autosend | 自动发送配置 |
| GET/POST/PUT/DELETE | /api/settings/recipients | 通知负责人管理 |
| POST | /api/trigger-scrape | 手动触发数据采集 |

---

## 十一、技术栈总览

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 运行时 | Node.js 20 | 主服务运行时 |
| Web 框架 | Express 4 | REST API |
| 数据库 | SQLite 3 (better-sqlite3) | WAL 模式，同步驱动 |
| 浏览器自动化 | Puppeteer + Stealth 插件 | Law Society 爬虫 |
| HTML 解析 | Cheerio | Faculty Office 爬虫 |
| HTTP 客户端 | Axios | SRA API / Faculty Office |
| 邮件发送 | Resend API (主) / Nodemailer (备) | 双通道保障 |
| 邮件接收 | imap-simple + mailparser | IMAP 协议轮询 |
| 定时调度 | node-cron | 进程内 cron |
| 进程管理 | PM2 | 容器内守护进程 |
| 虚拟显示 | Xvfb | Docker 内 headful 浏览器 |
| 容器化 | Docker + Docker Compose | 双容器部署 |
| AI 助手 | OpenClaw + Claude Haiku 4.5 | 企微查询机器人 |
| 通知渠道 | 企业微信 (WebSocket) | 实时推送 |
| 网络访问 | Tailscale VPN | 内网穿透 |
| 前端 | 原生 HTML/CSS/JS | 零依赖管理界面 |

---

## 十二、安全与合规

| 维度 | 措施 |
|------|------|
| API 限流 | Express Rate Limit，120 请求/分钟 |
| 邮件限额 | 每日最大 450 封，发送间隔 2 秒 |
| 爬取节制 | Law Society 每天仅 5 页，Faculty Office 每请求延迟 1.5 秒 |
| 敏感配置 | 密钥通过 .env 文件管理，不入代码仓库 |
| 测试模式 | `EMAIL_TEST_TO` 环境变量控制邮件转发到测试邮箱 |
| 网络隔离 | Tailscale VPN 内网访问，无公网暴露 |
| 容器隔离 | 资源限制 (内存/CPU)，数据持久化到宿主机 volume |

---

## 十三、运维手册

### 13.1 常用命令

```bash
# 查看容器状态
docker ps

# 查看日志
docker logs uk-supplier-api --tail 50
docker logs openclaw-gateway --tail 50

# 重启服务
docker compose restart

# 重建部署
docker compose up -d --build

# 数据库迁移
docker exec uk-supplier-api npm run migrate

# 手动全量采集
docker exec uk-supplier-api npm run ingest

# 单独采集某个数据源
docker exec -e SOURCE=sra uk-supplier-api node src/ingest.js
docker exec -e SOURCE=lawsociety uk-supplier-api node src/ingest.js
docker exec -e SOURCE=facultyoffice uk-supplier-api node src/ingest.js
```

### 13.2 故障排查

| 现象 | 排查方向 |
|------|---------|
| Law Society 爬取 0 条 | 检查日志中 reCAPTCHA 验证是否超时，可手动触发重试 |
| 邮件发送失败率高 | 检查 `/api/email/health`，确认 Resend API Key 有效 |
| 企微推送失败 | 确认 docker.sock 挂载，检查 openclaw-gateway 日志 |
| IMAP 连接失败 | Web UI 检查 IMAP 配置，确认密码和端口正确 |
| 数据库锁 | SQLite WAL 模式下罕见，重启容器可恢复 |

---

*文档版本: v1.0 | 更新日期: 2026-04-11*
