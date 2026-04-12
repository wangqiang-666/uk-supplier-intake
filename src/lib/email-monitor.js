/**
 * IMAP 邮件回复监控模块
 * 轮询收件箱，匹配回复到 organisation，存入 email_replies 表
 *
 * IMAP 配置优先从数据库 settings 表读取（可通过 Web 页面修改），
 * 未配置时回退到 email-config.js 的 env 默认值。
 */
const imapSimple = require("imap-simple");
const { simpleParser } = require("mailparser");
const { notifyEmailReply, isNotifyConfigured } = require("./wecom-notifier");
const cfg = require("../config/email-config");
const runtimeConfig = require("./runtime-config");
const { nowLocal } = require("../db");

/**
 * 将 Date 对象转为北京时间字符串 "YYYY-MM-DD HH:mm:ss"
 */
function dateToLocal(d) {
  if (!d) return nowLocal();
  return new Date(d).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/\//g, "-");
}

/**
 * 通过 HTTP 代理建立 TCP 隧道（CONNECT 方式）
 */
function createProxySocket(targetHost, targetPort, proxyUrl) {
  const http = require("http");
  const { URL } = require("url");
  const proxy = new URL(proxyUrl);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
    });
    req.setTimeout(15000);
    req.on("connect", (_res, socket) => resolve(socket));
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Proxy CONNECT timeout")); });
    req.end();
  });
}

/**
 * 获取当前 IMAP 配置（优先从数据库读取）
 * @param {object} [db] - 可选的数据库实例，不传则回退到 email-config.js
 */
function _getImapCfg(db) {
  if (db) {
    return runtimeConfig.getImapConfig(db);
  }
  return cfg.imap;
}

/**
 * 检查 IMAP 是否已配置
 * @param {object} [db] - 可选的数据库实例
 */
function isImapConfigured(db) {
  const c = _getImapCfg(db);
  return !!(c.host && c.user && c.pass);
}

/**
 * 获取 IMAP 连接配置（imap-simple 格式）
 * @param {object} [db] - 可选的数据库实例
 */
function getImapConfig(db) {
  const c = _getImapCfg(db);
  return {
    imap: {
      user: c.user,
      password: c.pass,
      host: c.host,
      port: c.port,
      tls: c.tls,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false },
    },
  };
}

/**
 * 连接 IMAP，自动处理代理
 * @param {object} [db] - 可选的数据库实例
 */
async function connectImap(db) {
  const imapCfg = getImapConfig(db);
  const c = _getImapCfg(db);

  if (cfg.proxy.url) {
    const socket = await createProxySocket(c.host, c.port, cfg.proxy.url);
    socket.connect = function () { return this; };
    imapCfg.imap.socket = socket;
  }

  const connection = await imapSimple.connect(imapCfg);
  connection.on("error", () => {});
  if (connection._imap) {
    connection._imap.on("error", () => {});
  }
  return connection;
}

/**
 * 安全关闭 IMAP 连接（忽略断开时的 SSL 错误）
 */
async function safeEnd(connection) {
  if (!connection) return;
  try {
    // 移除所有 error listener 防止 unhandled error crash
    // 需要同时处理 ImapSimple 实例和底层 node-imap Connection
    connection.removeAllListeners("error");
    connection.on("error", () => {}); // swallow ImapSimple 层的 error
    if (connection._imap) {
      connection._imap.removeAllListeners("error");
      connection._imap.on("error", () => {}); // swallow node-imap 层的 error
    }
    await connection.end();
  } catch (_) {
    // 忽略关闭时的错误
  }
}

/**
 * 验证 IMAP 连接
 * @param {object} [db] - 可选的数据库实例
 */
async function verifyImap(db) {
  const c = _getImapCfg(db);
  if (!isImapConfigured(db)) {
    return { connected: false, host: "(未配置)" };
  }
  let connection;
  try {
    connection = await connectImap(db);
    await safeEnd(connection);
    return { connected: true, host: c.host, user: c.user };
  } catch (err) {
    await safeEnd(connection);
    return { connected: false, host: c.host, user: c.user, error: err.message };
  }
}

/**
 * 检查收件箱中的新回复
 * @param {Object} db - better-sqlite3 数据库实例
 * @param {Object} dbOps - 数据库操作函数 { getMonitorState, setMonitorState, getReplyByMessageId, insertEmailReply, matchOrgByEmail, markOrgReplied }
 * @returns {{ newReplies: number, errors: string[] }}
 */
