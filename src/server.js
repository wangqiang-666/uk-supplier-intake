require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const path = require("node:path");

const { getDb, closeDb, listSources, listRuns, getUnsentOrganisations, markOrganisationsSent, markOrganisationUnsent, insertEmailReply, getEmailReplies, getEmailReplyById, getReplyByMessageId, updateReplyReadStatus, getMonitorState, setMonitorState, matchOrgByEmail, markOrgReplied, getDailySendCount, incrementDailySendCount, nowLocal } = require("./db");
const { startScheduler, runIngest } = require("./scheduler");
const { sendBatch, replyToEmail, verifySmtp, isSmtpConfigured, getTestRecipients } = require("./lib/email-sender");
const { checkForReplies, verifyImap, isImapConfigured, startImapMonitor, stopImapMonitor, getMonitorStatus } = require("./lib/email-monitor");
const { sendToWecom, sendMessageToUser, isNotifyConfigured } = require("./lib/wecom-notifier");
const { runAutoSend, isAutoSendRunning, getRemainingBySource } = require("./lib/auto-sender");
const runtimeConfig = require("./lib/runtime-config");

const PORT = Number(process.env.PORT || "3000");
const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120 }));
app.use(express.static(path.resolve("public")));

function json(res, data, status = 200) {
  res.status(status).json(data);
}

const ORG_SORT = new Set(["id", "name", "external_id", "postcode", "city", "country", "source", "apostille_qualified", "created_at", "updated_at"]);

app.get("/api/sources", (req, res) => {
  const db = getDb();
  json(res, listSources(db));
});

app.get("/api/runs", (req, res) => {
  const db = getDb();
  const source = req.query.source ? String(req.query.source) : undefined;
  const runs = listRuns(db, 30, source);
  // 附带数据库实际入库总数（跨数据源去重后），防止调用方将 org_kept 加总误当作入库数
  const totalInDb = db.prepare("SELECT COUNT(*) AS c FROM organisations").get().c;
  json(res, {
    runs,
    db_total: totalInDb,
    _note: "org_kept 是单次采集筛选保留数，不等于实际入库数。db_total 才是数据库去重后的真实总数。"
  });
});

app.get("/api/next-updates", (req, res) => {
  const db = getDb();
  // 获取每个数据源最后一次成功运行的时间
  const sources = [
    { code: "sra_api", label: "SRA", cron: "weekly_mon_2" },
    { code: "lawsociety_scraper", label: "Law Society", cron: "daily_3" },
    { code: "facultyoffice", label: "Faculty Office", cron: "weekly_mon_4" },
  ];
  const result = [];
  for (const s of sources) {
    const lastRun = db.prepare(
      "SELECT started_at, finished_at FROM runs WHERE source = ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1"
    ).get(s.code);
    result.push({
      source: s.code,
      label: s.label,
      cron: s.cron,
      last_run: lastRun ? lastRun.finished_at || lastRun.started_at : null,
    });
  }
  json(res, result);
});

// 手动触发数据采集
app.post("/api/trigger-scrape", (req, res) => {
  const source = req.body?.source;
  if (!["sra", "lawsociety", "facultyoffice"].includes(source)) {
    return json(res, { error: "Invalid source. Must be: sra, lawsociety, or facultyoffice" }, 400);
  }
  runIngest(source);
  json(res, { message: `${source} scraping triggered` });
});

