#!/usr/bin/env node
/**
 * 邮件追踪状态补全 — 单元测试
 *
 * 纯本地测试，不调用外部 API，直接操作数据库模拟各种追踪场景。
 *
 * 测试范围：
 *   1. 基础状态补全 — opened 自动补插 sent + delivered
 *   2. 幂等性 — 重复同步不产生重复记录
 *   3. 退信不补 delivered — bounced 只存一条
 *   4. 投诉补 delivered — complained 补插 sent + delivered
 *   5. 状态升级 — delivered → opened 递进，无重复
 *   6. 前端查询验证 — LEFT JOIN 聚合结果正确
 *
 * 用法：
 *   node src/test-email-tracking.js
 *   npm run test:tracking
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

// ──────── 测试框架 ────────

const results = [];
const startTime = Date.now();

function assert(condition, label) {
  if (condition) {
    results.push({ label, ok: true });
    console.log(`  ✅ ${label}`);
  } else {
    results.push({ label, ok: false });
    console.log(`  ❌ ${label}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(50)}`);
}

// ──────── 加载项目模块 ────────

const { getDb, closeDb, insertEmailEvent, getEmailEventsByOrgId } = require("./db");
const { PRECURSORS } = require("./lib/email-tracker");

// ──────── 测试常量 ────────

const TS = Date.now();
const PREFIX = "__test_tracking_";

// 模拟的 Resend Email ID
const RESEND_IDS = {
  opened:     `${PREFIX}opened_${TS}`,
  idempotent: `${PREFIX}idempotent_${TS}`,
  bounced:    `${PREFIX}bounced_${TS}`,
  complained: `${PREFIX}complained_${TS}`,
  upgrade:    `${PREFIX}upgrade_${TS}`,
  query:      `${PREFIX}query_${TS}`,
};

// ──────── 辅助函数 ────────

/**
 * 模拟 syncEmailStatus 的补全逻辑（不调用 Resend API）
 */
function simulateSync(db, resendEmailId, orgId, lastEvent) {
  const allEvents = [...(PRECURSORS[lastEvent] || []), lastEvent];
  let added = 0;
  for (const evt of allEvents) {
    const inserted = insertEmailEvent(db, {
      resend_email_id: resendEmailId,
      organisation_id: orgId,
      event_type: `email.${evt}`,
      event_data: JSON.stringify({ last_event: lastEvent, simulated: true }),
    });
    if (inserted) added++;
  }
  return added;
}

function getEvents(db, resendEmailId) {
  return db.prepare(
    "SELECT event_type FROM email_events WHERE resend_email_id = ? ORDER BY id"
  ).all(resendEmailId);
}

function getEventTypes(db, resendEmailId) {
  return getEvents(db, resendEmailId).map(e => e.event_type);
}

// ──────── 主测试流程 ────────

