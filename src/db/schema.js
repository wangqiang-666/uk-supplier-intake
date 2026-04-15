/**
 * SQLite schema (multi-source ready).
 *
 * We start with SRA Data Sharing API organisations.
 * Other sources can be added by inserting rows into `sources` and writing new ingesters.
 */

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sources (
      code        TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      country     TEXT NOT NULL,
      website     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id        TEXT PRIMARY KEY,
      source        TEXT NOT NULL REFERENCES sources(code),
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      org_total     INTEGER DEFAULT 0,
      org_kept      INTEGER DEFAULT 0,
      config        TEXT
    );

    CREATE TABLE IF NOT EXISTS organisations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL REFERENCES sources(code),
      external_id     TEXT NOT NULL,
      name            TEXT NOT NULL,
      authorisation_status TEXT DEFAULT '',
      organisation_type    TEXT DEFAULT '',
      work_areas       TEXT DEFAULT '[]', -- JSON array

      address_line1    TEXT DEFAULT '',
      address_line2    TEXT DEFAULT '',
      address_line3    TEXT DEFAULT '',
      city             TEXT DEFAULT '',
      county           TEXT DEFAULT '',
      postcode         TEXT DEFAULT '',
      country          TEXT DEFAULT '',
      telephone        TEXT DEFAULT '',
      email            TEXT DEFAULT '',
      website          TEXT DEFAULT '',
      office_type      TEXT DEFAULT '',

      source_url       TEXT DEFAULT '',
      raw_json         TEXT DEFAULT '{}',

      first_seen_run   TEXT NOT NULL,
      last_seen_run    TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),

      email_sent       INTEGER NOT NULL DEFAULT 0,
      email_sent_at    TEXT,
      email_send_count INTEGER NOT NULL DEFAULT 0,

      apostille_qualified INTEGER NOT NULL DEFAULT 0, -- 海牙认证资质: 1=有, 0=无/未知

      UNIQUE(source, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_source     ON organisations(source);
    CREATE INDEX IF NOT EXISTS idx_org_name       ON organisations(name);
    CREATE INDEX IF NOT EXISTS idx_org_email_sent ON organisations(email_sent);

    -- 邮件回复表
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

    -- 邮件监控状态（key-value）
    CREATE TABLE IF NOT EXISTS email_monitor_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 运行时配置（key-value，用于页面上可配置的设置，如 IMAP 账号）
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 通知推送负责人列表（企业微信）
    CREATE TABLE IF NOT EXISTS notify_recipients (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      wecom_userid  TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    -- 邮件事件追踪表（用于记录 Resend 邮件的送达、打开、点击等事件）
    CREATE TABLE IF NOT EXISTS email_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      resend_email_id TEXT NOT NULL,
      organisation_id INTEGER REFERENCES organisations(id),
      event_type      TEXT NOT NULL,
      event_data      TEXT DEFAULT '{}',
      created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),

      UNIQUE(resend_email_id, event_type)
    );

    CREATE INDEX IF NOT EXISTS idx_event_resend_id ON email_events(resend_email_id);
    CREATE INDEX IF NOT EXISTS idx_event_org_id ON email_events(organisation_id);
    CREATE INDEX IF NOT EXISTS idx_event_type ON email_events(event_type);
  `);

  // 迁移：将 email_events 的 UNIQUE 约束从 (resend_email_id, event_type, created_at)
  // 改为 (resend_email_id, event_type)，防止同一事件重复入库导致重复推送通知
  try {
    const tableInfo = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='email_events'
    `).get();
    // 只有当表存在且含有旧版 UNIQUE(..., created_at) 时才迁移
    if (tableInfo && /UNIQUE\s*\([^)]*created_at[^)]*\)/i.test(tableInfo.sql)) {
      db.exec(`
        BEGIN;
        CREATE TABLE email_events_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          resend_email_id TEXT NOT NULL,
          organisation_id INTEGER REFERENCES organisations(id),
          event_type      TEXT NOT NULL,
          event_data      TEXT DEFAULT '{}',
          created_at      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
          UNIQUE(resend_email_id, event_type)
        );
        INSERT OR IGNORE INTO email_events_new (resend_email_id, organisation_id, event_type, event_data, created_at)
          SELECT resend_email_id, organisation_id, event_type, event_data, MIN(created_at)
          FROM email_events GROUP BY resend_email_id, event_type;
        DROP TABLE email_events;
        ALTER TABLE email_events_new RENAME TO email_events;
        CREATE INDEX IF NOT EXISTS idx_event_resend_id ON email_events(resend_email_id);
        CREATE INDEX IF NOT EXISTS idx_event_org_id ON email_events(organisation_id);
        CREATE INDEX IF NOT EXISTS idx_event_type ON email_events(event_type);
        COMMIT;
      `);
      console.log('[schema] email_events UNIQUE 约束已迁移: (resend_email_id, event_type)');
    }
  } catch (e) {
    console.warn('[schema] email_events 迁移失败:', e.message);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO sources (code, name, country, website)
    VALUES (@code, @name, @country, @website)
  `);

  insert.run({
    code: "sra_api",
    name: "SRA Data Sharing API",
    country: "GB",
    website: "https://sra-prod-apim.azure-api.net",
  });

  insert.run({
    code: "facultyoffice",
    name: "The Faculty Office (NotaryPRO)",
    country: "GB",
    website: "https://notarypro.facultyoffice.org.uk",
  });

  insert.run({
    code: "lawsociety_scraper",
    name: "The Law Society (Find a Solicitor)",
    country: "GB",
    website: "https://solicitors.lawsociety.org.uk",
  });
}

module.exports = { initSchema };

