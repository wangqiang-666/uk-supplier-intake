const Database = require("better-sqlite3");
const path = require("path");
const { parseUkAddress } = require("./lib/validate");

const DB_PATH = path.resolve(__dirname, "../data/supplier-intake.db");

function getDbRaw() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function runMigrations(db) {
  const cols = db
    .prepare("PRAGMA table_info(organisations)")
    .all()
    .map((c) => c.name);

  if (!cols.includes("email_sent")) {
    db.exec("ALTER TABLE organisations ADD COLUMN email_sent INTEGER NOT NULL DEFAULT 0");
    console.log("+ 添加字段 email_sent");
  }
  if (!cols.includes("email_sent_at")) {
    db.exec("ALTER TABLE organisations ADD COLUMN email_sent_at TEXT");
    console.log("+ 添加字段 email_sent_at");
  }
  if (!cols.includes("email_send_count")) {
    db.exec("ALTER TABLE organisations ADD COLUMN email_send_count INTEGER NOT NULL DEFAULT 0");
    console.log("+ 添加字段 email_send_count");
  }

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='organisations'")
    .all()
    .map((r) => r.name);
  if (!indexes.includes("idx_org_email_sent")) {
    db.exec("CREATE INDEX IF NOT EXISTS idx_org_email_sent ON organisations(email_sent)");
    console.log("+ 添加索引 idx_org_email_sent");
  }

  // 添加海牙认证资质字段
  if (!cols.includes("apostille_qualified")) {
    db.exec("ALTER TABLE organisations ADD COLUMN apostille_qualified INTEGER NOT NULL DEFAULT 0");
    console.log("+ 添加字段 apostille_qualified");
  }

  // 添加回复跟踪字段
  if (!cols.includes("reply_received")) {
    db.exec("ALTER TABLE organisations ADD COLUMN reply_received INTEGER NOT NULL DEFAULT 0");
    console.log("+ 添加字段 reply_received");
  }

  // 确保 email_replies 和 email_monitor_state 表存在
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_replies (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      organisation_id INTEGER REFERENCES organisations(id),
      from_email      TEXT NOT NULL,
      subject         TEXT DEFAULT '',
      body            TEXT DEFAULT '',
      message_id      TEXT DEFAULT '',
      received_at     TEXT NOT NULL,
      matched         INTEGER NOT NULL DEFAULT 1,
      read_status     INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_reply_org_id ON email_replies(organisation_id);
    CREATE INDEX IF NOT EXISTS idx_reply_from   ON email_replies(from_email);
    CREATE INDEX IF NOT EXISTS idx_reply_msg_id ON email_replies(message_id);

    CREATE TABLE IF NOT EXISTS email_monitor_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);
  console.log("+ 确保邮件相关表存在");

  console.log("[migrate] 基础迁移完成。");
}

/**
 * 回填 Law Society 数据：解析地址、填充 authorisation_status、修复 external_id
 */
function backfillLawSociety(db) {
  console.log("\n[migrate] 回填 Law Society 数据...");

  // 1. 回填地址解析（city/postcode 为空但 address_line1 有值）
  const rows = db.prepare(`
    SELECT id, external_id, name, address_line1, email
    FROM organisations
    WHERE source = 'lawsociety_scraper' AND city = '' AND address_line1 != ''
  `).all();

  let addressFixed = 0;
  const updateAddr = db.prepare(`
    UPDATE organisations SET
      address_line1 = ?, address_line2 = ?, address_line3 = ?,
      city = ?, county = ?, postcode = ?, country = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);

  for (const row of rows) {
    const parsed = parseUkAddress(row.address_line1);
    if (parsed.city || parsed.postcode) {
      updateAddr.run(
        parsed.address_line1, parsed.address_line2, parsed.address_line3,
        parsed.city, parsed.county, parsed.postcode, parsed.country || "United Kingdom",
        row.id
      );
      addressFixed++;
    }
  }
  console.log(`  - 地址解析回填: ${addressFixed}/${rows.length} 条`);

  // 2. 回填 authorisation_status
  const statusResult = db.prepare(`
    UPDATE organisations SET
      authorisation_status = 'Authorised',
      updated_at = datetime('now', 'localtime')
    WHERE source = 'lawsociety_scraper' AND (authorisation_status = '' OR authorisation_status IS NULL)
  `).run();
  console.log(`  - 执业状态回填: ${statusResult.changes} 条 → "Authorised"`);

  // 3. 修复 external_id（将 Date.now() 格式的 ID 替换为基于 name 的确定性 ID）
  const badIds = db.prepare(`
    SELECT id, external_id, name
    FROM organisations
    WHERE source = 'lawsociety_scraper' AND external_id LIKE 'lawsoc_%'
  `).all();

  let idFixed = 0;
  const updateId = db.prepare(`
    UPDATE organisations SET external_id = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);

  for (const row of badIds) {
    const idPart = row.external_id.replace("lawsoc_", "");
    // 检测是否是 Date.now() 格式（13位纯数字）
    if (/^\d{13,}$/.test(idPart)) {
      const nameHash = (row.name || "").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
      const newId = `lawsoc_name_${nameHash}`;
      // 检查新ID是否会冲突
      const conflict = db.prepare(
        "SELECT id FROM organisations WHERE source = 'lawsociety_scraper' AND external_id = ? AND id != ?"
      ).get(newId, row.id);
      if (!conflict) {
        updateId.run(newId, row.id);
        idFixed++;
      }
    }
  }
  console.log(`  - external_id 修复: ${idFixed} 条（从 Date.now() → name hash）`);
}

