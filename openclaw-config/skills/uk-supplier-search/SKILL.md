---
name: uk-supplier-search
description: 查询英国法律服务供应商数据库。当用户需要查找英国律所、公证处、律师信息，查询供应商统计、数据质量、邮件状态，或管理数据采集时触发此技能。关键词：律所、公证、notary、solicitor、law firm、供应商、supplier、查询、搜索、统计、邮件、采集、抓取。
metadata:
  {
    "openclaw": { "emoji": "🔍" },
  }
---

# 英国法律服务供应商 API 完整手册

API 基地址：`http://uk-supplier-api:3000`

数据库包含 **2500+** 条英国律所和公证处数据，来自 3 个数据源（SRA、Law Society、Faculty Office），每天自动更新。

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
# 可按数据源筛选：
curl -s "http://uk-supplier-api:3000/api/stats?source=sra_api"
```
返回：organisations（总数）、lastRun（最近一次采集信息）

### 4. 数据质量统计
```bash
curl -s "http://uk-supplier-api:3000/api/quality-stats"
# 可按数据源筛选：
curl -s "http://uk-supplier-api:3000/api/quality-stats?source=facultyoffice"
```
返回：total（总数）、completeness（各字段完整率百分比：email/postcode/city/telephone/website/work_areas）、perSource（各数据源明细）

### 5. 邮件统计
```bash
curl -s "http://uk-supplier-api:3000/api/email-stats"
# 可按数据源筛选：
curl -s "http://uk-supplier-api:3000/api/email-stats?source=sra_api"
```
返回：sent（已发送数）、unsent（未发送数）

---

## 三、数据源和采集管理

### 6. 数据来源列表
```bash
curl -s "http://uk-supplier-api:3000/api/sources"
```

### 7. 采集运行历史
```bash
curl -s "http://uk-supplier-api:3000/api/runs"
# 可按数据源筛选：
curl -s "http://uk-supplier-api:3000/api/runs?source=lawsociety_scraper"
```
返回最近 30 次采集记录，含 run_id、source、started_at、finished_at、org_total、org_kept

### 8. 下次更新时间
```bash
curl -s "http://uk-supplier-api:3000/api/next-updates"
```
返回各数据源的调度计划和最后一次成功运行时间

### 9. 手动触发采集（谨慎使用）
```bash
curl -s -X POST "http://uk-supplier-api:3000/api/trigger-scrape" \
  -H "Content-Type: application/json" \
  -d '{"source": "lawsociety"}'
```
source 可选值：sra / lawsociety / facultyoffice

---

## 四、邮件营销

### 10. 查询或标记待发送邮件
```bash
# 查询未发送的供应商（不标记）
curl -s -X POST "http://uk-supplier-api:3000/api/email/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "query", "count": 10}'

# 查询并标记为已发送
curl -s -X POST "http://uk-supplier-api:3000/api/email/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "send", "count": 10}'

# 按数据源筛选
curl -s -X POST "http://uk-supplier-api:3000/api/email/action" \
  -H "Content-Type: application/json" \
  -d '{"action": "query", "count": 10, "source": "sra_api"}'
```

---

## 五、导出

### 11. 导出 CSV
```bash
curl -s "http://uk-supplier-api:3000/api/export-orgs"
# 可筛选：
curl -s "http://uk-supplier-api:3000/api/export-orgs?source=sra_api&search=london"
```

---

## 自动采集调度（已配置，无需手动干预）

| 数据源 | 频率 | 时间 |
|--------|------|------|
| SRA | 每周一 | 02:00 |
| Law Society | 每天 | 03:00 |
| Faculty Office | 每周一 | 04:00 |

---

## 用户意图 → 接口映射

| 用户说 | 调用接口 |
|--------|----------|
| 查找伦敦的律所 | /api/organisations?search=london |
| 有多少供应商 | /api/stats |
| 数据质量怎么样 | /api/quality-stats |
| 邮件发了多少 | /api/email-stats |
| 最近采集情况 | /api/runs + /api/next-updates |
| 手动抓一下 Law Society | POST /api/trigger-scrape |
| 帮我找公证人 | /api/organisations?search=notary 或 source=facultyoffice |
| 查下SRA的数据 | /api/organisations?source=sra_api |
| 导出所有数据 | /api/export-orgs |
| 取10个未发邮件的 | POST /api/email/action {query, 10} |
