const Database = require("better-sqlite3");
const path = require("node:path");
const { initSchema } = require("./schema");

/**
 * 返回当前北京时间字符串 "YYYY-MM-DD HH:mm:ss"
 * 统一替代 toISOString()（UTC），确保所有时间字段一致使用 Asia/Shanghai
 */
function nowLocal() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/\//g, "-");
}

/** Repo root (uk-supplier-intake/), not process.cwd() — avoids PM2/cron opening the wrong file */
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const DEFAULT_DB_FULL = path.join(PROJECT_ROOT, "data", "supplier-intake.db");

let _db = null;

function resolveDbFull(dbPath) {
  if (dbPath) {
    return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
  }
  const env = process.env.DB_PATH;
  if (env) {
    return path.isAbsolute(env) ? env : path.resolve(PROJECT_ROOT, env);
  }
  return DEFAULT_DB_FULL;
}

function getDb(dbPath) {
  if (_db) return _db;
  const full = resolveDbFull(dbPath);
  _db = new Database(full);
  initSchema(_db);
  // 首次启动时，把 env 默认的 IMAP 配置和通知负责人写入 DB（仅当表为空时）
  const { seedDefaultsFromEnv } = require("../lib/runtime-config");
  seedDefaultsFromEnv(_db);
  return _db;
}

function closeDb() {
  if (_db) _db.close();
  _db = null;
}

function insertRun(db, run) {
  db.prepare(`
    INSERT INTO runs (run_id, source, started_at, config)
    VALUES (@run_id, @source, @started_at, @config)
  `).run(run);
}

function finishRun(db, run) {
  db.prepare(`
    UPDATE runs SET
      finished_at = @finished_at,
      org_total = @org_total,
      org_kept = @org_kept
    WHERE run_id = @run_id
  `).run(run);
}

function upsertOrganisation(db, org, runId) {
  const existing = db
    .prepare("SELECT id FROM organisations WHERE source = ? AND external_id = ?")
    .get(org.source, org.external_id);

  const payload = {
    ...org,
    work_areas: JSON.stringify(org.work_areas || []),
    raw_json: JSON.stringify(org.raw_json || {}),
    apostille_qualified: org.apostille_qualified || 0,
    run_id: runId,
  };

  if (existing) {
    db.prepare(`
      UPDATE organisations SET
        name = @name,
        authorisation_status = @authorisation_status,
        organisation_type = @organisation_type,
        work_areas = @work_areas,
        address_line1 = @address_line1,
        address_line2 = @address_line2,
        address_line3 = @address_line3,
        city = @city,
        county = @county,
        postcode = @postcode,
        country = @country,
        telephone = @telephone,
        email = @email,
        website = @website,
        office_type = @office_type,
        source_url = @source_url,
        raw_json = @raw_json,
        apostille_qualified = @apostille_qualified,
        last_seen_run = @run_id,
        updated_at = datetime('now', 'localtime')
      WHERE id = @id
    `).run({ ...payload, id: existing.id });
    return existing.id;
  }

  const res = db.prepare(`
    INSERT INTO organisations (
      source, external_id, name, authorisation_status, organisation_type, work_areas,
      address_line1, address_line2, address_line3, city, county, postcode, country,
      telephone, email, website, office_type,
      source_url, raw_json, apostille_qualified,
      first_seen_run, last_seen_run
    ) VALUES (
      @source, @external_id, @name, @authorisation_status, @organisation_type, @work_areas,
      @address_line1, @address_line2, @address_line3, @city, @county, @postcode, @country,
      @telephone, @email, @website, @office_type,
      @source_url, @raw_json, @apostille_qualified,
      @run_id, @run_id
    )
  `).run(payload);

  return res.lastInsertRowid;
}

function listSources(db) {
  return db.prepare("SELECT * FROM sources ORDER BY code").all();
}

function listRuns(db, limit = 20, source) {
  if (source) {
    return db.prepare("SELECT * FROM runs WHERE source = ? ORDER BY started_at DESC LIMIT ?").all(source, limit);
  }
  return db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit);
}

// ──────── Email Reply 操作 ────────

function insertEmailReply(db, reply) {
  return db.prepare(`
    INSERT INTO email_replies (organisation_id, from_email, subject, body, message_id, received_at, matched)
    VALUES (@organisation_id, @from_email, @subject, @body, @message_id, @received_at, @matched)
  `).run(reply);
}

