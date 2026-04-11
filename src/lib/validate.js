/**
 * 数据验证与地址解析库
 * 用于确保3个数据源（SRA、Law Society、Faculty Office）的数据质量
 */

// UK 邮编正则 - 覆盖全部6种格式
const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const UK_POSTCODE_EXTRACT_RE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

// 已知国家/地区名称（用于从地址尾部识别）
const KNOWN_COUNTRIES = [
  "england", "scotland", "wales", "northern ireland",
  "united kingdom", "uk", "great britain",
];

// 已知英国大城市（辅助city识别）
const KNOWN_CITIES = new Set([
  "london", "birmingham", "manchester", "leeds", "liverpool",
  "sheffield", "bristol", "newcastle", "nottingham", "leicester",
  "coventry", "bradford", "cardiff", "belfast", "edinburgh",
  "glasgow", "aberdeen", "dundee", "swansea", "southampton",
  "portsmouth", "reading", "oxford", "cambridge", "bath",
  "exeter", "york", "chester", "norwich", "brighton",
  "plymouth", "wolverhampton", "derby", "stoke-on-trent",
  "sunderland", "hull", "middlesbrough", "luton", "ipswich",
  "colchester", "guildford", "stockport", "hemel hempstead",
]);

/**
 * 解析UK地址字符串为结构化字段
 * 示例: "11 Edward Street, Truro, Cornwall, TR1 3AR, England"
 * → { address_line1: "11 Edward Street", city: "Truro", county: "Cornwall", postcode: "TR1 3AR", country: "England" }
 */
function parseUkAddress(addressStr) {
  const result = {
    address_line1: "",
    address_line2: "",
    address_line3: "",
    city: "",
    county: "",
    postcode: "",
    country: "",
  };

  if (!addressStr || typeof addressStr !== "string") return result;

  const raw = addressStr.trim();
  if (!raw) return result;

  // 按逗号拆分
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);

  if (parts.length === 0) return result;

  // 1. 从尾部识别并移除国家
  const lastPart = parts[parts.length - 1].toLowerCase();
  if (KNOWN_COUNTRIES.includes(lastPart)) {
    result.country = parts.pop().trim();
  }

  // 2. 提取邮编（可能在任何位置，但通常靠近尾部）
  let postcodeIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const match = parts[i].match(UK_POSTCODE_EXTRACT_RE);
    if (match) {
      result.postcode = match[1].toUpperCase().replace(/\s+/g, " ");
      // 如果这个part只包含邮编，整个移除；否则移除邮编部分
      const remainder = parts[i].replace(UK_POSTCODE_EXTRACT_RE, "").trim().replace(/^,|,$/g, "").trim();
      if (remainder) {
        parts[i] = remainder;
      } else {
        parts.splice(i, 1);
      }
      postcodeIdx = i;
      break;
    }
  }

  // 3. 识别城市 - 尝试从剩余parts的尾部识别
  if (parts.length > 0) {
    // 策略：从后往前找已知城市，或使用最后一个非地址行的part
    let cityFound = false;

    // 先查已知城市
    for (let i = parts.length - 1; i >= 0; i--) {
      if (KNOWN_CITIES.has(parts[i].toLowerCase())) {
        result.city = parts.splice(i, 1)[0];
        cityFound = true;
        break;
      }
    }

    // 如果没找到已知城市，且还有2+个parts，取倒数第一个作为city
    // (倒数第一个通常是city或county)
    if (!cityFound && parts.length >= 2) {
      // 如果最后一个part看起来像county（包含"shire"或已知county词），则它是county
      const candidate = parts[parts.length - 1];
      if (looksLikeCounty(candidate)) {
        result.county = parts.pop();
        if (parts.length >= 2) {
          result.city = parts.pop();
        }
      } else {
        result.city = parts.pop();
      }
    } else if (!cityFound && parts.length === 1) {
      // 只剩一个part，既可能是地址也可能是城市
      // 如果看起来像城市名（非数字开头），设为city
      if (!/^\d/.test(parts[0])) {
        result.city = parts.pop();
      }
    }
  }

  // 4. 剩余parts分配到address_line1, address_line2, address_line3
  if (parts.length >= 1) result.address_line1 = parts[0];
  if (parts.length >= 2) result.address_line2 = parts[1];
  if (parts.length >= 3) result.address_line3 = parts.slice(2).join(", ");

  // 5. 默认国家
  if (!result.country) {
    result.country = "United Kingdom";
  }

  return result;
}

/**
 * 判断字符串是否看起来像英国county
 */
function looksLikeCounty(s) {
  if (!s) return false;
  const lower = s.toLowerCase();
  const countyPatterns = [
    "shire", "greater london", "greater manchester",
    "west midlands", "west yorkshire", "south yorkshire",
    "east sussex", "west sussex", "east riding",
    "north yorkshire", "north somerset",
    "cornwall", "devon", "dorset", "somerset", "suffolk", "norfolk",
    "surrey", "kent", "essex", "hertfordshire", "berkshire",
    "buckinghamshire", "oxfordshire", "cambridgeshire",
    "middlesex", "merseyside", "tyne and wear",
    "isle of wight", "isle of man",
  ];
  return countyPatterns.some((p) => lower.includes(p));
}

/**
 * 验证UK邮编格式
 */
function isValidUkPostcode(s) {
  if (!s || typeof s !== "string") return false;
  return UK_POSTCODE_RE.test(s.trim());
}

/**
 * 验证邮箱格式
 */
function isValidEmail(s) {
  if (!s || typeof s !== "string") return false;
  const trimmed = s.trim();
  if (trimmed.length > 254) return false;
  // 基本格式检查
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimmed) && !/\.\./.test(trimmed);
}

/**
 * 验证UK电话号码格式
 */
