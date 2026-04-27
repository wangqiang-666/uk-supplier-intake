/**
 * 周报：按天统计最近 7 日的邮件漏斗指标（送达率 / 打开率 / 退信率），
 * 渲染成 PNG 折线图并推送到企业微信。
 *
 * 纯新增模块，不修改现有 daily 推送 / tracking / auto-sender 流程。
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

const runtimeConfig = require("./runtime-config");
const { sendImageToAllRecipients } = require("./wecom-image");

/**
 * 取最近 N 天里出现过的所有主题（去重）。
 * 主题来源：email_events 表里 event_type='subject.recorded' 的事件 JSON。
 * 没有该事件的邮件归到 null 主题（"未标注主题"），周报会忽略以避免污染视野。
 */
function getActiveSubjects(db, { days = 7 } = {}) {
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(e.event_data, '$.subject') AS subject
    FROM organisations o
    JOIN email_events e
      ON e.resend_email_id = o.resend_email_id
     AND e.event_type = 'subject.recorded'
    WHERE o.email_sent_at IS NOT NULL
      AND DATE(o.email_sent_at) >= DATE('now', ?)
      AND DATE(o.email_sent_at) <  DATE('now')
  `).all(`-${days} days`);
  return rows.map((r) => r.subject).filter(Boolean);
}

/**
 * 聚合最近 N 天（按天）邮件漏斗数据。
 * 以 o.email_sent_at 所在"伦敦日期"分组，对齐日报口径。
 *
 * @param {object} opts
 * @param {number} opts.days
 * @param {string|null} opts.subject — 若给出，只统计该主题的邮件
 *
 * 返回按日期升序排列的数组：
 *   [{ day: 'YYYY-MM-DD', sent, delivered, opened, bounced,
 *      deliveryRate, openRate, bounceRate }, ...]
 */
function getDailyFunnel(db, { days = 7, subject = null } = {}) {
  const cutoffModifier = `-${days} days`;

  if (subject) {
    return db.prepare(`
      SELECT
        DATE(o.email_sent_at) AS day,
        COUNT(DISTINCT o.resend_email_id) AS sent,
        COUNT(DISTINCT CASE WHEN e.event_type = 'email.delivered'
                            THEN e.resend_email_id END) AS delivered,
        COUNT(DISTINCT CASE WHEN e.event_type = 'email.opened'
                            THEN e.resend_email_id END) AS opened,
        COUNT(DISTINCT CASE WHEN e.event_type IN ('email.bounced', 'email.suppressed')
                            THEN e.resend_email_id END) AS bounced
      FROM organisations o
      LEFT JOIN email_events e
        ON e.resend_email_id = o.resend_email_id
       AND e.event_type IN ('email.delivered','email.opened','email.bounced','email.suppressed')
      WHERE o.email_sent_at IS NOT NULL
        AND o.resend_email_id IS NOT NULL
        AND DATE(o.email_sent_at) >= DATE('now', ?)
        AND DATE(o.email_sent_at) <  DATE('now')
        AND EXISTS (
          SELECT 1 FROM email_events se
          WHERE se.resend_email_id = o.resend_email_id
            AND se.event_type = 'subject.recorded'
            AND json_extract(se.event_data, '$.subject') = ?
        )
      GROUP BY DATE(o.email_sent_at)
      ORDER BY day ASC
    `).all(cutoffModifier, subject);
  }

  return db.prepare(`
    SELECT
      DATE(o.email_sent_at) AS day,
      COUNT(DISTINCT o.resend_email_id) AS sent,
      COUNT(DISTINCT CASE WHEN e.event_type = 'email.delivered'
                          THEN e.resend_email_id END) AS delivered,
      COUNT(DISTINCT CASE WHEN e.event_type = 'email.opened'
                          THEN e.resend_email_id END) AS opened,
      COUNT(DISTINCT CASE WHEN e.event_type IN ('email.bounced', 'email.suppressed')
                          THEN e.resend_email_id END) AS bounced
    FROM organisations o
    LEFT JOIN email_events e
      ON e.resend_email_id = o.resend_email_id
     AND e.event_type IN ('email.delivered','email.opened','email.bounced','email.suppressed')
    WHERE o.email_sent_at IS NOT NULL
      AND o.resend_email_id IS NOT NULL
      AND DATE(o.email_sent_at) >= DATE('now', ?)
      AND DATE(o.email_sent_at) <  DATE('now')
    GROUP BY DATE(o.email_sent_at)
    ORDER BY day ASC
  `).all(cutoffModifier);
}

/**
 * 内部：补齐空日（最近 N 天里没发件的日期也要出现在图上）。
 */
function fillEmptyDays(rows, days) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  const today = new Date();
  for (let i = days; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const r = byDay.get(key) || { day: key, sent: 0, delivered: 0, opened: 0, bounced: 0 };
    const sent = r.sent || 0;
    out.push({
      day: key,
      sent,
      delivered: r.delivered || 0,
      opened: r.opened || 0,
      bounced: r.bounced || 0,
      deliveryRate: sent > 0 ? r.delivered / sent : 0,
      openRate: sent > 0 ? r.opened / sent : 0,
      bounceRate: sent > 0 ? r.bounced / sent : 0,
    });
  }
  return out;
}

/**
 * 渲染折线图为 PNG Buffer。
 * 三条线：送达率 / 打开率 / 退信率（都是 0-100%）。
 * @param {Array} daily — 已经过 fillEmptyDays 处理的数组
 * @param {string} title — 图标题（默认通用文案，按主题出图时带主题名）
 */
async function renderChartPng(daily, title = "最近 7 日 · 邮件漏斗指标 (%)") {
  const width = 900;
  const height = 500;
  const canvas = new ChartJSNodeCanvas({
    width,
    height,
    backgroundColour: "#ffffff",
  });

  const labels = daily.map((d) => d.day.slice(5)); // MM-DD
  const pct = (v) => Math.round(v * 1000) / 10;    // 一位小数

  const config = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "送达率",
          data: daily.map((d) => pct(d.deliveryRate)),
          borderColor: "#2E7D32",
          backgroundColor: "#2E7D3220",
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: 4,
        },
        {
          label: "打开率",
          data: daily.map((d) => pct(d.openRate)),
          borderColor: "#1565C0",
          backgroundColor: "#1565C020",
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: 4,
        },
        {
          label: "退信率",
          data: daily.map((d) => pct(d.bounceRate)),
          borderColor: "#C62828",
          backgroundColor: "#C6282820",
          tension: 0.3,
          borderWidth: 2.5,
          pointRadius: 4,
        },
      ],
    },
    options: {
      plugins: {
        title: {
          display: true,
          text: title,
          font: { size: 18 },
          padding: { top: 12, bottom: 16 },
        },
        legend: { position: "top" },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          ticks: { callback: (v) => v + "%" },
        },
      },
    },
  };

  return canvas.renderToBuffer(config, "image/png");
}

/**
 * 构造随图片一起发送的摘要文案（文本消息，仅做上下文补充）。
 * 图片消息本身在企微里没有标题/说明，所以额外发一条短文本。
 */
function formatSummary(daily, subject = null) {
  const DIV = "━━━━━━━━━━━━━━━━━━━━";
  const agg = daily.reduce(
    (a, d) => {
      a.sent += d.sent;
      a.delivered += d.delivered;
      a.opened += d.opened;
      a.bounced += d.bounced;
      return a;
    },
    { sent: 0, delivered: 0, opened: 0, bounced: 0 }
  );

  const rate = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");
  const range = `${daily[0].day} ~ ${daily[daily.length - 1].day}`;

  const lines = [
    "📊 邮件周报 · 最近 7 日",
    DIV,
  ];
  if (subject) lines.push(`主题：${subject}`);
  lines.push(`区间：${range}`);
  lines.push(`发送 ${agg.sent} → 送达 ${agg.delivered} → 打开 ${agg.opened}`);
  lines.push(``);
  lines.push(`送达率 ${rate(agg.delivered, agg.sent)}% ｜ 打开率 ${rate(agg.opened, agg.sent)}% ｜ 退信率 ${rate(agg.bounced, agg.sent)}%`);
  lines.push(DIV);
  lines.push("📈 每日曲线见下方图表");
  return lines.join("\n");
}

/**
 * 入口：生成并推送本周报告。
 * 按主题切分：本周用过几个主题就推几张图（每张图前先发该主题的摘要文本）。
 * 历史数据中无 subject.recorded 事件的邮件被忽略（避免污染视野）。
 */
async function runWeeklyReport(db, { days = 7 } = {}) {
  if (!runtimeConfig.getEnabledRecipients(db).length) {
    console.log("[weekly-report] 无启用的通知负责人，跳过");
    return { success: false, reason: "no-recipients" };
  }

  const subjects = getActiveSubjects(db, { days });
  if (subjects.length === 0) {
    console.log("[weekly-report] 最近 7 日无已标注主题的发送记录，跳过");
    return { success: false, reason: "no-subject-data" };
  }

  console.log(`[weekly-report] 本周用过 ${subjects.length} 个主题`);
  const { sendToWecom } = require("./wecom-notifier");
  const results = [];

  for (const subject of subjects) {
    const rawRows = getDailyFunnel(db, { days, subject });
    const daily = fillEmptyDays(rawRows, days);
    if (!daily.some((d) => d.sent > 0)) {
      console.log(`[weekly-report] 主题"${subject}"无有效数据，跳过`);
      continue;
    }

    const titleSubject = subject.length > 40 ? subject.slice(0, 40) + "…" : subject;
    const png = await renderChartPng(daily, `${titleSubject} · 最近 7 日 (%)`);

    const tmpPath = path.join(os.tmpdir(), `weekly-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    fs.writeFileSync(tmpPath, png);
    console.log(`[weekly-report] 已生成: ${tmpPath} (${png.length} bytes) — ${subject}`);

    try {
      await sendToWecom(db, formatSummary(daily, subject));
      const imageResult = await sendImageToAllRecipients(db, tmpPath);
      results.push({ subject, success: imageResult.success });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }

  return { success: results.some((r) => r.success), subjects: results };
}

module.exports = {
  runWeeklyReport,
  getDailyFunnel,
  getActiveSubjects,
  fillEmptyDays,
  renderChartPng,
  formatSummary,
};
