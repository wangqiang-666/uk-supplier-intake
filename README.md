# UK SRA Law Firm Scraper - 部署指南

## 项目说明

从英国律师监管局 (SRA) API 抓取律所数据，筛选 Immigration 和 Private Client 专业的律师，用于供应商开发。

## 当前状态

**数据抓取方式**：手动执行 `npm run scrape`
**服务器运行**：需要另外启动

## 部署到服务器 (推荐方式)

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制并编辑 `.env` 文件：

```bash
cp .env.example .env
# 编辑 .env，填入 SRA_API_KEY
```

必需配置：
- `SRA_API_KEY` - SRA API 订阅密钥
- `SRA_API_URL` - API 地址（默认已配置）
- `WORK_AREAS` - 筛选专业领域，默认 `Immigration,Private client`

### 3. 安装 PM2 (进程管理器)

```bash
npm install -g pm2
```

### 4. 启动服务

```bash
# 启动 API 服务器
pm2 start ecosystem.config.js --only sra-api-server

# 启动定时抓取任务（每天早上6点执行）
pm2 start ecosystem.config.js --only sra-scraper

# 查看状态
pm2 list

# 查看日志
pm2 logs sra-api-server
pm2 logs sra-scraper
```

### 5. 开机自启

```bash
pm2 save
pm2 startup
# 根据提示执行生成的命令
```

## PM2 配置说明

`ecosystem.config.js` 配置了两个进程：

| 进程 | 功能 | 定时策略 |
|------|------|----------|
| `sra-api-server` | API 服务器 (端口 3000) | 常驻运行 |
| `sra-scraper` | 数据抓取 | 每天 06:00 执行 |

修改定时时间，编辑 `ecosystem.config.js`：

```javascript
cron_restart: '0 6 * * *'  // 每天早上6点
// cron_restart: '0 */4 * * *'  // 每4小时执行一次
// cron_restart: '0 9,12,15,18 * * *'  // 每天9点、12点、15点、18点执行
```

## 手动操作

```bash
# 手动抓取数据
npm run scrape

# 启动服务器（不自动抓取）
npm start

# 开发模式（带热重载）
npm run dev
```

## Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["pm2-runtime", "ecosystem.config.js"]
```

构建运行：

```bash
docker build -t sra-scraper .
docker run -d -p 3000:3000 --env-file .env sra-scraper
```

## API 接口

| 接口 | 说明 |
|------|------|
| `GET /` | Web 界面 |
| `GET /api/stats` | 统计数据 |
| `GET /api/organisations` | 律所列表（支持分页、搜索、排序） |
| `GET /api/export-orgs` | 导出 CSV |

## 数据流向

```
SRA API → ingest.js (抓取+筛选) → SQLite DB → server.js (API) → Web UI
```

## 故障排除

```bash
# 查看所有日志
pm2 logs

# 重启服务
pm2 restart sra-api-server

# 清理日志
pm2 flush

# 监控资源使用
pm2 monit
```
