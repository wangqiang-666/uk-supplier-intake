const { Resend } = require("resend");
const {
  getDb,
  insertEmailEvent,
  getOrganisationByResendId,
  nowLocal,
} = require("../db");
const cfg = require("../config/email-config");
const {
  pushBounceAlert,
  pushComplaintAlert
} = require("./wecom-notifier");

// 状态递进链：拿到某状态时，前面的状态一定已经发生
const PRECURSORS = {
  sent:       [],
  delivered:  ['sent'],
  opened:     ['sent', 'delivered'],
  clicked:    ['sent', 'delivered', 'opened'],
  complained: ['sent', 'delivered'],
  bounced:    [],  // 退信说明没送达，不补 delivered
  suppressed: [],  // 被 Resend 压制，不补 delivered
};

/**
 * 查询单个邮件的状态并保存事件（自动补全前置状态）
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
    const resp = await resend.emails.get(resendEmailId);
    const email = resp.data || resp;   // SDK v6 返回 { data, error }

    if (!email || resp.error) {
      console.warn(`⚠️ 邮件不存在: ${resendEmailId}`, resp.error);
      return { success: false, events: 0 };
    }

    // 查找对应的组织
    const org = getOrganisationByResendId(db, resendEmailId);

    // 根据 last_event 字段判断邮件状态
    const lastEvent = email.last_event;

    if (lastEvent) {
      // 补全前置状态 + 当前状态
      const allEvents = [...(PRECURSORS[lastEvent] || []), lastEvent];

      // 精确跟踪关键事件（退信/压制/投诉）是否为"本次新增"，
      // 只有新增时才推送通知，避免每小时同步时重复推送
      let alertEventAdded = false;

      for (const evt of allEvents) {
        const inserted = insertEmailEvent(db, {
          resend_email_id: resendEmailId,
          organisation_id: org ? org.id : null,
          event_type: `email.${evt}`,
          event_data: JSON.stringify(email),
        });

        if (inserted) {
          eventsAdded++;
          console.log(`✓ 同步事件: email.${evt} - ${org ? org.name : resendEmailId}`);
          if (evt === 'bounced' || evt === 'suppressed' || evt === 'complained') {
            alertEventAdded = true;
          }
        }
      }

      // 只有关键事件本次首次入库时才推送（依赖 UNIQUE(resend_email_id, event_type) 去重）
      if (alertEventAdded && org) {
        if (lastEvent === "bounced" || lastEvent === "suppressed") {
          await pushBounceAlert(db, org, email);
        } else if (lastEvent === "complained") {
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
  // email_sent_at 存储为北京时间，cutoff 也需要用北京时间
  const now = new Date(nowLocal().replace(' ', 'T') + '+08:00');
  now.setDate(now.getDate() - days);
  const cutoff = now.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).replace(/\//g, "-");

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
  syncRecentEmailStatuses,
  PRECURSORS,
};
