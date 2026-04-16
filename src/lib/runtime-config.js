/**
 * 运行时动态配置模块
 *
 * 这个模块从数据库读取可以通过 Web 页面修改的配置（IMAP 账号、通知负责人），
 * 如果数据库没有对应值，就回退到 src/config/email-config.js 的 env/默认值。
 *
 * 所有读取函数都是即时从 DB 读取，不做缓存，这样修改保存后立即生效。
 */
const cfg = require("../config/email-config");

// ──────── IMAP 配置 ────────

const IMAP_KEYS = ["imap.host", "imap.port", "imap.user", "imap.pass", "imap.tls", "imap.checkIntervalMinutes"];

/**
 * 从数据库读取 IMAP 配置，未设置的字段回退到 email-config.js 默认值
 */
function getImapConfig(db) {
  const rows = db.prepare(
    `SELECT key, value FROM settings WHERE key IN (${IMAP_KEYS.map(() => "?").join(",")})`
  ).all(...IMAP_KEYS);
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  return {
    host: map["imap.host"] ?? cfg.imap.host,
    port: Number(map["imap.port"] ?? cfg.imap.port),
    user: map["imap.user"] ?? cfg.imap.user,
    pass: map["imap.pass"] ?? cfg.imap.pass,
    tls: map["imap.tls"] !== undefined ? map["imap.tls"] === "true" : cfg.imap.tls,
    checkIntervalMinutes: Number(map["imap.checkIntervalMinutes"] ?? cfg.imap.checkIntervalMinutes),
  };
}

/**
 * 更新 IMAP 配置，只写入传入的字段
 * @param {object} patch - { host?, port?, user?, pass?, tls?, checkIntervalMinutes? }
 */
function setImapConfig(db, patch) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) {
      if (value === undefined || value === null) continue;
      upsert.run(key, String(value));
    }
  });

  const entries = [];
  if (patch.host !== undefined) entries.push(["imap.host", patch.host]);
  if (patch.port !== undefined) entries.push(["imap.port", patch.port]);
  if (patch.user !== undefined) {
    entries.push(["imap.user", patch.user]);
    // 二合一：IMAP 用户邮箱同时作为邮件 Reply-To 地址
    entries.push(["email.replyTo", patch.user]);
  }
  if (patch.pass !== undefined && patch.pass !== "" && patch.pass !== "****") {
    entries.push(["imap.pass", patch.pass]);
  }
  if (patch.tls !== undefined) entries.push(["imap.tls", patch.tls ? "true" : "false"]);
  if (patch.checkIntervalMinutes !== undefined) entries.push(["imap.checkIntervalMinutes", patch.checkIntervalMinutes]);

  tx(entries);
}

// ──────── 通知负责人 ────────

function listRecipients(db) {
  return db.prepare(
    "SELECT id, name, wecom_userid, enabled, created_at, updated_at FROM notify_recipients ORDER BY id ASC"
  ).all();
}

function getEnabledRecipients(db) {
  return db.prepare(
    "SELECT id, name, wecom_userid FROM notify_recipients WHERE enabled = 1 ORDER BY id ASC"
  ).all();
}

function getRecipientById(db, id) {
  return db.prepare(
    "SELECT id, name, wecom_userid, enabled FROM notify_recipients WHERE id = ?"
  ).get(id);
}

function addRecipient(db, { name, wecom_userid, enabled = 1 }) {
  const res = db.prepare(
    `INSERT INTO notify_recipients (name, wecom_userid, enabled)
     VALUES (?, ?, ?)`
  ).run(String(name), String(wecom_userid), enabled ? 1 : 0);
  return getRecipientById(db, res.lastInsertRowid);
}

function updateRecipient(db, id, patch) {
  const current = getRecipientById(db, id);
  if (!current) return null;
  const next = {
    name: patch.name !== undefined ? String(patch.name) : current.name,
    wecom_userid: patch.wecom_userid !== undefined ? String(patch.wecom_userid) : current.wecom_userid,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled,
  };
  db.prepare(
    `UPDATE notify_recipients
     SET name = ?, wecom_userid = ?, enabled = ?, updated_at = datetime('now', 'localtime')
     WHERE id = ?`
  ).run(next.name, next.wecom_userid, next.enabled, id);
  return getRecipientById(db, id);
}

function deleteRecipient(db, id) {
  const res = db.prepare("DELETE FROM notify_recipients WHERE id = ?").run(id);
  return res.changes > 0;
}

