# 快速开始指南

## 1. 安装依赖

```bash
npm install
```

## 2. 配置环境变量

编辑 `.env` 文件：

```bash
# SRA API 密钥（必需）
SRA_API_KEY=your_key_here

# 业务领域过滤（可选）
WORK_AREAS=Immigration,Private client

# 数据源选择
SOURCE=all          # all | sra | lawsociety
```

## 3. 运行数据采集

### 采集所有数据源
```bash
npm run ingest
```

### 只采集 SRA 数据
```bash
SOURCE=sra npm run ingest
```

### 只采集 Law Society 数据
```bash
SOURCE=lawsociety npm run ingest
```

## 4. 启动 API 服务器

```bash
npm start
```

访问: http://localhost:3000/api/organisations

## 5. 测试 Law Society 爬虫

```bash
# 测试爬虫（会打开浏览器）
node test-lawsociety.js

# 调试网站结构
node debug-lawsociety.js
```

## 常见问题

### Q: Law Society 爬虫失败？
A: 网站有 reCAPTCHA 保护，可能需要：
- 等待更长时间让验证完成
- 使用验证码解决服务（2Captcha）
- 或者只使用 SRA API（推荐）

### Q: SRA API 返回 401？
A: 检查 `.env` 中的 `SRA_API_KEY` 是否正确

### Q: 如何设置定时采集？
A: 使用 cron 或系统定时任务：
```bash
# 每天凌晨 2 点采集
0 2 * * * cd /path/to/project && npm run ingest
```

## 项目结构

```
├── src/
│   ├── sources/
│   │   ├── sra.js          # SRA API 数据源
│   │   └── lawsociety.js   # Law Society 爬虫
│   ├── ingest.js           # 数据采集主程序
│   ├── db.js               # 数据库操作
│   └── server.js           # API 服务器
├── data/
│   └── organisations.db    # SQLite 数据库
├── output/                 # 采集日志和摘要
└── .env                    # 环境配置
```

## API 端点

- `GET /api/organisations` - 获取所有律师事务所
- `GET /api/organisations/:id` - 获取单个律师事务所
- `GET /api/runs` - 获取采集历史

## 下一步

- 查看 [README-DATASOURCES.md](README-DATASOURCES.md) 了解数据源详情
- 查看 [LAWSOCIETY-SOLUTIONS.md](LAWSOCIETY-SOLUTIONS.md) 了解 Law Society 爬虫方案
