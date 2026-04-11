# 数据采集调度策略

## 推荐方案

### 方案 A：保守型（推荐）

适合长期稳定运行，避免被封。

```bash
# 每天早上 2:00 - SRA API（快速，无限制）
0 2 * * * cd /path/to/project && SOURCE=sra npm run ingest

# 每天早上 3:00 - Faculty Office（轻量）
0 3 * * * cd /path/to/project && SOURCE=facultyoffice npm run ingest

# 每周一早上 4:00 - Law Society（慢，有限制）
0 4 * * 1 cd /path/to/project && SOURCE=lawsociety npm run ingest
```

**特点**：
- SRA 每天更新（主要数据源）
- Faculty Office 每天更新（补充数据）
- Law Society 每周更新（避免频繁请求）

---

### 方案 B：积极型

适合快速积累数据，但有一定风险。

```bash
# 每天早上 2:00 - SRA API
0 2 * * * cd /path/to/project && SOURCE=sra npm run ingest

# 每天早上 3:00 - Faculty Office
0 3 * * * cd /path/to/project && SOURCE=facultyoffice npm run ingest

# 每周一、四早上 4:00 - Law Society
0 4 * * 1,4 cd /path/to/project && SOURCE=lawsociety npm run ingest
```

**特点**：
- Law Society 每周 2 次
- 数据更新更及时
- 风险略高

---

### 方案 C：按需型

手动控制，最灵活。

```bash
# 每天自动 - SRA + Faculty Office
0 2 * * * cd /path/to/project && SOURCE=sra npm run ingest
0 3 * * * cd /path/to/project && SOURCE=facultyoffice npm run ingest

# Law Society 手动执行（需要时）
# SOURCE=lawsociety npm run ingest
```

**特点**：
- 主要数据源自动化
- Law Society 手动控制
- 最安全

---

## Law Society 爬取参数建议

### 增量爬取（推荐）

```bash
# .env 配置
LAW_SOCIETY_MAX_PAGES=5    # 只爬前 5 页（最新数据）
MAX_ORGS=100               # 最多 100 条
```

**优点**：
- 快速（约 10 分钟）
- 低风险
- 获取最新数据

**适用场景**：
- 每周定期更新
- 补充 SRA 数据

---

### 全量爬取

```bash
# .env 配置
LAW_SOCIETY_MAX_PAGES=0    # 爬取所有页面
MAX_ORGS=0                 # 不限制数量
```

**优点**：
- 数据完整
- 覆盖全面

**缺点**：
- 耗时长（可能数小时）
- 风险高（容易被检测）

**适用场景**：
- 初次建库
- 每月 1 次全量更新

---

## 风险控制

### Law Society 爬取注意事项

1. **避免高峰时段**
   - 建议凌晨 2:00-6:00（英国时间）
   - 避免工作时间（9:00-18:00）

2. **间隔时间**
   - 每次爬取后至少间隔 **3-7 天**
   - 不要连续多天爬取

3. **IP 轮换**（可选）
   - 如果有条件，使用代理 IP
   - 或者使用 VPN

4. **监控成功率**
   - 如果验证失败率 > 50%，暂停 1-2 周
   - 调整爬取频率

---

## 数据更新频率对比

| 数据源 | 推荐频率 | 单次耗时 | 风险 | 数据量 |
|--------|----------|----------|------|--------|
| SRA API | 每天 | 2-5 分钟 | 无 | 214,596 |
| Faculty Office | 每天 | 5-10 分钟 | 低 | 数百 |
| Law Society | 每周 | 10-60 分钟 | 中 | 可配置 |

---

## 实施步骤

### 1. 设置 Cron 任务

```bash
# 编辑 crontab
crontab -e

# 添加以下内容（方案 A）
0 2 * * * cd /Users/yyzinotary/Documents/uk-supplier-intake && SOURCE=sra npm run ingest >> logs/sra.log 2>&1
0 3 * * * cd /Users/yyzinotary/Documents/uk-supplier-intake && SOURCE=facultyoffice npm run ingest >> logs/faculty.log 2>&1
0 4 * * 1 cd /Users/yyzinotary/Documents/uk-supplier-intake && SOURCE=lawsociety npm run ingest >> logs/lawsociety.log 2>&1
```

### 2. 创建日志目录

```bash
mkdir -p logs
```

### 3. 配置 .env

```bash
# Law Society 增量爬取配置
LAW_SOCIETY_MAX_PAGES=5
MAX_ORGS=100

# SRA 配置
SRA_API_KEY=your_key_here
WORK_AREAS=Immigration,Private client

# Faculty Office 配置
FACULTYOFFICE_MAX_PAGES=0
FACULTYOFFICE_DELAY_MS=1500
```

### 4. 测试运行

```bash
# 测试 SRA
SOURCE=sra npm run ingest

# 测试 Faculty Office
SOURCE=facultyoffice npm run ingest

# 测试 Law Society（需要 90 秒）
SOURCE=lawsociety npm run ingest
```

---

## 监控和维护

### 检查日志

```bash
# 查看最近的 SRA 日志
tail -f logs/sra.log

# 查看 Law Society 成功率
grep "验证通过" logs/lawsociety.log | wc -l
```

### 数据库统计

```bash
# 查看总记录数
sqlite3 data/organisations.db "SELECT COUNT(*) FROM organisations;"

# 按数据源统计
sqlite3 data/organisations.db "SELECT source, COUNT(*) FROM organisations GROUP BY source;"
```

---

## 最终建议

**推荐使用方案 A（保守型）**：

1. **SRA API** - 每天自动（主要数据源）
2. **Faculty Office** - 每天自动（补充数据）
3. **Law Society** - 每周一次（避免风险）

这样可以：
- ✅ 保持数据新鲜度
- ✅ 降低被封风险
- ✅ 平衡效率和安全

如果需要更频繁的 Law Society 数据，可以考虑：
- 使用付费验证码服务（2Captcha）
- 使用代理 IP 池
- 或者接受每周 1 次的频率
