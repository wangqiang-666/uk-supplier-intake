/**
 * 邮件发送模块
 * 优先使用 Resend API（inotary.io 域名），备用 Nodemailer SMTP
 */
const { Resend } = require("resend");
const nodemailer = require("nodemailer");
const { renderTemplate } = require("./email-template");
const cfg = require("../config/email-config");

let _resend = null;
let _transporter = null;

/**
 * 获取 Resend 客户端
 */
function getResend() {
  if (!_resend) {
    _resend = new Resend(cfg.resend.apiKey);
  }
  return _resend;
}

/**
 * 检查 Resend 是否已配置
 */
function isResendConfigured() {
  return !!(cfg.resend.apiKey);
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
 * 创建 Nodemailer transporter（备用）
 */
async function getTransporter() {
  if (!cfg.proxy.url) {
    if (_transporter) return _transporter;
    const { host, port, user, pass, secure } = cfg.smtp;
    if (!host || !user || !pass) {
      throw new Error("SMTP 未配置，请检查 src/config/email-config.js 中的 smtp 配置");
    }
    _transporter = nodemailer.createTransport({
      host, port, secure,
      auth: { user, pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 15000,
    });
    return _transporter;
  }

  const { host, port, user, pass, secure } = cfg.smtp;
  if (!host || !user || !pass) {
    throw new Error("SMTP 未配置，请检查 src/config/email-config.js 中的 smtp 配置");
  }
  const socket = await createProxySocket(host, port, cfg.proxy.url);
  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    connection: socket,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
  });
}

/**
 * 检查 SMTP 连接是否正常
 */
async function verifySmtp() {
  // 如果用 Resend，验证 API Key
  if (isResendConfigured()) {
    try {
      const resend = getResend();
      await resend.domains.list();
      return { connected: true, host: "resend.com (API)", provider: "resend" };
    } catch (err) {
      return { connected: false, host: "resend.com (API)", provider: "resend", error: err.message };
    }
  }

  // 备用 SMTP
  try {
    const transporter = await getTransporter();
    await transporter.verify();
    return { connected: true, host: cfg.smtp.host, provider: "smtp" };
  } catch (err) {
    return { connected: false, host: cfg.smtp.host || "(未配置)", provider: "smtp", error: err.message };
  }
}

/**
 * 获取测试模式目标邮箱列表
 */
function getTestRecipients() {
  const testTo = (cfg.email.testTo || "").trim();
  if (!testTo) return null;
  return testTo.split(",").map((e) => e.trim()).filter(Boolean);
}

/**
 * 通过 Resend API 发送邮件
 */
async function sendViaResend(to, subject, body, options = {}) {
  const resend = getResend();
  const fromName = cfg.email.fromName;
  const fromAddr = cfg.email.fromAddress;
  const from = fromName ? `${fromName} <${fromAddr}>` : fromAddr;

  const replyTo = cfg.email.replyTo || fromAddr;
  const emailData = { from, to, subject, text: body, replyTo: [replyTo] };

  if (options.inReplyTo) {
    emailData.headers = {
      "In-Reply-To": options.inReplyTo,
      "References": options.inReplyTo,
    };
  }

  const { data, error } = await resend.emails.send(emailData);

  if (error) {
    throw new Error(error.message || JSON.stringify(error));
  }

  return { messageId: data.id };
}

/**
 * 通过 SMTP 发送邮件（备用）
 */
async function sendViaSmtp(to, subject, body, options = {}) {
  const transporter = await getTransporter();
  const fromName = cfg.email.fromName;
  const fromAddr = cfg.email.fromAddress || cfg.smtp.user;
  const from = fromName ? `"${fromName}" <${fromAddr}>` : fromAddr;

  const replyTo = cfg.email.replyTo || fromAddr;
  const mailOptions = { from, to, subject, text: body, replyTo };

  if (options.inReplyTo) {
    mailOptions.inReplyTo = options.inReplyTo;
    mailOptions.references = options.inReplyTo;
  }

  const info = await transporter.sendMail(mailOptions);
  return { messageId: info.messageId };
}

/**
 * 发送单封邮件
 */
async function sendEmail(org) {
  try {
    const { subject, body } = renderTemplate(org);

    const testRecipients = getTestRecipients();
    const to = testRecipients ? testRecipients.join(", ") : org.email;

    let result;
    if (isResendConfigured()) {
      result = await sendViaResend(to, subject, body);
    } else {
      result = await sendViaSmtp(to, subject, body);
    }

    return { success: true, messageId: result.messageId, actualTo: to };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * 批量发送邮件，带速率控制和每日限额
 */
async function sendBatch(organisations, options = {}) {
  const intervalMs = cfg.email.intervalMs || options.intervalMs || 2000;
  const dailyLimit = cfg.email.dailyLimit;

  let dailySent = 0;
  if (options.getDailyCount) {
    dailySent = await options.getDailyCount();
  }

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const org of organisations) {
    if (dailySent + sent >= dailyLimit) {
      console.warn(`[email-sender] 达到每日限额 ${dailyLimit}，停止发送`);
      results.push({ id: org.id, email: org.email, success: false, error: "Daily limit reached" });
      failed++;
      continue;
    }

    const result = await sendEmail(org);
    results.push({ id: org.id, email: org.email, ...result });

    if (result.success) {
      sent++;
      const testRecipients = getTestRecipients();
      if (testRecipients) {
        console.log(`[email-sender] [测试模式] 发送成功: → ${testRecipients.join(", ")} (模板: ${org.name})`);
      } else {
        console.log(`[email-sender] 发送成功: ${org.email} (${org.name})`);
      }
    } else {
      failed++;
      console.error(`[email-sender] 发送失败: ${org.email} - ${result.error}`);
    }

    if (options.onSent) {
      options.onSent(org, result);
    }

    if (organisations.indexOf(org) < organisations.length - 1) {
      await sleep(intervalMs);
    }
  }

  return { sent, failed, results };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 检查邮件发送是否已配置（Resend 或 SMTP）
 */
function isSmtpConfigured() {
  if (isResendConfigured()) return true;
  return !!(cfg.smtp.host && cfg.smtp.user && cfg.smtp.pass);
}

/**
 * 回复一封邮件
 */
async function replyToEmail({ to, subject, body, inReplyTo }) {
  try {
    const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

    let result;
    if (isResendConfigured()) {
      result = await sendViaResend(to, replySubject, body, { inReplyTo });
    } else {
      result = await sendViaSmtp(to, replySubject, body, { inReplyTo });
    }

    return { success: true, messageId: result.messageId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sendEmail, sendBatch, replyToEmail, verifySmtp, isSmtpConfigured, getTestRecipients };
