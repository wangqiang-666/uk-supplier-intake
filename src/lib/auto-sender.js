/**
 * 自动批量发送邮件模块
 *
 * 在英国工作日（周一~周五）9:00 AM（Europe/London，自动处理 BST/GMT）
 * 由 scheduler.js 触发，每日发送可配置数量的邮件，完成后推送日报到企业微信。
 *
 * 特性：
 * - 单封失败自动重试 2 次
 * - 失败不计入配额（保持 email_sent=0，下次仍可发送）
 * - 成功率 < 90% 触发额外报警通知
 * - 防重叠执行（模块级锁）
 * - 复用现有 email-sender / wecom-notifier / runtime-config
 */
const { sendEmail, isSmtpConfigured, getTestRecipients } = require("./email-sender");
const { sendToWecom, formatAutoSendReport, formatAutoSendAlert } = require("./wecom-notifier");
const runtimeConfig = require("./runtime-config");
const cfg = require("../config/email-config");
const {
  getUnsentOrganisations,
  markOrganisationsSent,
  getDailySendCount,
  incrementDailySendCount,
  nowLocal,
} = require("../db");

// 防重叠执行锁（模块级，容器重启自动重置）
let _running = false;

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const ALERT_SUCCESS_RATE = 0.9;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送单封邮件，失败自动重试
 * @returns {Promise<{success, messageId?, error?, attempts}>}
 */
async function sendEmailWithRetry(org) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const result = await sendEmail(org);
    if (result.success) {
      return { ...result, attempts: attempt };
    }
    lastError = result.error;
    if (attempt <= MAX_RETRIES) {
      console.log(`[auto-sender] 第 ${attempt} 次发送失败 (${org.email}): ${lastError}，${RETRY_DELAY_MS}ms 后重试`);
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { success: false, error: lastError, attempts: MAX_RETRIES + 1 };
}

/**
 * 查询各来源剩余待发送数量
 */
function getRemainingBySource(db) {
  const rows = db.prepare(`
    SELECT source, COUNT(*) AS c
    FROM organisations
    WHERE email_sent = 0 AND email IS NOT NULL AND email != ''
    GROUP BY source
    ORDER BY c DESC
  `).all();
  const total = rows.reduce((sum, r) => sum + r.c, 0);
  return { bySource: rows, total };
}

function isAutoSendRunning() {
  return _running;
}

/**
 * 执行一次自动批量发送
 * @param {object} db - 数据库实例
 * @param {object} options - { force: 是否忽略开关（手动触发时使用） }
 */
