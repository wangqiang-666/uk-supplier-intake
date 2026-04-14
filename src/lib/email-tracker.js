const { Resend } = require("resend");
const {
  getDb,
  insertEmailEvent,
  getOrganisationByResendId,
} = require("../db");
const cfg = require("../config/email-config");
const {
  pushBounceAlert,
  pushComplaintAlert
} = require("./wecom-notifier");

/**
 * 查询单个邮件的状态并保存事件
 * @param {string} resendEmailId - Resend Email ID
 * @returns {Promise<{success: boolean, events: number}>}
 */
async function syncEmailStatus(resendEmailId) {
  const db = getDb();
  const apiKey = cfg.resend.apiKey;

  if (!apiKey) {
    console.error("❌ Resend API key 未配置");
    return { success: false, events: 0 };
  }

  const resend = new Resend(apiKey);
  let eventsAdded = 0;

  try {
    // 调用 Resend API 查询邮件详情
    const email = await resend.emails.get(resendEmailId);

    if (!email) {
      console.warn(`⚠️ 邮件不存在: ${resendEmailId}`);
      return { success: false, events: 0 };
    }

    // 查找对应的组织
    const org = getOrganisationByResendId(db, resendEmailId);

    // 根据 last_event 字段判断邮件状态
    // Resend API 返回的 email 对象包含 last_event 字段
    const lastEvent = email.last_event;

    if (lastEvent) {
      const eventType = `email.${lastEvent}`;

      // 尝试插入事件（幂等性由 UNIQUE 约束保证）
      const inserted = insertEmailEvent(db, {
        resend_email_id: resendEmailId,
        organisation_id: org ? org.id : null,
        event_type: eventType,
        event_data: JSON.stringify(email),
      });

      if (inserted) {
        eventsAdded++;
        console.log(`✓ 同步事件: ${eventType} - ${org ? org.name : resendEmailId}`);

        // 退信和投诉推送企业微信通知
        if (lastEvent === "bounced" && org) {
          await pushBounceAlert(db, org, email);
        } else if (lastEvent === "complained" && org) {
          await pushComplaintAlert(db, org, email);
        }
      }
    }

    return { success: true, events: eventsAdded };
  } catch (err) {
    console.error(`❌ 查询邮件状态失败 ${resendEmailId}:`, err.message);
    return { success: false, events: 0 };
  }
}

/**
 * 批量同步最近发送的邮件状态
 * @param {number} days - 查询最近多少天的邮件（默认7天）
 */
async function syncRecentEmailStatuses(days = 7) {
  const db = getDb();

  // 查询最近N天发送的、有 resend_email_id 的邮件
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

  const emails = db.prepare(`
    SELECT DISTINCT resend_email_id
    FROM organisations
    WHERE resend_email_id IS NOT NULL
      AND email_sent_at >= ?
    ORDER BY email_sent_at DESC
  `).all(cutoff);

  console.log(`📊 开始同步最近 ${days} 天的邮件状态，共 ${emails.length} 封邮件`);

  let successCount = 0;
  let totalEvents = 0;

  for (const { resend_email_id } of emails) {
    const result = await syncEmailStatus(resend_email_id);

    if (result.success) {
      successCount++;
      totalEvents += result.events;
    }

    // 避免触发 Resend API 速率限制（每秒最多10个请求）
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  console.log(`✓ 同步完成: ${successCount}/${emails.length} 成功，新增 ${totalEvents} 个事件`);

  return {
    total: emails.length,
    success: successCount,
    eventsAdded: totalEvents
  };
}

module.exports = {
  syncEmailStatus,
  syncRecentEmailStatuses
};
