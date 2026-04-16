/**
 * 邮件 & 通知 集中配置文件
 * 所有邮件相关的配置都在这里，方便直接修改
 * 每项配置优先读取环境变量，如果没设则使用下面的默认值
 */

const config = {
  // ──────── Resend API 发送 ────────
  resend: {
    apiKey: process.env.RESEND_API_KEY || "re_iem3Z5bk_9Ju2F6MgSyrkZNUtRZsUHKaT",
  },

  // ──────── SMTP 发送（备用，Resend 优先）────────
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || "true") === "true",
    user: process.env.SMTP_USER || "wqtest168@gmail.com",
    pass: process.env.SMTP_PASS || "pqfs zild hrnb vfaw",
  },

  // ──────── IMAP 监听 ────────
  imap: {
    host: process.env.IMAP_HOST || "mail.station173.com",
    port: Number(process.env.IMAP_PORT || 993),
    tls: (process.env.IMAP_TLS || "true") !== "false",
    user: process.env.IMAP_USER || "jacky@inotary.com.hk",
    pass: process.env.IMAP_PASS || "CRbwiznwSHym",
    checkIntervalMinutes: Number(process.env.IMAP_CHECK_INTERVAL_MINUTES || 5),
  },

  // ──────── 邮件内容 ────────
  email: {
    fromName: process.env.EMAIL_FROM_NAME || "iNotary",
    fromAddress: process.env.EMAIL_FROM_ADDRESS || "partnerships@inotary.io",
    subject: process.env.EMAIL_SUBJECT || "International clients looking for a notary in {{org_city}}",
    replyTo: process.env.EMAIL_REPLY_TO || "jacky@inotary.com.hk",
    batchSize: Number(process.env.EMAIL_BATCH_SIZE || 20),
    intervalMs: Number(process.env.EMAIL_INTERVAL_MS || 2000),
    dailyLimit: Number(process.env.EMAIL_DAILY_LIMIT || 450),
    // 测试模式：设置后所有邮件发到这个地址，不设则发给真实目标
    testTo: process.env.EMAIL_TEST_TO || "",
  },

  // ──────── 企业微信通知（OpenClaw Gateway）────────
  wecom: {
    gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || "http://openclaw-gateway:18789",
    gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || "7d53a6958058c653b4f93f0c0b1737300c083d3898bfe09d",
    notifyTo: process.env.WECOM_NOTIFY_TO || "Jacky",  // 企业微信 userid，逗号分隔
  },

  // ──────── 代理配置（本地开发用，服务器上设为空即可关闭）────────
  proxy: {
    // HTTP 代理地址，如 "http://127.0.0.1:10808"，设为空字符串表示不使用代理
    url: process.env.PROXY_URL !== undefined ? process.env.PROXY_URL : "http://127.0.0.1:10808",
  },
};

module.exports = config;