async function main() {
  console.log("\n🧪 邮件追踪状态补全测试");
  console.log(`${"═".repeat(50)}`);

  const db = getDb();

  // 插入测试数据源（如不存在）
  db.prepare(`INSERT OR IGNORE INTO sources (code, name, country) VALUES (?, ?, ?)`)
    .run("test_tracking", "Tracking Test Source", "United Kingdom");

  // 直接插入测试组织（绕过 upsertOrganisation 的 run_id 依赖）
  const extId = `${PREFIX}org_${TS}`;
  const insertResult = db.prepare(`
    INSERT INTO organisations (source, external_id, name, city, postcode, country, email, first_seen_run, last_seen_run)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("test_tracking", extId, "Tracking Test Firm", "London", "EC1A 1BB", "United Kingdom", "tracking-test@example.com", `test_${TS}`, `test_${TS}`);
  const orgId = insertResult.lastInsertRowid;
  console.log(`\n  测试组织 ID: ${orgId}`);

  // ────────────────────────────────────────────
  // Test 1: 基础状态补全 — opened
  // ────────────────────────────────────────────
  section("Test 1: 基础状态补全 (opened → sent + delivered + opened)");

  const added1 = simulateSync(db, RESEND_IDS.opened, orgId, "opened");
  const types1 = getEventTypes(db, RESEND_IDS.opened);

  assert(added1 === 3, `插入了 3 条事件 (实际: ${added1})`);
  assert(types1.includes("email.sent"), "包含 email.sent");
  assert(types1.includes("email.delivered"), "包含 email.delivered");
  assert(types1.includes("email.opened"), "包含 email.opened");
  assert(!types1.includes("email.clicked"), "不包含 email.clicked");

  // ────────────────────────────────────────────
  // Test 2: 幂等性 — 重复同步
  // ────────────────────────────────────────────
  section("Test 2: 幂等性 (重复同步不产生重复记录)");

  const added2 = simulateSync(db, RESEND_IDS.idempotent, orgId, "delivered");
  const types2a = getEventTypes(db, RESEND_IDS.idempotent);
  assert(added2 === 2, `首次插入 2 条 (实际: ${added2})`);

  // 再同步一次
  const added2b = simulateSync(db, RESEND_IDS.idempotent, orgId, "delivered");
  const types2b = getEventTypes(db, RESEND_IDS.idempotent);

  assert(added2b === 0, `重复同步插入 0 条 (实际: ${added2b})`);
  assert(types2b.length === 2, `总事件数不变: 2 (实际: ${types2b.length})`);

  // ────────────────────────────────────────────
  // Test 3: 退信不补 delivered
  // ────────────────────────────────────────────
  section("Test 3: 退信不补 delivered (bounced 只存 bounced)");

  const added3 = simulateSync(db, RESEND_IDS.bounced, orgId, "bounced");
  const types3 = getEventTypes(db, RESEND_IDS.bounced);

  assert(added3 === 1, `只插入 1 条 (实际: ${added3})`);
  assert(types3.includes("email.bounced"), "包含 email.bounced");
  assert(!types3.includes("email.delivered"), "不包含 email.delivered");
  assert(!types3.includes("email.sent"), "不包含 email.sent");

  // ────────────────────────────────────────────
  // Test 4: 投诉补 delivered
  // ────────────────────────────────────────────
  section("Test 4: 投诉补 delivered (complained → sent + delivered + complained)");

  const added4 = simulateSync(db, RESEND_IDS.complained, orgId, "complained");
  const types4 = getEventTypes(db, RESEND_IDS.complained);

  assert(added4 === 3, `插入 3 条 (实际: ${added4})`);
  assert(types4.includes("email.sent"), "包含 email.sent");
  assert(types4.includes("email.delivered"), "包含 email.delivered");
  assert(types4.includes("email.complained"), "包含 email.complained");

  // ────────────────────────────────────────────
  // Test 5: 状态升级 — delivered → opened
  // ────────────────────────────────────────────
  section("Test 5: 状态升级 (delivered → opened，无重复)");

  // 第一次同步：delivered
  const added5a = simulateSync(db, RESEND_IDS.upgrade, orgId, "delivered");
  const types5a = getEventTypes(db, RESEND_IDS.upgrade);
  assert(added5a === 2, `delivered 阶段插入 2 条 (实际: ${added5a})`);
  assert(types5a.length === 2, `此时共 2 条事件`);

  // 第二次同步：升级为 opened
  const added5b = simulateSync(db, RESEND_IDS.upgrade, orgId, "opened");
  const types5b = getEventTypes(db, RESEND_IDS.upgrade);
  assert(added5b === 1, `opened 阶段只新增 1 条 (实际: ${added5b})`);
  assert(types5b.length === 3, `总共 3 条事件 (实际: ${types5b.length})`);
  assert(types5b.includes("email.sent"), "包含 email.sent");
  assert(types5b.includes("email.delivered"), "包含 email.delivered");
  assert(types5b.includes("email.opened"), "包含 email.opened");

  // ────────────────────────────────────────────
  // Test 6: 前端 LEFT JOIN 查询验证
  // ────────────────────────────────────────────
  section("Test 6: 前端查询验证 (LEFT JOIN 聚合 tracking_* 字段)");

  // 为查询测试准备一个有 opened 状态的邮件
  simulateSync(db, RESEND_IDS.query, orgId, "opened");

  // 标记组织为已发送
  db.prepare("UPDATE organisations SET email_sent = 1, resend_email_id = ? WHERE id = ?")
    .run(RESEND_IDS.query, orgId);

  const row = db.prepare(`
    SELECT
      o.id, o.name, o.email_sent,
      MAX(CASE WHEN e.event_type = 'email.delivered' THEN 1 ELSE 0 END) as tracking_delivered,
      MAX(CASE WHEN e.event_type = 'email.opened' THEN 1 ELSE 0 END) as tracking_opened,
      MAX(CASE WHEN e.event_type = 'email.bounced' THEN 1 ELSE 0 END) as tracking_bounced,
      MAX(CASE WHEN e.event_type = 'email.complained' THEN 1 ELSE 0 END) as tracking_complained
    FROM organisations o
    LEFT JOIN email_events e ON o.id = e.organisation_id
    WHERE o.id = ?
    GROUP BY o.id
  `).get(orgId);

  assert(row.tracking_delivered === 1, "tracking_delivered = 1");
  assert(row.tracking_opened === 1, "tracking_opened = 1");
  assert(row.tracking_bounced === 1, "tracking_bounced = 1 (来自 Test 3 的退信)");
  assert(row.tracking_complained === 1, "tracking_complained = 1 (来自 Test 4 的投诉)");

  // ────────────────────────────────────────────
  // Test 7: PRECURSORS 映射表完整性
  // ────────────────────────────────────────────
  section("Test 7: PRECURSORS 映射表验证");

  assert(Array.isArray(PRECURSORS.sent), "sent 有映射");
  assert(PRECURSORS.sent.length === 0, "sent 无前置状态");
  assert(PRECURSORS.delivered.length === 1, "delivered 有 1 个前置");
  assert(PRECURSORS.delivered[0] === "sent", "delivered 前置是 sent");
  assert(PRECURSORS.opened.length === 2, "opened 有 2 个前置");
  assert(PRECURSORS.bounced.length === 0, "bounced 无前置状态");
  assert(PRECURSORS.complained.length === 2, "complained 有 2 个前置");

  // ──────── 清理测试数据 ────────
  section("清理测试数据");

  const allResendIds = Object.values(RESEND_IDS);
  const placeholders = allResendIds.map(() => "?").join(",");

  const deletedEvents = db.prepare(
    `DELETE FROM email_events WHERE resend_email_id IN (${placeholders})`
  ).run(...allResendIds);
  console.log(`  🗑️  删除测试事件: ${deletedEvents.changes} 条`);

  // 恢复组织状态并删除
  db.prepare("DELETE FROM organisations WHERE external_id LIKE ?").run(`${PREFIX}%`);
  console.log(`  🗑️  删除测试组织`);

  db.prepare("DELETE FROM sources WHERE code = ?").run("test_tracking");
  console.log(`  🗑️  删除测试数据源`);

  // ──────── 结果汇总 ────────
  console.log(`\n${"═".repeat(50)}`);
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (failed === 0) {
    console.log(`  🎉 全部通过: ${passed}/${results.length} PASSED (${elapsed}s)`);
  } else {
    console.log(`  ⚠️  ${passed}/${results.length} PASSED, ${failed} FAILED (${elapsed}s)`);
    console.log(`\n  失败项:`);
    results.filter(r => !r.ok).forEach(r => console.log(`    ❌ ${r.label}`));
  }
  console.log(`${"═".repeat(50)}\n`);

  closeDb();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("❌ 测试异常:", err);
  process.exit(1);
});