function isValidUkPhone(s) {
  if (!s || typeof s !== "string") return false;
  // 去除空格、横杠、括号
  const cleaned = s.replace(/[\s\-()]/g, "");
  if (!cleaned) return false;
  // +44 开头或 0 开头
  if (/^\+44\d{9,11}$/.test(cleaned)) return true;
  if (/^0\d{9,10}$/.test(cleaned)) return true;
  return false;
}

/**
 * 字段完整性评分
 * 返回 { score: 0-100, missing: string[], warnings: string[] }
 */
function checkCompleteness(row) {
  const fields = [
    // [字段名, 权重, 显示名]
    ["name", 3, "名称"],
    ["external_id", 3, "编号"],
    ["email", 3, "邮箱"],
    ["postcode", 2, "邮编"],
    ["city", 2, "城市"],
    ["telephone", 2, "电话"],
    ["authorisation_status", 1, "执业状态"],
    ["address_line1", 1, "地址"],
    ["website", 1, "网站"],
    ["organisation_type", 1, "机构类型"],
  ];

  let totalWeight = 0;
  let earnedWeight = 0;
  const missing = [];
  const warnings = [];

  for (const [field, weight, label] of fields) {
    totalWeight += weight;
    const val = row[field];

    if (field === "work_areas") {
      const arr = Array.isArray(val) ? val : [];
      if (arr.length > 0) {
        earnedWeight += weight;
      } else {
        missing.push(label);
      }
      continue;
    }

    if (val && String(val).trim() !== "" && val !== "[]" && val !== "{}") {
      earnedWeight += weight;
    } else {
      missing.push(label);
    }
  }

  // 检查 work_areas 单独处理
  const wa = row.work_areas;
  const waArr = Array.isArray(wa) ? wa : [];
  totalWeight += 1;
  if (waArr.length > 0) {
    earnedWeight += 1;
  } else {
    missing.push("专业领域");
  }

  const score = totalWeight > 0 ? Math.round((earnedWeight / totalWeight) * 100) : 0;

  // 检查可疑的硬编码值
  if (row.authorisation_status === "Practising" && row.source === "facultyoffice") {
    // 这个已在Phase 3中修复，但作为额外检查
  }
  if (row.external_id && /^\d{13,}$/.test(row.external_id)) {
    warnings.push("external_id 疑似使用了 Date.now()");
  }

  return { score, missing, warnings };
}

/**
 * 综合验证记录
 * 返回 { valid, errors, warnings, qualityScore }
 */
function validateRecord(row) {
  const errors = [];
  const warnings = [];

  // 必填字段
  if (!row.name || row.name === "无") {
    errors.push({ field: "name", message: "名称为空或无效", value: row.name });
  }
  if (!row.external_id) {
    errors.push({ field: "external_id", message: "编号为空", value: row.external_id });
  }

  // 邮箱验证
  if (row.email) {
    if (!isValidEmail(row.email)) {
      errors.push({ field: "email", message: "邮箱格式无效", value: row.email });
    }
  } else {
    warnings.push({ field: "email", message: "缺少邮箱", value: "" });
  }

  // 邮编验证
  if (row.postcode) {
    if (!isValidUkPostcode(row.postcode)) {
      warnings.push({ field: "postcode", message: "邮编格式疑似无效", value: row.postcode });
    }
  } else {
    warnings.push({ field: "postcode", message: "缺少邮编", value: "" });
  }

  // 电话验证
  if (row.telephone) {
    if (!isValidUkPhone(row.telephone)) {
      warnings.push({ field: "telephone", message: "电话格式疑似无效", value: row.telephone });
    }
  }

  // external_id 稳定性检查
  if (row.external_id && /lawsoc_\d{13}/.test(row.external_id)) {
    errors.push({ field: "external_id", message: "external_id 使用了 Date.now()，无法去重", value: row.external_id });
  }

  // authorisation_status 检查
  if (!row.authorisation_status) {
    warnings.push({ field: "authorisation_status", message: "缺少执业状态", value: "" });
  }

  // 完整性评分
  const completeness = checkCompleteness(row);
  const qualityScore = completeness.score;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    qualityScore,
    missing: completeness.missing,
  };
}

/**
 * 生成批次质量报告
 */
function generateRunReport(validations, source) {
  const total = validations.length;
  if (total === 0) {
    return { source, total: 0, avgScore: 0, errorCount: 0, warningCount: 0, fieldCompleteness: {} };
  }

  let scoreSum = 0;
  let errorCount = 0;
  let warningCount = 0;
  const fieldErrors = {};
  const fieldWarnings = {};

  for (const v of validations) {
    scoreSum += v.qualityScore;
    errorCount += v.errors.length;
    warningCount += v.warnings.length;

    for (const e of v.errors) {
      fieldErrors[e.field] = (fieldErrors[e.field] || 0) + 1;
    }
    for (const w of v.warnings) {
      fieldWarnings[w.field] = (fieldWarnings[w.field] || 0) + 1;
    }
  }

  // 计算字段完整度
  const fields = ["name", "email", "postcode", "city", "telephone", "website", "authorisation_status"];
  const fieldCompleteness = {};
  for (const f of fields) {
    const missingCount = (fieldErrors[f] || 0) + (fieldWarnings[f] || 0);
    fieldCompleteness[f] = Math.round(((total - missingCount) / total) * 100);
  }

  return {
    source,
    total,
    avgScore: Math.round(scoreSum / total),
    errorCount,
    warningCount,
    fieldErrors,
    fieldWarnings,
    fieldCompleteness,
  };
}

module.exports = {
  parseUkAddress,
  isValidUkPostcode,
  isValidEmail,
  isValidUkPhone,
  checkCompleteness,
  validateRecord,
  generateRunReport,
};