async function runAutoSend(db, options = {}) {
  const { force = false } = options;
  const startTime = Date.now();
  const startedAt = nowLocal();

  // 防重叠
  if (_running) {
    console.log("[auto-sender] 已有任务在运行，跳过本次");
    return { skipped: true, reason: "already_running" };
  }

  // 检查开关（force 模式跳过）
  if (!force && !runtimeConfig.getAutoSendEnabled(db)) {
    console.log("[auto-sender] 自动发送已关闭，跳过本次");
    return { skipped: true, reason: "disabled" };
  }

  // 检查邮件服务配置
  if (!isSmtpConfigured()) {
    console.error("[auto-sender] 邮件服务未配置，中止");
    return { skipped: true, reason: "smtp_not_configured" };
  }

  _running = true;
  console.log(`[auto-sender] ━━━━━━ 开始自动发送 @ ${startedAt} ━━━━━━`);

  try {
    // 计算可发数
    const configuredCount = runtimeConfig.getAutoSendDailyCount(db);
    const dailyLimit = cfg.email.dailyLimit;
    const alreadySent = getDailySendCount(db);
    const quota = Math.max(0, dailyLimit - alreadySent);
    const targetCount = Math.min(configuredCount, quota);

    console.log(`[auto-sender] 目标: ${configuredCount}, 今日已发: ${alreadySent}, 日限: ${dailyLimit}, 实际可发: ${targetCount}`);

    if (targetCount <= 0) {
      const info = {
        startedAt,
        finishedAt: nowLocal(),
        targetCount: configuredCount,
        sent: 0,
        failed: 0,
        skipped: true,
        reason: "quota_exceeded",
        elapsedMs: Date.now() - startTime,
      };
      runtimeConfig.setAutoSendLastRun(db, info);
      await sendToWecom(db, `⚠️ 自动发送跳过\n原因: 今日配额已用完 (${alreadySent}/${dailyLimit})`);
      return info;
    }

    // 查询待发送
    const unsent = getUnsentOrganisations(db, { limit: targetCount });
    if (unsent.length === 0) {
      const info = {
        startedAt,
        finishedAt: nowLocal(),
        targetCount,
        sent: 0,
        failed: 0,
        skipped: true,
        reason: "no_unsent",
        elapsedMs: Date.now() - startTime,
      };
      runtimeConfig.setAutoSendLastRun(db, info);
      await sendToWecom(db, `ℹ️ 自动发送跳过\n原因: 无待发送的邮件（所有供应商已覆盖）`);
      return info;
    }

    // 逐封发送
    const intervalMs = cfg.email.intervalMs || 2000;
    const results = [];
    let sent = 0;
    let failed = 0;
    const failures = [];

    for (let i = 0; i < unsent.length; i++) {
      const org = unsent[i];
      const result = await sendEmailWithRetry(org);
      results.push({ id: org.id, email: org.email, name: org.name, ...result });

      if (result.success) {
        // 立即标记，避免中途失败丢失状态
        markOrganisationsSent(db, [org.id]);
        incrementDailySendCount(db, 1);
        sent++;
        const testTo = getTestRecipients();
        console.log(
          `[auto-sender] [${i + 1}/${unsent.length}] ✓ ${org.email}${testTo ? ` → ${testTo.join(",")}` : ""} (${org.name})`
        );
      } else {
        failed++;
        failures.push({ id: org.id, email: org.email, name: org.name, error: result.error });
        console.error(`[auto-sender] [${i + 1}/${unsent.length}] ✗ ${org.email}: ${result.error}`);
      }

      // 限速（最后一封不等待）
      if (i < unsent.length - 1) {
        await sleep(intervalMs);
      }
    }

    // 统计
    const elapsedMs = Date.now() - startTime;
    const total = sent + failed;
    const successRate = total > 0 ? sent / total : 0;
    const remaining = getRemainingBySource(db);

    const stats = {
      startedAt,
      finishedAt: nowLocal(),
      targetCount,
      sent,
      failed,
      successRate,
      elapsedMs,
      remaining,
      failures: failures.slice(0, 5), // 最多 5 条失败详情
      testMode: !!getTestRecipients(),
    };

    // 保存 last_run
    runtimeConfig.setAutoSendLastRun(db, stats);

    // 推送日报
    const reportMsg = formatAutoSendReport(stats);
    await sendToWecom(db, reportMsg);
    console.log(`[auto-sender] ━━━━━━ 完成: ${sent}/${total} 成功, 耗时 ${(elapsedMs / 1000).toFixed(1)}s ━━━━━━`);

    // 成功率低 → 额外报警
    if (total > 0 && successRate < ALERT_SUCCESS_RATE) {
      const alertMsg = formatAutoSendAlert(stats);
      await sendToWecom(db, alertMsg);
      console.warn(`[auto-sender] ⚠️ 成功率 ${(successRate * 100).toFixed(1)}% 低于阈值 ${ALERT_SUCCESS_RATE * 100}%，已发送报警`);
    }

    return stats;
  } catch (err) {
    console.error("[auto-sender] 执行异常:", err);
    const errInfo = {
      startedAt,
      finishedAt: nowLocal(),
      error: err.message,
      elapsedMs: Date.now() - startTime,
    };
    runtimeConfig.setAutoSendLastRun(db, errInfo);
    try {
      await sendToWecom(db, `🚨 自动发送异常\n错误: ${err.message}`);
    } catch (notifyErr) {
      console.error("[auto-sender] 推送异常通知失败:", notifyErr.message);
    }
    return errInfo;
  } finally {
    _running = false;
  }
}

module.exports = {
  runAutoSend,
  isAutoSendRunning,
  sendEmailWithRetry,
  getRemainingBySource,
};