// ──────── 自动发送配置 ────────

function _getSetting(db, key, defaultValue) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : defaultValue;
}

function _setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now', 'localtime'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

function getAutoSendEnabled(db) {
  return _getSetting(db, "autosend.enabled", "false") === "true";
}

function setAutoSendEnabled(db, enabled) {
  _setSetting(db, "autosend.enabled", enabled ? "true" : "false");
}

function getAutoSendDailyCount(db) {
  return Number(_getSetting(db, "autosend.daily_count", "100")) || 100;
}

function setAutoSendDailyCount(db, count) {
  _setSetting(db, "autosend.daily_count", String(Math.max(1, Math.min(500, Number(count) || 100))));
}

function getAutoSendLastRun(db) {
  const raw = _getSetting(db, "autosend.last_run", null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function setAutoSendLastRun(db, info) {
  _setSetting(db, "autosend.last_run", JSON.stringify(info));
}

// ──────── 邮件模板配置 ────────

function getEmailTemplate(db) {
  const subject = _getSetting(db, "email.subject", null);
  const body = _getSetting(db, "email.body", null);
  return {
    subject: subject || cfg.email.subject,
    body: body || null, // null 表示使用内置默认模板
  };
}

function setEmailTemplate(db, { subject, body }) {
  if (subject !== undefined) _setSetting(db, "email.subject", subject);
  if (body !== undefined) _setSetting(db, "email.body", body);
}

// ──────── 首次启动种子数据 ────────

/**
 * 如果 settings 表里没有 IMAP 配置，就从 email-config.js 的默认值填入；
 * 如果 notify_recipients 表是空的，就插入一条默认记录（来自 cfg.wecom.notifyTo）。
 */
function seedDefaultsFromEnv(db) {
  // Seed IMAP 配置
  const existingKeys = db.prepare(
    `SELECT key FROM settings WHERE key LIKE 'imap.%'`
  ).all().map((r) => r.key);

  if (existingKeys.length === 0) {
    setImapConfig(db, {
      host: cfg.imap.host,
      port: cfg.imap.port,
      user: cfg.imap.user,
      pass: cfg.imap.pass,
      tls: cfg.imap.tls,
      checkIntervalMinutes: cfg.imap.checkIntervalMinutes,
    });
    console.log("[runtime-config] 已从 env 初始化 IMAP 配置到 settings 表");
  }

  // Seed 自动发送配置
  if (!_getSetting(db, "autosend.enabled", null)) {
    _setSetting(db, "autosend.enabled", "false");
    _setSetting(db, "autosend.daily_count", "100");
    console.log("[runtime-config] 已初始化自动发送配置 (默认关闭, 每日 100 封)");
  }

  // Seed 邮件模板
  if (!_getSetting(db, "email.subject", null)) {
    _setSetting(db, "email.subject", cfg.email.subject);
    console.log("[runtime-config] 已初始化邮件标题模板到 settings 表");
  }

  // Seed 默认负责人
  const recipientCount = db.prepare("SELECT COUNT(*) AS c FROM notify_recipients").get().c;
  if (recipientCount === 0) {
    const defaultIds = (cfg.wecom.notifyTo || "Jacky").split(",").map((s) => s.trim()).filter(Boolean);
    for (const userid of defaultIds) {
      db.prepare(
        `INSERT INTO notify_recipients (name, wecom_userid, enabled) VALUES (?, ?, 1)`
      ).run(userid, userid);
    }
    console.log(`[runtime-config] 已初始化默认通知负责人: ${defaultIds.join(", ")}`);
  }
}

/**
 * 获取 Reply-To 邮箱：优先从数据库（跟随 IMAP 用户邮箱），否则使用 env/默认
 */
function getReplyToEmail(db) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("email.replyTo");
  if (row && row.value) return row.value;
  return cfg.email.replyTo;
}

module.exports = {
  getImapConfig,
  setImapConfig,
  getReplyToEmail,
  getEmailTemplate,
  setEmailTemplate,
  listRecipients,
  getEnabledRecipients,
  getRecipientById,
  addRecipient,
  updateRecipient,
  deleteRecipient,
  seedDefaultsFromEnv,
  getAutoSendEnabled,
  setAutoSendEnabled,
  getAutoSendDailyCount,
  setAutoSendDailyCount,
  getAutoSendLastRun,
  setAutoSendLastRun,
};