async function checkForReplies(db, dbOps) {
  if (!isImapConfigured(db)) {
    return { newReplies: 0, errors: ["IMAP 未配置"] };
  }

  const errors = [];
  let newReplies = 0;
  let connection;

  try {
    connection = await connectImap(db);
    await connection.openBox("INBOX");

    // 获取上次检查时间，默认查最近 7 天
    const lastCheck = dbOps.getMonitorState(db, "last_check_date");
    const sinceDate = lastCheck
      ? new Date(lastCheck)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 搜索条件：指定日期之后的未读邮件
    const searchCriteria = ["UNSEEN", ["SINCE", sinceDate]];
    const fetchOptions = {
      bodies: ["HEADER", "TEXT", ""],
      markSeen: false,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    console.log(`[email-monitor] 找到 ${messages.length} 封未读邮件`);

    for (const msg of messages) {
      try {
        // 获取完整邮件内容用于解析
        const allPart = msg.parts.find((p) => p.which === "");
        if (!allPart) continue;

        const parsed = await simpleParser(allPart.body);

        const messageId = parsed.messageId || "";
        const fromEmail = parsed.from?.value?.[0]?.address || "";
        const subject = parsed.subject || "";
        const body = parsed.text || "";
        const receivedAt = dateToLocal(parsed.date);

        if (!fromEmail) continue;

        // 去重：检查 message_id 是否已存在
        if (messageId && dbOps.getReplyByMessageId(db, messageId)) {
          continue;
        }

        // 匹配发件人到 organisation
        const org = dbOps.matchOrgByEmail(db, fromEmail.toLowerCase());
        const organisationId = org ? org.id : null;
        const matched = org ? 1 : 0;

        // 插入回复记录
        dbOps.insertEmailReply(db, {
          organisation_id: organisationId,
          from_email: fromEmail.toLowerCase(),
          subject,
          body: body.slice(0, 10000), // 限制长度
          message_id: messageId,
          received_at: receivedAt,
          matched,
        });

        // 标记 organisation 已回复
        if (org) {
          dbOps.markOrgReplied(db, org.id);
        }

        newReplies++;
        console.log(
          `[email-monitor] 新回复: ${fromEmail} - "${subject.slice(0, 50)}" ${matched ? "(已匹配)" : "(未匹配)"}`
        );

        // 推送企业微信通知
        if (isNotifyConfigured(db)) {
          try {
            await notifyEmailReply(
              db,
              { id: null, from_email: fromEmail, subject, body: body.slice(0, 500), received_at: receivedAt },
              org || null
            );
          } catch (notifyErr) {
            console.error(`[email-monitor] 推送通知失败: ${notifyErr.message}`);
          }
        }
      } catch (msgErr) {
        errors.push(`解析邮件失败: ${msgErr.message}`);
      }
    }

    // 更新上次检查时间
    const now = nowLocal();
    dbOps.setMonitorState(db, "last_check_date", now);
  } catch (err) {
    errors.push(`IMAP 连接/搜索失败: ${err.message}`);
    console.error("[email-monitor] 错误:", err.message);
  } finally {
    await safeEnd(connection);
  }

  return { newReplies, errors };
}

// ──────── 定时轮询管理（支持热重启）────────

let _pollTimer = null;
let _pollIntervalMs = null;

/**
 * 启动 IMAP 定时轮询
 * @param {object} options
 * @param {object} options.db - 数据库实例
 * @param {object} options.dbOps - 数据库操作函数集
 * @param {number} [options.intervalMinutes] - 轮询间隔（分钟），默认从 runtime-config 读取
 */
function startImapMonitor({ db, dbOps, intervalMinutes } = {}) {
  stopImapMonitor();

  const minutes = intervalMinutes || runtimeConfig.getImapConfig(db).checkIntervalMinutes || 5;
  _pollIntervalMs = minutes * 60 * 1000;

  console.log(`[email-monitor] 启动 IMAP 轮询，每 ${minutes} 分钟检查一次`);

  _pollTimer = setInterval(async () => {
    if (!isImapConfigured(db)) return;
    try {
      const result = await checkForReplies(db, dbOps);
      if (result.newReplies > 0) {
        console.log(`[email-monitor] 本轮检测到 ${result.newReplies} 条新回复`);
      }
      if (result.errors.length > 0) {
        console.error("[email-monitor] 检查错误:", result.errors.join("; "));
      }
    } catch (err) {
      console.error("[email-monitor] 轮询异常:", err.message);
    }
  }, _pollIntervalMs);
}

/**
 * 停止 IMAP 定时轮询
 */
function stopImapMonitor() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
    _pollIntervalMs = null;
    console.log("[email-monitor] 已停止 IMAP 轮询");
  }
}

/**
 * 获取当前轮询状态
 */
function getMonitorStatus() {
  return {
    running: !!_pollTimer,
    intervalMs: _pollIntervalMs,
  };
}

module.exports = {
  checkForReplies,
  verifyImap,
  isImapConfigured,
  startImapMonitor,
  stopImapMonitor,
  getMonitorStatus,
};
