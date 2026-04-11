# UK Supplier Intake API - OpenClaw 技能接口文档

Base URL: `http://localhost:3000`

---

## 1. 数据查询类

### 1.1 搜索供应商
**接口**: `GET /api/organisations`

**用途**: 按条件搜索律所/公证人

**参数**:
- `page` (int): 页码，默认 1
- `pageSize` (int): 每页数量，默认 50，最大 200
- `search` (string): 搜索关键词（名称/城市/邮编/邮箱）
- `source` (string): 数据来源过滤
  - `sra_api` - SRA 律所
  - `lawsociety_scraper` - Law Society 律师
  - `facultyoffice` - 公证人
- `sort` (string): 排序字段 (id/name/city/postcode/created_at/updated_at)
- `order` (string): asc/desc
- `apostille_qualified` (int): 海牙认证资质 (1=有, 0=无)
- `email_sent` (int): 邮件状态 (1=已发, 0=未发)

**响应示例**:
```json
{
  "rows": [
    {
      "id": 1,
      "source": "sra_api",
      "external_id": "12345",
      "name": "Smith & Partners LLP",
      "email": "info@smith.co.uk",
      "telephone": "020 1234 5678",
      "city": "London",
      "postcode": "SW1A 1AA",
      "website": "https://smith.co.uk",
      "work_areas": "[\"Immigration\",\"Notary\"]",
      "apostille_qualified": 1,
      "email_sent": 0,
      "created_at": "2026-04-03 09:21:32"
    }
  ],
  "total": 2476,
  "page": 1,
  "pageSize": 50
}
```

---

### 1.2 获取统计数据
**接口**: `GET /api/stats`

**用途**: 获取总体数据统计

**响应示例**:
```json
{
  "total": 2476,
  "lastRun": {
    "source": "sra_api",
    "started_at": "2026-04-03T09:20:40.035Z",
    "finished_at": "2026-04-03T09:21:32.964Z",
    "org_kept": 1771
  }
}
```

---

### 1.3 获取邮件统计
**接口**: `GET /api/email-stats`

**用途**: 获取邮件发送统计

**响应示例**:
```json
{
  "sent": 0,
  "unsent": 2476
}
```

---

### 1.4 获取数据质量报告
**接口**: `GET /api/quality-stats`

**用途**: 获取各字段完整度统计

**参数**:
- `source` (string, 可选): 按来源过滤

**响应示例**:
```json
{
  "perField": [
    { "field": "email", "filled": 2100, "total": 2476, "pct": 84.8 },
    { "field": "telephone", "filled": 2300, "total": 2476, "pct": 92.9 }
  ],
  "perSource": [
    {
      "source": "sra_api",
      "total": 1771,
      "fields": {
        "email": { "filled": 1500, "pct": 84.7 }
      }
    }
  ]
}
```

---

## 2. 邮件营销类

### 2.1 邮件操作接口（统一入口）⭐ 核心接口
**接口**: `POST /api/email/action`

**用途**: 
- 根据 `action` 参数执行不同操作
- `action=query`: 只查询待发送列表，不修改数据库
- `action=send`: 查询并立即标记为已发送

---

#### 模式 1: 查询模式（只查询，不标记）

**请求体**:
```json
{
  "action": "query",
  "count": 10,
  "source": "sra_api"
}
```

**参数说明**:
- `action` (string, 必填): `"query"` - 只查询
- `count` (int, 必填): 需要获取的记录数，最大 200
- `source` (string, 可选): 指定数据来源

**响应示例**:
```json
{
  "action": "query",
  "count": 10,
  "rows": [
    {
      "id": 1,
      "source": "sra_api",
      "name": "Smith & Partners LLP",
      "email": "info@smith.co.uk",
      "telephone": "020 1234 5678",
      "city": "London",
      "postcode": "SW1A 1AA",
      "website": "https://smith.co.uk",
      "organisation_type": "Law Firm",
      "work_areas": "[\"Immigration\",\"Notary\"]",
      "apostille_qualified": 1
    }
  ]
}
```

**说明**: 
- 数据库状态不会改变
- 适合预览、统计、确认

---

#### 模式 2: 发送模式（查询并标记）

**请求体**:
```json
{
  "action": "send",
  "count": 10,
  "source": "sra_api"
}
```

**参数说明**:
- `action` (string, 必填): `"send"` - 发送邮件（会标记）
- `count` (int, 必填): 需要获取的记录数，最大 200
- `source` (string, 可选): 指定数据来源

**响应示例**:
```json
{
  "action": "send",
  "count": 10,
  "marked_as_sent": true,
  "rows": [
    {
      "id": 1,
      "source": "sra_api",
      "name": "Smith & Partners LLP",
      "email": "info@smith.co.uk",
      "telephone": "020 1234 5678",
      "city": "London",
      "postcode": "SW1A 1AA",
      "website": "https://smith.co.uk",
      "organisation_type": "Law Firm",
      "work_areas": "[\"Immigration\",\"Notary\"]",
      "apostille_qualified": 1
    }
  ]
}
```