/**
 * 回填 Faculty Office 数据：修复 external_id、work_areas、authorisation_status
 */
function backfillFacultyOffice(db) {
  console.log("\n[migrate] 回填 Faculty Office 数据...");

  const rows = db.prepare(`
    SELECT id, external_id, name, email, raw_json
    FROM organisations
    WHERE source = 'facultyoffice'
  `).all();

  let idFixed = 0;
  let workAreasFixed = 0;
  let statusFixed = 0;

  const updateRow = db.prepare(`
    UPDATE organisations SET
      external_id = ?,
      authorisation_status = ?,
      work_areas = ?,
      office_type = ?,
      updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);

  for (const row of rows) {
    let rawData;
    try {
      rawData = JSON.parse(row.raw_json || "{}");
    } catch (_) {
      rawData = {};
    }

    // 修复 external_id
    const email = (row.email || "").trim().toLowerCase();
    let newExternalId = row.external_id;
    if (email && !row.external_id.startsWith("fo_")) {
      newExternalId = `fo_${email}`;
      // 检查冲突
      const conflict = db.prepare(
        "SELECT id FROM organisations WHERE source = 'facultyoffice' AND external_id = ? AND id != ?"
      ).get(newExternalId, row.id);
      if (conflict) {
        newExternalId = row.external_id; // 有冲突则保留原ID
      } else {
        idFixed++;
      }
    }

    // 修复 authorisation_status
    const hasAml = !!(rawData.aml_supervision && rawData.aml_supervision.trim());
    const newStatus = hasAml ? "Practising" : "Listed";

    // 修复 work_areas
    const workAreas = ["Notarial Services"];
    if (rawData.languages) {
      const langs = rawData.languages.split(/[,;]/).map((l) => l.trim()).filter(Boolean);
      for (const lang of langs) {
        workAreas.push(`Language: ${lang}`);
      }
    }
    if (hasAml) {
      workAreas.push("AML Supervised");
    }

    // 修复 office_type
    const officeInfo = [
      rawData.aml_supervision ? `AML: ${rawData.aml_supervision.trim()}` : "",
      rawData.dx ? `DX: ${rawData.dx.trim()}` : "",
    ].filter(Boolean).join("; ");

    const oldWorkAreas = row.work_areas || "[]";
    if (oldWorkAreas === "[]") workAreasFixed++;

    updateRow.run(
      newExternalId,
      newStatus,
      JSON.stringify(workAreas),
      officeInfo,
      row.id
    );

    statusFixed++;
  }

  console.log(`  - external_id 修复: ${idFixed} 条（→ fo_email 格式）`);
  console.log(`  - work_areas 回填: ${workAreasFixed} 条`);
  console.log(`  - authorisation_status 更新: ${statusFixed} 条`);

  // 回填海牙认证资质 — Faculty Office 公证人全部有资质
  const apostilleResult = db.prepare(`
    UPDATE organisations SET apostille_qualified = 1
    WHERE source = 'facultyoffice' AND apostille_qualified = 0
  `).run();
  console.log(`  - 海牙认证资质标记: ${apostilleResult.changes} 条`);
}

// 主函数
const db = getDbRaw();

console.log("========== 数据迁移 ==========\n");
console.log("[migrate] 1. 基础结构迁移...");
runMigrations(db);

console.log("\n[migrate] 2. 数据质量回填...");
backfillLawSociety(db);
backfillFacultyOffice(db);

// 显示迁移后统计
const stats = db.prepare(`
  SELECT source,
    COUNT(*) as total,
    SUM(CASE WHEN city != '' THEN 1 ELSE 0 END) as has_city,
    SUM(CASE WHEN postcode != '' THEN 1 ELSE 0 END) as has_postcode,
    SUM(CASE WHEN authorisation_status != '' THEN 1 ELSE 0 END) as has_status,
    SUM(CASE WHEN work_areas != '[]' AND work_areas != '' THEN 1 ELSE 0 END) as has_work_areas
  FROM organisations GROUP BY source
`).all();

console.log("\n[migrate] ========== 迁移后数据质量统计 ==========");
for (const s of stats) {
  const name = s.source === "sra_api" ? "SRA" : s.source === "lawsociety_scraper" ? "Law Society" : "Faculty Office";
  console.log(`  ${name}: ${s.total} 条`);
  console.log(`    城市: ${Math.round((s.has_city / s.total) * 100)}% | 邮编: ${Math.round((s.has_postcode / s.total) * 100)}% | 状态: ${Math.round((s.has_status / s.total) * 100)}% | 专业领域: ${Math.round((s.has_work_areas / s.total) * 100)}%`);
}
console.log("=================================================\n");

db.close();
console.log("[migrate] 完成。");