app.get("/api/organisations", (req, res) => {
  const db = getDb();

  const page = Math.max(1, Number(req.query.page || "1"));
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize || "50")));
  const sort = ORG_SORT.has(String(req.query.sort)) ? String(req.query.sort) : "id";
  const order = String(req.query.order) === "desc" ? "DESC" : "ASC";

  const conditions = [];
  const params = [];

  const source = req.query.source ? String(req.query.source) : "";
  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }

  const search = req.query.search ? String(req.query.search).trim() : "";
  if (search && search.length >= 2) {
    conditions.push("(name LIKE ? OR external_id LIKE ? OR email LIKE ? OR postcode LIKE ? OR city LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS c FROM organisations ${where}`).get(...params).c;
  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(`SELECT * FROM organisations ${where} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset);

  json(res, { total, page, pageSize, totalPages: Math.ceil(total / pageSize), rows });
});

app.get("/api/stats", (req, res) => {
  const db = getDb();
  const source = req.query.source ? String(req.query.source) : "";
  const where = source ? "WHERE source = ?" : "";
  const params = source ? [source] : [];

  const orgs = db.prepare(`SELECT COUNT(*) AS c FROM organisations ${where}`).get(...params).c;
  const lastRun = source
    ? db.prepare("SELECT * FROM runs WHERE source = ? ORDER BY started_at DESC LIMIT 1").get(source)
    : db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 1").get();

  json(res, { organisations: orgs, lastRun: lastRun || null });
});

app.get("/api/email-stats", (req, res) => {
  const db = getDb();
  const source = req.query.source ? String(req.query.source) : "";
  const where = source ? "WHERE source = ? AND email_sent = ?" : "WHERE email_sent = ?";
  const params = source ? [source, 1] : [1];
  const paramsUnsent = source ? [source, 0] : [0];

  const sent = db.prepare(`SELECT COUNT(*) AS c FROM organisations ${where}`).get(...params).c;
  const unsent = db.prepare(`SELECT COUNT(*) AS c FROM organisations ${where}`).get(...paramsUnsent).c;

  json(res, { sent, unsent });
});

app.get("/api/quality-stats", (req, res) => {
  const db = getDb();
  const source = req.query.source ? String(req.query.source) : "";
  const where = source ? "WHERE source = ?" : "";
  const params = source ? [source] : [];

  const total = db.prepare(`SELECT COUNT(*) AS c FROM organisations ${where}`).get(...params).c;

  // 字段完整度
  const fields = ["email", "postcode", "city", "telephone", "website", "authorisation_status"];
  const completeness = {};
  for (const f of fields) {
    const andWhere = where ? `${where} AND` : "WHERE";
    const filled = db.prepare(
      `SELECT COUNT(*) AS c FROM organisations ${andWhere} ${f} != '' AND ${f} IS NOT NULL`
    ).get(...params).c;
    completeness[f] = total > 0 ? Math.round((filled / total) * 100) : 0;
  }

  // work_areas 非空
  const andWhere2 = where ? `${where} AND` : "WHERE";
  const withWorkAreas = db.prepare(
    `SELECT COUNT(*) AS c FROM organisations ${andWhere2} work_areas != '[]' AND work_areas != ''`
  ).get(...params).c;
  completeness.work_areas = total > 0 ? Math.round((withWorkAreas / total) * 100) : 0;

  // 各数据源明细
  const perSource = db.prepare(`
    SELECT source, COUNT(*) as total,
      SUM(CASE WHEN email != '' AND email IS NOT NULL THEN 1 ELSE 0 END) as has_email,
      SUM(CASE WHEN postcode != '' AND postcode IS NOT NULL THEN 1 ELSE 0 END) as has_postcode,
      SUM(CASE WHEN city != '' AND city IS NOT NULL THEN 1 ELSE 0 END) as has_city,
      SUM(CASE WHEN telephone != '' AND telephone IS NOT NULL THEN 1 ELSE 0 END) as has_telephone,
      SUM(CASE WHEN work_areas != '[]' AND work_areas != '' AND work_areas IS NOT NULL THEN 1 ELSE 0 END) as has_work_areas
    FROM organisations ${where}
    GROUP BY source
  `).all(...params);

  json(res, { total, completeness, perSource });
});

// ──────────────────────────────────────────────
// OpenClaw 邮件接口（统一入口）
// POST /api/email/action
// Body: { action: "query" | "send", count: 10, source?: "sra_api" }
// action=query: 只查询，不标记
// action=send: 查询并标记为已发送
// ──────────────────────────────────────────────
app.post("/api/email/action", (req, res) => {
  const db = getDb();

  const { action, count, source } = req.body || {};

  // 参数校验
  if (!action || !["query", "send"].includes(action)) {
    return json(res, { error: "action must be 'query' or 'send'" }, 400);
  }

  const limit = Math.min(200, Math.max(1, Number(count) || 10));

  // 构建查询：只取有 email 且未发送的记录
  const conditions = ["email_sent = 0", "email != ''", "email IS NOT NULL"];
  const params = [];

  if (source) {
    conditions.push("source = ?");
    params.push(String(source));
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // 查出待发送记录
  const rows = db
    .prepare(
      `SELECT id, source, external_id, name, email, telephone, city, postcode,
              organisation_type, work_areas, apostille_qualified, website
       FROM organisations ${where}
       ORDER BY id ASC LIMIT ?`
    )
    .all(...params, limit);

  // 如果是 send 动作，标记为已发送
  if (action === "send" && rows.length > 0) {
    const now = nowLocal();
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");

    db.prepare(
      `UPDATE organisations
       SET email_sent = 1,
           email_sent_at = ?,
           email_send_count = email_send_count + 1,
           updated_at = datetime('now', 'localtime')
       WHERE id IN (${placeholders})`
    ).run(now, ...ids);

    json(res, { action, count: rows.length, rows, marked_as_sent: true });
  } else {
    json(res, { action, count: rows.length, rows });
  }
});

// ──────────────────────────────────────────────
// 邮件发送 & 回复监控 API
// ──────────────────────────────────────────────

// POST /api/email/send-batch — 批量发送邮件
app.post("/api/email/send-batch", async (req, res) => {
  if (!isSmtpConfigured()) {
    return json(res, { error: "SMTP 未配置，请在 .env 中设置 SMTP_HOST/SMTP_USER/SMTP_PASS" }, 503);
  }

  const db = getDb();
  const { count = 10, source, dryRun = false } = req.body || {};
  const limit = Math.min(200, Math.max(1, Number(count)));

  // 查询未发送的记录
  const rows = getUnsentOrganisations(db, { limit, source });

  if (rows.length === 0) {
    return json(res, { requested: limit, sent: 0, failed: 0, results: [], message: "没有待发送的邮件" });
  }

  // 试运行模式：只返回预览
  if (dryRun) {
    const { renderTemplate } = require("./lib/email-template");
    const previews = rows.map((org) => {
      const { subject, body } = renderTemplate(org);
      return { id: org.id, email: org.email, name: org.name, subject, body_preview: body.slice(0, 200) };
    });
    return json(res, { dryRun: true, count: previews.length, previews });
  }

  // 实际发送
  const sentIds = [];
  const failedIds = [];

  const result = await sendBatch(rows, {
    getDailyCount: () => getDailySendCount(db),
    onSent: (org, sendResult) => {
      if (sendResult.success) {
        sentIds.push(org.id);
      } else {
        failedIds.push(org.id);
      }
    },
  });

  // 标记已发送的记录
  if (sentIds.length > 0) {
    markOrganisationsSent(db, sentIds);
    incrementDailySendCount(db, sentIds.length);
  }

  json(res, {
    requested: limit,
    sent: result.sent,
    failed: result.failed,
    test_mode: !!getTestRecipients(),
    test_to: getTestRecipients() || null,
    results: result.results,
  });
});

// GET /api/email/replies — 查询回复列表
app.get("/api/email/replies", (req, res) => {
  const db = getDb();
  const { orgId, matched, page, pageSize } = req.query;
  const data = getEmailReplies(db, {
    orgId: orgId || undefined,
    matched: matched !== undefined ? matched : undefined,
    page: Number(page || 1),
    pageSize: Number(pageSize || 50),
  });
  json(res, data);
});

// GET /api/email/reply-stats — 回复统计
app.get("/api/email/reply-stats", (req, res) => {
  const db = getDb();
  const total = db.prepare("SELECT COUNT(*) AS c FROM email_replies").get().c;
  const matched = db.prepare("SELECT COUNT(*) AS c FROM email_replies WHERE matched = 1").get().c;
  const unmatched = db.prepare("SELECT COUNT(*) AS c FROM email_replies WHERE matched = 0").get().c;
  const unread = db.prepare("SELECT COUNT(*) AS c FROM email_replies WHERE read_status = 0").get().c;
  const orgsReplied = db.prepare("SELECT COUNT(*) AS c FROM organisations WHERE reply_received = 1").get().c;

  json(res, { total_replies: total, matched, unmatched, unread, organisations_replied: orgsReplied });
});

// PATCH /api/email/replies/:id — 标记已读/未读
app.patch("/api/email/replies/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const { read_status } = req.body || {};
  if (read_status === undefined || ![0, 1].includes(Number(read_status))) {
    return json(res, { error: "read_status must be 0 or 1" }, 400);
  }
  updateReplyReadStatus(db, id, Number(read_status));
  json(res, { id, read_status: Number(read_status) });
});

// POST /api/email/check-replies — 手动触发 IMAP 检查
app.post("/api/email/check-replies", async (req, res) => {
  const db = getDb();
  if (!isImapConfigured(db)) {
    return json(res, { error: "IMAP 未配置，请在设置页面填写 IMAP 账号" }, 503);
  }

  const dbOps = { getMonitorState, setMonitorState, getReplyByMessageId, insertEmailReply, matchOrgByEmail, markOrgReplied };
  const result = await checkForReplies(db, dbOps);

  json(res, { checked: true, new_replies: result.newReplies, errors: result.errors });
});

// POST /api/email/reply — 回复一封邮件
app.post("/api/email/reply", async (req, res) => {
  if (!isSmtpConfigured()) {
    return json(res, { error: "SMTP 未配置" }, 503);
  }

  const db = getDb();
  const { reply_id, to, subject, body } = req.body || {};

  if (!body || !body.trim()) {
    return json(res, { error: "body 不能为空" }, 400);
  }

  let replyTo, replySubject, inReplyTo;

  if (reply_id) {
    // 根据 reply_id 找到原始回复记录
    const original = getEmailReplyById(db, Number(reply_id));
    if (!original) {
      return json(res, { error: `reply_id ${reply_id} 不存在` }, 404);
    }
    replyTo = to || original.from_email;
    replySubject = subject || original.subject || "";
    inReplyTo = original.message_id || undefined;
  } else if (to) {
    replyTo = to;
    replySubject = subject || "";
    inReplyTo = undefined;
  } else {
    return json(res, { error: "需要 reply_id 或 to 参数" }, 400);
  }

  const result = await replyToEmail({
    to: replyTo,
    subject: replySubject,
    body: body.trim(),
    inReplyTo,
  });

  if (result.success) {
    // 标记原始回复为已读
    if (reply_id) {
      updateReplyReadStatus(db, Number(reply_id), 1);
    }
    json(res, { success: true, to: replyTo, messageId: result.messageId });
  } else {
    json(res, { success: false, error: result.error }, 500);
  }
});

// GET /api/email/health — SMTP/IMAP 连接状态
app.get("/api/email/health", async (req, res) => {
  const db = getDb();
  const [smtp, imap] = await Promise.all([verifySmtp(), verifyImap(db)]);
  const lastCheck = getMonitorState(db, "last_check_date");
  const monitor = getMonitorStatus();

  const testRecipients = getTestRecipients();
  json(res, {
    smtp,
    imap,
    monitor,
    last_reply_check: lastCheck || null,
    test_mode: !!testRecipients,
    test_to: testRecipients || null,
  });
});

// ──────────────────────────────────────────────
// 设置 API（运行时配置，存储在 SQLite）
// ──────────────────────────────────────────────

// GET /api/settings/imap — 获取 IMAP 配置（密码用 **** 隐藏）
app.get("/api/settings/imap", (req, res) => {
  const db = getDb();
  const c = runtimeConfig.getImapConfig(db);
  json(res, {
    host: c.host || "",
    port: c.port || 993,
    user: c.user || "",
    pass: c.pass || "",
    tls: c.tls !== false,
    checkIntervalMinutes: c.checkIntervalMinutes || 5,
    configured: !!(c.host && c.user && c.pass),
  });
});

// PUT /api/settings/imap — 保存 IMAP 配置，并尝试热重启监听
app.put("/api/settings/imap", async (req, res) => {
  const db = getDb();
  const { host, port, user, pass, tls, checkIntervalMinutes } = req.body || {};

  // 基本校验
  if (user !== undefined && !String(user).trim()) {
    return json(res, { error: "user 不能为空" }, 400);
  }

  // 保存配置
  runtimeConfig.setImapConfig(db, {
    host: host !== undefined ? String(host).trim() : undefined,
    port: port !== undefined ? Number(port) : undefined,
    user: user !== undefined ? String(user).trim() : undefined,
    pass, // 空字符串或 "****" 会被 runtime-config 忽略
    tls: tls !== undefined ? Boolean(tls) : undefined,
    checkIntervalMinutes: checkIntervalMinutes !== undefined ? Number(checkIntervalMinutes) : undefined,
  });

  // 验证连接
  const verifyResult = await verifyImap(db);

  // 无论验证成功与否，都重启监听（失败时监听会在下次 interval 报错）
  stopImapMonitor();
  const dbOps = { getMonitorState, setMonitorState, getReplyByMessageId, insertEmailReply, matchOrgByEmail, markOrgReplied };
  startImapMonitor({ db, dbOps });

  if (verifyResult.connected) {
    json(res, { success: true, message: "配置已保存，IMAP 连接正常，监听已重启", verify: verifyResult });
  } else {
    json(res, {
      success: true,
      warning: true,
      message: "配置已保存，但 IMAP 连接失败，请检查账号密码",
      verify: verifyResult,
    });
  }
});

// GET /api/settings/recipients — 获取通知负责人列表
app.get("/api/settings/recipients", (req, res) => {
  const db = getDb();
  json(res, runtimeConfig.listRecipients(db));
});

// POST /api/settings/recipients — 新增通知负责人
app.post("/api/settings/recipients", (req, res) => {
  const db = getDb();
  const { name, wecom_userid, enabled = 1 } = req.body || {};

  if (!name || !String(name).trim()) {
    return json(res, { error: "name 不能为空" }, 400);
  }
  if (!wecom_userid || !String(wecom_userid).trim()) {
    return json(res, { error: "wecom_userid 不能为空" }, 400);
  }

  const created = runtimeConfig.addRecipient(db, {
    name: String(name).trim(),
    wecom_userid: String(wecom_userid).trim(),
    enabled: enabled ? 1 : 0,
  });
  json(res, created, 201);
});

// PUT /api/settings/recipients/:id — 修改通知负责人
app.put("/api/settings/recipients/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const { name, wecom_userid, enabled } = req.body || {};

  const updated = runtimeConfig.updateRecipient(db, id, { name, wecom_userid, enabled });
  if (!updated) {
    return json(res, { error: `recipient ${id} 不存在` }, 404);
  }
  json(res, updated);
});

// DELETE /api/settings/recipients/:id — 删除通知负责人
app.delete("/api/settings/recipients/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const deleted = runtimeConfig.deleteRecipient(db, id);
  if (!deleted) {
    return json(res, { error: `recipient ${id} 不存在` }, 404);
  }
  json(res, { success: true, id });
});

// POST /api/settings/recipients/:id/test — 给指定负责人发送测试推送
app.post("/api/settings/recipients/:id/test", async (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const recipient = runtimeConfig.getRecipientById(db, id);
  if (!recipient) {
    return json(res, { error: `recipient ${id} 不存在` }, 404);
  }

  const testMessage = `🔔 测试通知\n\n你好 ${recipient.name}，这是来自 UK Supplier Intake 系统的测试推送。\n如果你看到这条消息，说明企业微信通知配置正确。`;
  try {
    const result = await sendMessageToUser(recipient.wecom_userid, testMessage);
    if (result.success) {
      json(res, { success: true, message: `测试消息已发送给 ${recipient.name}`, output: result.output });
    } else {
      json(res, { success: false, error: "推送未成功", output: result.output }, 500);
    }
  } catch (err) {
    const errMsg = (err.stderr || err.message || "").trim();
    json(res, { success: false, error: errMsg }, 500);
  }
});

// ──────────────────────────────────────────────
// 自动邮件发送 API
// ──────────────────────────────────────────────

// GET /api/settings/autosend — 获取自动发送配置和状态
app.get("/api/settings/autosend", (req, res) => {
  const db = getDb();
  json(res, {
    enabled: runtimeConfig.getAutoSendEnabled(db),
    dailyCount: runtimeConfig.getAutoSendDailyCount(db),
    running: isAutoSendRunning(),
    lastRun: runtimeConfig.getAutoSendLastRun(db),
    todaySent: getDailySendCount(db),
    remaining: getRemainingBySource(db),
    dailyLimit: require("./config/email-config").email.dailyLimit,
  });
});

// PUT /api/settings/autosend — 更新自动发送配置
app.put("/api/settings/autosend", (req, res) => {
  const db = getDb();
  const { enabled, dailyCount } = req.body || {};

  if (enabled !== undefined) {
    runtimeConfig.setAutoSendEnabled(db, !!enabled);
  }
  if (dailyCount !== undefined) {
    runtimeConfig.setAutoSendDailyCount(db, dailyCount);
  }

  json(res, {
    success: true,
    enabled: runtimeConfig.getAutoSendEnabled(db),
    dailyCount: runtimeConfig.getAutoSendDailyCount(db),
  });
});

// POST /api/email/auto-send/trigger — 手动触发一次自动发送
app.post("/api/email/auto-send/trigger", async (req, res) => {
  if (isAutoSendRunning()) {
    return json(res, { error: "自动发送正在运行中，请稍后再试" }, 409);
  }

  const db = getDb();
  // 手动触发时 force=true，即使开关关闭也可以执行
  const result = await runAutoSend(db, { force: true });
  json(res, result);
});

app.get("/api/export-orgs", (req, res) => {
  const db = getDb();

  const conditions = [];
  const params = [];

  const source = req.query.source ? String(req.query.source) : "";
  if (source) {
    conditions.push("source = ?");
    params.push(source);
  }

  const search = req.query.search ? String(req.query.search).trim() : "";
  if (search && search.length >= 2) {
    conditions.push("(name LIKE ? OR external_id LIKE ? OR email LIKE ? OR postcode LIKE ? OR city LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM organisations ${where} ORDER BY id`).all(...params);
  if (rows.length === 0) {
    res.status(200).type("text/plain").send("No data");
    return;
  }

  const headers = Object.keys(rows[0]);
  const lines = [];
  lines.push(headers.join(","));
  for (const r of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = r[h];
          const s = v == null ? "" : String(v);
          if (/[\",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
          return s;
        })
        .join(","),
    );
  }

  const filename = `organisations_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("\uFEFF" + lines.join("\n"));
});

app.listen(PORT, () => {
  console.log(`Web server running at http://localhost:${PORT}`);
  console.log(`Tip: run "npm run ingest" first to load SRA organisations into SQLite.`);

  // 启动定时任务调度器
  startScheduler();
});

process.on("SIGINT", () => {
  closeDb();
  process.exit(0);
});