**说明**:
- 返回的记录**已被标记为已发送**
- `email_sent = 1`
- `email_sent_at` = 当前时间
- `email_send_count` 自增 1
- **不可逆操作**，请确认后再调用

---

**错误响应**:
```json
{
  "error": "action must be 'query' or 'send'"
}
```

---

## 3. 数据导出类

### 3.1 导出 CSV
**接口**: `GET /api/export-orgs`

**用途**: 按条件导出 CSV 文件

**参数**: 与 `/api/organisations` 相同（支持所有筛选条件）

**响应**: CSV 文件下载

---

## 4. 数据源管理类

### 4.1 查看数据源列表
**接口**: `GET /api/sources`

**响应示例**:
```json
[
  {
    "code": "sra_api",
    "name": "SRA Data Sharing API",
    "country": "GB",
    "website": "https://sra-prod-apim.azure-api.net",
    "created_at": "2026-04-03 09:20:00"
  }
]
```

---

### 4.2 查看采集历史
**接口**: `GET /api/runs`

**参数**:
- `source` (string, 可选): 按来源过滤

**响应示例**:
```json
[
  {
    "run_id": "2026-04-03T09:20:40.035Z_abc123",
    "source": "sra_api",
    "started_at": "2026-04-03T09:20:40.035Z",
    "finished_at": "2026-04-03T09:21:32.964Z",
    "org_total": 2000,
    "org_kept": 1771,
    "config": "{\"filters\":...}"
  }
]
```

---

### 4.3 查看下次更新时间
**接口**: `GET /api/next-updates`

**响应示例**:
```json
[
  {
    "source": "sra_api",
    "label": "SRA",
    "cron": "weekly_mon_2",
    "last_run": "2026-04-03 09:21:32"
  }
]
```

---

## OpenClaw 技能定义建议

### Skill 1: search_uk_suppliers
```yaml
name: search_uk_suppliers
description: 搜索英国法律服务供应商（律所/律师/公证人）
endpoint: GET /api/organisations
parameters:
  - search: 搜索关键词
  - source: 数据来源 (sra_api/lawsociety_scraper/facultyoffice)
  - apostille_qualified: 是否有海牙认证资质
  - email_sent: 邮件发送状态
  - pageSize: 返回数量（默认50）
```

### Skill 2: fetch_suppliers_for_email
```yaml
name: fetch_suppliers_for_email
description: 获取待发送邮件的供应商列表（自动标记为已发送）
endpoint: POST /api/email/fetch-and-mark
parameters:
  - send_email: true (固定值)
  - count: 需要获取的数量
  - source: 可选，指定数据来源
warning: 调用此接口后，返回的记录会立即标记为已发送
```

### Skill 3: get_supplier_stats
```yaml
name: get_supplier_stats
description: 获取供应商数据统计（总数、已发送邮件数、待发送数）
endpoint: GET /api/stats + GET /api/email-stats
```

### Skill 4: export_suppliers_csv
```yaml
name: export_suppliers_csv
description: 导出供应商数据为 CSV 文件
endpoint: GET /api/export-orgs
parameters:
  - source: 数据来源过滤
  - apostille_qualified: 资质过滤
  - email_sent: 邮件状态过滤
```

### Skill 5: check_data_quality
```yaml
name: check_data_quality
description: 检查数据质量（各字段完整度）
endpoint: GET /api/quality-stats
parameters:
  - source: 可选，按来源查看
```

---

## 使用场景示例

### 场景 1: 批量发送营销邮件
```bash
# Step 1: OpenClaw 调用接口获取 50 条待发送记录
POST /api/email/fetch-and-mark
{
  "send_email": true,
  "count": 50,
  "source": "sra_api"
}

# Step 2: OpenClaw 使用返回的 email 字段发送邮件
# （后端已自动标记为已发送，无需回调）
```

### 场景 2: 查找有海牙认证资质的公证人
```bash
GET /api/organisations?source=facultyoffice&apostille_qualified=1&pageSize=100
```

### 场景 3: 导出所有未发送邮件的律所
```bash
GET /api/export-orgs?email_sent=0&source=sra_api
```

---

## 注意事项

1. **邮件接口是单向的**: 调用 `/api/email/fetch-and-mark` 后立即标记，无需回调
2. **防重发机制**: 已标记的记录不会再次返回
3. **数据更新频率**:
   - SRA: 每周一凌晨 2 点
   - Law Society: 每天凌晨 3 点
   - Faculty Office: 每周一凌晨 4 点
4. **速率限制**: 60 秒内最多 120 次请求
5. **服务地址**: 需要确保 PM2 服务运行中（`pm2 list` 检查）
