# UK Supplier Intake - 多数据源律师事务所采集系统

## 数据源

### 1. SRA (Solicitors Regulation Authority) - 官方 API
- **状态**: ✅ 已实现并可用
- **数据质量**: 高（官方监管数据）
- **更新频率**: 实时
- **需要**: API 订阅密钥

### 2. Law Society - 网页爬虫
- **状态**: ⚠️ 框架已搭建，需要调整选择器
- **数据质量**: 中（会员数据）
- **更新频率**: 需定期爬取
- **需要**: Puppeteer 浏览器自动化

## 环境配置

复制 `.env` 文件并配置：

```bash
# SRA API 配置
SRA_API_KEY=your_subscription_key_here
SRA_API_URL=https://sra-prod-apim.azure-api.net/datashare/api/V1/organisation/GetAll

# 通用配置
WORK_AREAS=Immigration,Private client
MAX_ORGS=0

# Law Society 爬虫配置
LAW_SOCIETY_MAX_PAGES=5
SOURCE=all
```

## 使用方法

### 安装依赖
```bash
npm install
```

### 数据采集

```bash
# 采集所有数据源（默认）
npm run ingest

# 只采集 SRA 数据
SOURCE=sra npm run ingest

# 只采集 Law Society 数据
SOURCE=lawsociety npm run ingest
```

### 启动 API 服务器
```bash
npm start
# 或开发模式
npm run dev
```

## Law Society 爬虫调试

由于 Law Society 网站有反爬虫保护，需要先调试：

```bash
# 运行调试脚本（会打开浏览器）
node debug-lawsociety.js
```

调试脚本会：
1. 打开浏览器访问网站
2. 保存页面 HTML 到 `lawsociety-page.html`
3. 保存截图到 `lawsociety-screenshot.png`
4. 尝试查找可能的 CSS 选择器

然后根据实际 HTML 结构，更新 `src/sources/lawsociety.js` 中的选择器。

## 项目结构

```
uk-supplier-intake/
├── src/
│   ├── sources/
│   │   ├── sra.js           # SRA API 数据源
│   │   └── lawsociety.js    # Law Society 爬虫
│   ├── ingest.js            # 数据采集主程序
│   ├── db.js                # 数据库操作
│   └── server.js            # API 服务器
├── test-lawsociety.js       # Law Society 测试脚本
├── debug-lawsociety.js      # Law Society 调试脚本
└── .env                     # 环境配置
```

## API 端点

- `GET /api/organisations` - 获取所有律师事务所
- `GET /api/organisations/:id` - 获取单个律师事务所
- `GET /api/runs` - 获取采集历史

## 注意事项

1. **SRA API Key**: 需要在 SRA 官网申请订阅密钥
2. **Law Society 爬虫**: 需要根据网站实际结构调整选择器
3. **反爬虫**: Law Society 有 Cloudflare 保护，可能需要代理或更高级的绕过技术
4. **数据去重**: 系统会自动根据 `source` 和 `external_id` 去重

## 下一步

- [ ] 分析 Law Society 网站结构
- [ ] 更新 CSS 选择器
- [ ] 测试爬虫功能
- [ ] 设置定时任务自动采集