function getEmailReplies(db, { orgId, matched, page = 1, pageSize = 50 } = {}) {
  const conditions = [];
  const params = [];

  if (orgId) {
    conditions.push("r.organisation_id = ?");
    params.push(Number(orgId));
  }
  if (matched !== undefined && matched !== "") {
    conditions.push("r.matched = ?");
    params.push(Number(matched));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(200, Math.max(1, Number(pageSize)));
  const offset = (Math.max(1, Number(page)) - 1) * limit;

  const total = db.prepare(`SELECT COUNT(*) AS c FROM email_replies r ${where}`).get(...params).c;
  const rows = db.prepare(`
    SELECT r.*, o.name AS organisation_name
    FROM email_replies r
    LEFT JOIN organisations o ON r.organisation_id = o.id
    ${where}
    ORDER BY r.received_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { total, page, pageSize: limit, rows };
}

function getReplyByMessageId(db, messageId) {
  return db.prepare("SELECT id FROM email_replies WHERE message_id = ?").get(messageId);
}

function getEmailReplyById(db, id) {
  return db.prepare(`
    SELECT r.*, o.name AS org_name
    FROM email_replies r
    LEFT JOIN organisations o ON r.organisation_id = o.id
    WHERE r.id = ?
  `).get(id);
}

function updateReplyReadStatus(db, replyId, readStatus) {
  return db.prepare("UPDATE email_replies SET read_status = ? WHERE id = ?").run(readStatus, replyId);
}

// ──────── Email Monitor State ────────

function getMonitorState(db, key) {
  const row = db.prepare("SELECT value FROM email_monitor_state WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMonitorState(db, key, value) {
  db.prepare(`
    INSERT INTO email_monitor_state (key, value, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

// ──────── Organisation Email 操作 ────────

function matchOrgByEmail(db, email) {
  return db.prepare(
    "SELECT id, name, email, city, country, telephone, organisation_type, source, website, apostille_qualified, source_url FROM organisations WHERE LOWER(email) = ? LIMIT 1"
  ).get(email.toLowerCase());
}

function markOrgReplied(db, orgId) {
  db.prepare(
    "UPDATE organisations SET reply_received = 1, updated_at = datetime('now', 'localtime') WHERE id = ?"
  ).run(orgId);
}

function getUnsentOrganisations(db, { limit = 10, source } = {}) {
  const conditions = ["email_sent = 0", "email != ''", "email IS NOT NULL"];
  const params = [];
  if (source) {
    conditions.push("source = ?");
    params.push(String(source));
  } else {
    // 自动发送时排除测试数据
    conditions.push("source != 'e2e_test'");
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  return db.prepare(`
    SELECT id, source, external_id, name, email, telephone, city, postcode,
           organisation_type, work_areas, apostille_qualified, website
    FROM organisations ${where}
    ORDER BY id ASC LIMIT ?
  `).all(...params, Math.min(200, Math.max(1, Number(limit))));
}

function markOrganisationsSent(db, ids) {
  if (!ids.length) return;
  const now = nowLocal();
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`
    UPDATE organisations
    SET email_sent = 1, email_sent_at = ?, email_send_count = email_send_count + 1,
        updated_at = datetime('now', 'localtime')
    WHERE id IN (${placeholders})
  `).run(now, ...ids);
}

function markOrganisationUnsent(db, id) {
  db.prepare(`
    UPDATE organisations
    SET email_sent = 0, email_sent_at = NULL, email_send_count = CASE WHEN email_send_count > 0 THEN email_send_count - 1 ELSE 0 END,
        updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(id);
}

function getDailySendCount(db) {
  const today = nowLocal().slice(0, 10); // YYYY-MM-DD (北京时间)
  const key = `daily_send_count_${today}`;
  const val = getMonitorState(db, key);
  return val ? Number(val) : 0;
}

function incrementDailySendCount(db, count = 1) {
  const today = nowLocal().slice(0, 10);
  const key = `daily_send_count_${today}`;
  const current = getDailySendCount(db);
  setMonitorState(db, key, String(current + count));
}

// ──────── Email Tracking 操作 ────────

function getSettingValue(db, key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setOrganisationResendId(db, orgId, resendEmailId) {
  db.prepare(`
    UPDATE organisations
    SET resend_email_id = ?
    WHERE id = ?
  `).run(resendEmailId, orgId);
}

function getOrganisationByResendId(db, resendEmailId) {
  return db.prepare(`
    SELECT * FROM organisations
    WHERE resend_email_id = ?
  `).get(resendEmailId);
}

function insertEmailEvent(db, event) {
  try {
    db.prepare(`
      INSERT INTO email_events (resend_email_id, organisation_id, event_type, event_data)
      VALUES (@resend_email_id, @organisation_id, @event_type, @event_data)
    `).run(event);
    return true;
  } catch (err) {
    if (err.message.includes("UNIQUE constraint")) {
      return false; // 重复事件，忽略
    }
    throw err;
  }
}

function getEmailEventsByOrgId(db, orgId) {
  return db.prepare(`
    SELECT * FROM email_events
    WHERE organisation_id = ?
    ORDER BY created_at DESC
  `).all(orgId);
}

function getEmailEventStats(db) {
  return db.prepare(`
    SELECT
      event_type,
      COUNT(*) as count
    FROM email_events
    GROUP BY event_type
  `).all();
}

function getRecentBouncesAndComplaints(db, limit = 10) {
  return db.prepare(`
    SELECT
      e.*,
      o.name as org_name,
      o.email as org_email
    FROM email_events e
    LEFT JOIN organisations o ON e.organisation_id = o.id
    WHERE e.event_type IN ('email.bounced', 'email.complained')
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(limit);
}

function getEmailTrackingMetrics(db, options = {}) {
  const { days = 1 } = options;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

  // 统计最近N天发送的邮件总数（有 resend_email_id 的）
  const totalSent = db.prepare(`
    SELECT COUNT(DISTINCT resend_email_id) as count
    FROM organisations
    WHERE resend_email_id IS NOT NULL
      AND email_sent_at >= ?
  `).get(cutoff).count;

  if (totalSent === 0) {
    return {
      totalSent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      complained: 0,
      deliveryRate: 0,
      openRate: 0,
      clickRate: 0,
      bounceRate: 0,
      complaintRate: 0,
    };
  }

  // 统计各类事件的唯一邮件数
  const delivered = db.prepare(`
    SELECT COUNT(DISTINCT resend_email_id) as count
    FROM email_events
    WHERE event_type = 'email.delivered'
      AND created_at >= ?
  `).get(cutoff).count;

  const opened = db.prepare(`
    SELECT COUNT(DISTINCT resend_email_id) as count
    FROM email_events
    WHERE event_type = 'email.opened'
      AND created_at >= ?
  `).get(cutoff).count;

  const clicked = db.prepare(`
    SELECT COUNT(DISTINCT resend_email_id) as count
    FROM email_events
    WHERE event_type = 'email.clicked'
      AND created_at >= ?
  `).get(cutoff).count;

  const bounced = db.prepare(`
    SELECT COUNT(DISTINCT resend_email_id) as count
    FROM email_events
    WHERE event_type = 'email.bounced'
      AND created_at >= ?
  `).get(cutoff).count;

  const complained = db.prepare(`
    SELECT COUNT(DISTINCT resend_email_id) as count
    FROM email_events
    WHERE event_type = 'email.complained'
      AND created_at >= ?
  `).get(cutoff).count;

  return {
    totalSent,
    delivered,
    opened,
    clicked,
    bounced,
    complained,
    deliveryRate: totalSent > 0 ? (delivered / totalSent) : 0,
    openRate: totalSent > 0 ? (opened / totalSent) : 0,
    clickRate: totalSent > 0 ? (clicked / totalSent) : 0,
    bounceRate: totalSent > 0 ? (bounced / totalSent) : 0,
    complaintRate: totalSent > 0 ? (complained / totalSent) : 0,
  };
}

module.exports = {
  getDb,
  closeDb,
  insertRun,
  finishRun,
  upsertOrganisation,
  listSources,
  listRuns,
  // Email replies
  insertEmailReply,
  getEmailReplies,
  getEmailReplyById,
  getReplyByMessageId,
  updateReplyReadStatus,
  // Monitor state
  getMonitorState,
  setMonitorState,
  // Organisation email ops
  matchOrgByEmail,
  markOrgReplied,
  getUnsentOrganisations,
  markOrganisationsSent,
  markOrganisationUnsent,
  getDailySendCount,
  incrementDailySendCount,
  // Email tracking
  getSettingValue,
  setOrganisationResendId,
  getOrganisationByResendId,
  insertEmailEvent,
  getEmailEventsByOrgId,
  getEmailEventStats,
  getRecentBouncesAndComplaints,
  getEmailTrackingMetrics,
  nowLocal,
};

