# 每日爬取 Law Society 数据 - 完整方案

## 🎯 解决方案

成功实现**每天爬取 Law Society 数据**，同时避免 IP 被封！

### 核心策略

1. **智能分页** - 每天爬取不同的页段，避免重复
2. **代理 IP 支持** - 可选使用免费代理 IP 轮换
3. **进度记录** - 自动记录爬取进度，断点续爬
4. **循环爬取** - 爬完一轮后自动重新开始

## 工作原理

### 分页策略

假设 Law Society 有 1000 页数据，每天爬 5 页：

```
第 1 天: 爬取第 1-5 页
第 2 天: 爬取第 6-10 页
第 3 天: 爬取第 11-15 页
...
第 200 天: 爬取第 996-1000 页
第 201 天: 重新开始，爬取第 1-5 页
```

**优点**：
- ✅ 每天都能获取新数据
- ✅ 避免重复爬取同一页
- ✅ 降低被检测风险
- ✅ 200 天完成一轮全量爬取

### 代理 IP 支持

**免费代理源**：
- ProxyScrape API
- Free-Proxy-List API

**工作流程**：
1. 自动获取免费代理列表
2. 测试代理可用性
3. 使用可用代理爬取
4. 缓存代理列表（1小时）

## 配置

### .env 文件

```bash
# Law Society 每日爬取配置
LAW_SOCIETY_PAGES_PER_DAY=5    # 每天爬 5 页（约 100 条数据）
LAW_SOCIETY_USE_PROXY=false    # 是否使用代理 IP（true/false）
```

### 参数说明

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `LAW_SOCIETY_PAGES_PER_DAY` | 5 | 每天爬取的页数 |
| `LAW_SOCIETY_USE_PROXY` | false | 是否使用代理 IP |

## 使用方法

### 1. 测试爬取

```bash
node test-daily.js
```

这会：
- 显示当前爬取进度
- 爬取 2 页数据（测试用）
- 显示更新后的进度

### 2. 正式爬取

```bash
# 爬取 Law Society 数据
SOURCE=lawsociety npm run ingest
```

### 3. 设置每日定时任务

```bash
# 编辑 crontab
crontab -e

# 添加以下内容（每天凌晨 4:00）
0 4 * * * cd /Users/yyzinotary/Documents/uk-supplier-intake && SOURCE=lawsociety npm run ingest >> logs/lawsociety.log 2>&1
```

## 代理 IP 使用

### 启用代理

```bash
# 修改 .env
LAW_SOCIETY_USE_PROXY=true

# 运行爬取
SOURCE=lawsociety npm run ingest
```

系统会自动：
1. 获取免费代理列表
2. 测试代理可用性
3. 使用可用代理爬取
4. 如果没有可用代理，直接连接

### 使用付费代理（推荐）

如果免费代理不稳定，可以使用付费代理服务：

**推荐服务**：
- [Bright Data](https://brightdata.com/) - $50/月起
- [Oxylabs](https://oxylabs.io/) - $100/月起
- [Webshare](https://www.webshare.io/) - $10/月起

**配置方法**：

修改 `src/sources/lawsociety-daily.js`：

```javascript
// 在 searchSolicitorsDaily 函数中
const proxyServer = "http://username:password@proxy.example.com:8080";
```

## 进度管理

### 查看当前进度

```bash
cat data/lawsociety-state.json
```

输出示例：
```json
{
  "lastPageStart": 11,
  "totalPages": 1000,
  "lastRunDate": "2026-04-03"
}
```

### 重置进度（重新开始）

```bash
rm data/lawsociety-state.json
```

下次运行将从第 1 页开始。

### 手动设置进度

编辑 `data/lawsociety-state.json`：

```json
{
  "lastPageStart": 100,
  "totalPages": 1000,
  "lastRunDate": "2026-04-03"
}
```

下次将从第 100 页开始。

## 性能和成本

### 每天爬取 5 页

- **数据量**: 约 100 条/天
- **耗时**: 约 10-15 分钟
- **完整一轮**: 200 天
- **年数据量**: 约 36,500 条

### 每天爬取 10 页

- **数据量**: 约 200 条/天
- **耗时**: 约 20-30 分钟
- **完整一轮**: 100 天
- **年数据量**: 约 73,000 条

### 代理成本

| 方案 | 成本 | 稳定性 |
|------|------|--------|
| 免费代理 | $0 | 低（30-50%） |
| Webshare | $10/月 | 中（70-80%） |
| Bright Data | $50/月 | 高（95%+） |

## 完整调度方案

### 推荐配置

```bash
# 每天凌晨 2:00 - SRA API（主力）
0 2 * * * SOURCE=sra npm run ingest

# 每天凌晨 3:00 - Faculty Office
0 3 * * * SOURCE=facultyoffice npm run ingest

# 每天凌晨 4:00 - Law Society（每日爬取）
0 4 * * * SOURCE=lawsociety npm run ingest
```

### 数据积累预估

假设每天爬 5 页：

| 时间 | Law Society 数据 | SRA 数据 | Faculty Office | 总计 |
|------|------------------|----------|----------------|------|
| 1 周 | 700 | 214,596 | 500 | 215,796 |
| 1 月 | 3,000 | 214,596 | 500 | 218,096 |
| 3 月 | 9,000 | 214,596 | 500 | 224,096 |
| 6 月 | 18,000 | 214,596 | 500 | 233,096 |
| 1 年 | 36,500 | 214,596 | 500 | 251,596 |

## 监控和维护

### 查看日志

```bash
# 实时查看
tail -f logs/lawsociety.log

# 查看最近 50 行
tail -50 logs/lawsociety.log

# 查看成功率
grep "验证通过" logs/lawsociety.log | wc -l
```

### 数据库统计

```bash
# 按数据源统计
sqlite3 data/organisations.db "SELECT source, COUNT(*) FROM organisations GROUP BY source;"

# Law Society 数据统计
sqlite3 data/organisations.db "SELECT COUNT(*) FROM organisations WHERE source='lawsociety_scraper';"
```

### 故障排查

**问题 1: 验证失败率高**

解决方案：
1. 启用代理 IP
2. 减少每天爬取页数
3. 调整爬取时间（避开高峰）

**问题 2: 代理不可用**

解决方案：
1. 使用付费代理服务
2. 或者禁用代理，直接连接

**问题 3: 进度丢失**

解决方案：
1. 检查 `data/lawsociety-state.json` 是否存在
2. 手动恢复进度

## 最佳实践

1. **每天爬 5-10 页** - 平衡数据量和风险
2. **凌晨爬取** - 避开高峰时段
3. **启用代理** - 降低被封风险（可选）
4. **定期检查日志** - 监控成功率
5. **备份数据库** - 定期备份 SQLite 数据库

## 相关文件

- [lawsociety-daily.js](src/sources/lawsociety-daily.js) - 每日爬取实现
- [proxy.js](src/lib/proxy.js) - 代理 IP 管理
- [ingest.js](src/ingest.js) - 数据采集主程序
- [test-daily.js](test-daily.js) - 测试脚本

## 参考资源

- [How To Set Up a Rotating Proxy in Puppeteer](https://www.scrapingbee.com/blog/how-to-set-up-a-rotating-proxy-in-puppeteer/)
- [Puppeteer Proxy Guide](https://blog.apify.com/puppeteer-proxy/)
- [Web Scraping with Puppeteer](https://www.scraperapi.com/web-scraping/puppeteer/)

---

**现在你可以每天爬取 Law Society 数据，同时避免 IP 被封！** 🎉
