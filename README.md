# UK Supplier Intake - 英国供应商自动化采集与触达系统

## 项目说明

自动采集英国律所/公证人数据，筛选 Immigration 和 Private Client 专业领域，通过邮件自动触达，监听回复，实现供应商开发的完整闭环。

## 系统架构

```
定时爬取 (3个数据源)
    ↓
SQLite 数据库 (去重+入库)
    ↓
自动邮件发送 (英国工作日 09:03)
    ↓
IMAP 回复监听 (每分钟轮询)
    ↓
Web UI 管理 + 企微通知
```

## 数据源

| 数据源 | 方式 | 频率 | 说明 |
|--------|------|------|------|
| SRA (律师监管局) | API | 每周一 02:00 | 约 25000 条，筛选后 ~1800 条 |
| Law Society | Puppeteer 爬虫 | 每天 03:00 | 每天 5 页 ~100 条，需通过 reCAPTCHA Enterprise |
| Faculty Office | Puppeteer 爬虫 | 每周一 04:00 | 公证人数据 ~750 条 |

## Docker Compose 部署 (生产方式)

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入必要配置
```

关键配置项：
- `SRA_API_KEY` - SRA API 订阅密钥
- `RESEND_API_KEY` - Resend 邮件发送 API Key
- `IMAP_HOST` / `IMAP_USER` / `IMAP_PASS` - IMAP 收件配置
- `EMAIL_TEST_TO` - 测试邮箱地址（设置后所有邮件发到此地址，留空则发给真实收件人）
- `WORK_AREAS` - 筛选专业领域，默认 `Immigration,Private client`
- `LAW_SOCIETY_PAGES_PER_DAY` - Law Society 每天爬取页数，默认 5

### 2. 启动服务

```bash
docker compose up -d --build
```

启动两个容器：

| 容器 | 端口 | 说明 |
|------|------|------|
| uk-supplier-api | 3000 | 主服务（API + 定时任务 + 邮件系统） |
| openclaw-gateway | 18789, 18790 | OpenClaw AI 助手（企微通知） |

### 3. 首次数据导入

```bash
docker exec uk-supplier-api npm run ingest
```

### 4. 单独采集某个数据源

```bash
# 只跑 SRA
docker exec -e SOURCE=sra uk-supplier-api node src/ingest.js

# 只跑 Law Society
docker exec -e SOURCE=lawsociety uk-supplier-api node src/ingest.js

# 只跑 Faculty Office
docker exec -e SOURCE=facultyoffice uk-supplier-api node src/ingest.js
```

## 定时任务调度

| 任务 | 时间 | 时区 |
|------|------|------|
| SRA 数据采集 | 每周一 02:00 | Asia/Shanghai |
| Law Society 爬取 | 每天 03:00 | Asia/Shanghai |
| Faculty Office 爬取 | 每周一 04:00 | Asia/Shanghai |
| 自动邮件发送 | 工作日 09:03 | Europe/London |
| IMAP 回复检查 | 每 1 分钟 | - |

## API 接口

| 接口 | 说明 |
|------|------|
| `GET /` | Web 管理界面 |
| `GET /api/stats` | 数据统计 |
| `GET /api/sources` | 数据源列表 |
| `GET /api/organisations` | 律所列表（分页、搜索、排序） |
| `GET /api/export-orgs` | 导出 CSV |
| `GET /api/email-stats` | 邮件发送统计 |
| `GET /api/email/replies` | 回复列表 |
| `GET /api/email/reply-stats` | 回复统计 |
| `GET /api/email/health` | SMTP/IMAP 连接状态 |
| `POST /api/email/action` | 邮件操作（发送/标记等） |
| `POST /api/email/send-batch` | 批量发送 |
| `POST /api/email/check-replies` | 手动触发 IMAP 检查 |
| `POST /api/trigger-scrape` | 手动触发爬取 |
| `GET /api/settings/autosend` | 自动发送配置 |
| `PUT /api/settings/autosend` | 更新自动发送配置 |
| `GET /api/settings/imap` | IMAP 配置 |
| `PUT /api/settings/imap` | 更新 IMAP 配置 |

## 邮件系统

- **发送**: Resend API (主) / SMTP (备)
- **接收**: IMAP 轮询监听回复
- **测试模式**: `.env` 中设置 `EMAIL_TEST_TO` 后所有邮件转发到测试邮箱
- **自动发送**: 通过 Web UI 或 API 开启，英国工作日自动发送

## 常用运维命令

```bash
# 查看容器状态
docker ps

# 查看日志
docker logs uk-supplier-api --tail 50
docker logs openclaw-gateway --tail 50

# 重启
docker compose restart

# 重建部署
docker compose up -d --build

# 数据库迁移
docker exec uk-supplier-api npm run migrate
```

## Law Society 爬虫说明

Law Society 使用 Google reCAPTCHA Enterprise 做浏览器验证。爬虫使用 Puppeteer + Stealth 插件，
通过不设置 `waitUntil` 让页面自然完成验证流程（通常 10-50 秒），然后轮询检查结果。
详见 `src/sources/lawsociety-daily.js` 中的注释。

## 目录结构

```
├── docker-compose.yml    # Docker Compose 配置
├── Dockerfile            # 主服务镜像（含 Chromium + Xvfb）
├── ecosystem.config.js   # PM2 进程管理配置
├── src/
│   ├── server.js         # Express API 服务
│   ├── ingest.js         # 数据采集入库主流程
│   ├── scheduler.js      # 定时任务调度器
│   ├── migrate.js        # 数据库迁移
│   ├── sources/
│   │   ├── sra.js              # SRA API 数据源
│   │   ├── lawsociety-daily.js # Law Society 爬虫
│   │   └── faculty-office.js   # Faculty Office 爬虫
│   ├── lib/
│   │   ├── auto-sender.js      # 自动邮件发送
│   │   ├── email-monitor.js    # IMAP 回复监听
│   │   └── proxy.js            # 代理支持
│   └── db/
│       └── index.js            # SQLite 数据库操作
├── data/                 # SQLite 数据库文件
├── logs/                 # 日志目录
├── output/               # 采集报告输出
├── public/               # Web UI 静态文件
└── openclaw-config/      # OpenClaw 配置
```
