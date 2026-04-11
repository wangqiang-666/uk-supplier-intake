const Database = require("better-sqlite3");
const path = require("path");
const { normalizeEmail, normalizePhone, normalizePostcode, validateEmail } = require("./lib/validators");

const DB_PATH = path.resolve(__dirname, "../data/supplier-intake.db");

function getDbRaw() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

/**
 * 标准化现有数据库中的联系方式
 */
function normalizeContactData(db) {
  console.log("\n[normalize] 开始标准化联系方式数据...\n");

  // 获取所有需要标准化的数据
  const rows = db.prepare(`
    SELECT id, email, telephone, postcode
    FROM organisations
    WHERE email != '' OR telephone != '' OR postcode != ''
  `).all();

  console.log(`找到 ${rows.length} 条需要处理的记录\n`);

  const updateStmt = db.prepare(`
    UPDATE organisations
    SET email = ?, telephone = ?, postcode = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `);

  let stats = {
    total: rows.length,
    emailNormalized: 0,
    emailInvalid: 0,
    phoneNormalized: 0,
    postcodeNormalized: 0,
  };

  const transaction = db.transaction(() => {
    for (const row of rows) {
      let email = row.email || "";
      let telephone = row.telephone || "";
      let postcode = row.postcode || "";

      let changed = false;

      // 标准化邮箱
      if (email) {
        const normalized = normalizeEmail(email);
        if (validateEmail(normalized)) {
          if (normalized !== email) {
            email = normalized;
            stats.emailNormalized++;
            changed = true;
          }
        } else {
          // 无效邮箱，清空
          email = "";
          stats.emailInvalid++;
          changed = true;
        }
      }

      // 标准化电话
      if (telephone) {
        const normalized = normalizePhone(telephone);
        if (normalized !== telephone) {
          telephone = normalized;
          stats.phoneNormalized++;
          changed = true;
        }
      }

      // 标准化邮编
      if (postcode) {
        const normalized = normalizePostcode(postcode);
        if (normalized !== postcode) {
          postcode = normalized;
          stats.postcodeNormalized++;
          changed = true;
        }
      }

      // 只更新有变化的记录
      if (changed) {
        updateStmt.run(email, telephone, postcode, row.id);
      }
    }
  });

  transaction();

  console.log("标准化完成！\n");
  console.log("统计结果：");
  console.log(`  总记录数: ${stats.total}`);
  console.log(`  邮箱标准化: ${stats.emailNormalized} 条`);
  console.log(`  邮箱无效清空: ${stats.emailInvalid} 条`);
  console.log(`  电话标准化: ${stats.phoneNormalized} 条`);
  console.log(`  邮编标准化: ${stats.postcodeNormalized} 条`);

  return stats;
}

/**
 * 显示标准化前后对比样本
 */
function showSamples(db) {
  console.log("\n[normalize] 标准化后样本数据：\n");

  const samples = db.prepare(`
    SELECT name, email, telephone, postcode
    FROM organisations
    WHERE (email != '' OR telephone != '' OR postcode != '')
    LIMIT 5
  `).all();

  samples.forEach((row, i) => {
    console.log(`[${i + 1}] ${row.name}`);
    console.log(`    邮箱: ${row.email || '无'}`);
    console.log(`    电话: ${row.telephone || '无'}`);
    console.log(`    邮编: ${row.postcode || '无'}`);
    console.log('');
  });
}

// 主函数
console.log("========== 数据标准化迁移 ==========\n");

const db = getDbRaw();

try {
  normalizeContactData(db);
  showSamples(db);

  console.log("\n[normalize] 完成！");
} catch (error) {
  console.error("\n[normalize] 错误:", error.message);
  process.exit(1);
} finally {
  db.close();
}
