/**
 * 企业微信通知模块
 * 通过 docker exec 调用 openclaw-gateway 容器中的 openclaw CLI，
 * 使用 `openclaw message send --channel wecom` 推送消息到企业微信
 *
 * 依赖：uk-supplier-api 容器必须挂载宿主机的 docker.sock，
 * 例如在 docker-compose.yml 中：
 *   volumes:
 *     - /var/run/docker.sock:/var/run/docker.sock
 */
const { execFile } = require("child_process");
const runtimeConfig = require("./runtime-config");

const CONTAINER_NAME = process.env.OPENCLAW_CONTAINER_NAME || "openclaw-gateway";

/**
 * 检查通知是否已配置（数据库中是否有启用的负责人）
 * @param {object} db - 数据库实例
 */
function isNotifyConfigured(db) {
  if (!db) return false;
  return runtimeConfig.getEnabledRecipients(db).length > 0;
}

/**
 * 执行 docker exec 命令（Promise 封装）
 */
function dockerExec(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * 清理邮件正文预览：剥离引用历史（Original Message 之后的内容）、
 * 签名、多余空白，只保留真正的新回复内容
 */
function cleanReplyBody(body) {
  if (!body) return "";
  let text = String(body);

  // 解码 HTML 实体
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');

  // 剥离常见的引用分隔（中英文客户端）
  const markers = [
    /------------------\s*Original\s*------------------/i,
    /-----Original Message-----/i,
    /On .+ wrote:/,
    /在 .+ 写道：/,
    /发自我的(iPhone|华为|小米|Mi|Samsung|手机)/,
    /Sent from my (iPhone|iPad|Android|Samsung)/i,
    /^>.*/m,
  ];
  for (const re of markers) {
    const idx = text.search(re);
    if (idx > 0) text = text.slice(0, idx);
  }

  return text.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 格式化邮件回复为通知消息
 */
function formatReplyNotification(reply, org, recipients) {
  const DIV = "━━━━━━━━━━━━━━━━━━━━";
  const lines = [];

  // 标题区：根据匹配状态用不同 emoji 和标题，一眼识别
  if (org) {
    lines.push(`📬 新回复 · 已匹配供应商`);
  } else {
    lines.push(`⚠️ 新回复 · 未匹配（陌生发件人）`);
  }
  lines.push(DIV);

  // 供应商信息区（匹配成功时展示完整资料，方便判断是否值得回复）
  if (org) {
    lines.push(`🏢 供应商信息`);
    lines.push(`  名称：${org.name || "-"}`);
    if (org.organisation_type) lines.push(`  类型：${org.organisation_type}`);
    const location = [org.city, org.country].filter(Boolean).join(", ");
    if (location) lines.push(`  地区：${location}`);
    if (org.telephone) lines.push(`  电话：${org.telephone}`);
    if (org.website) lines.push(`  网站：${org.website}`);
    if (org.apostille_qualified === 1) lines.push(`  资质：✓ Apostille 认证`);
    if (org.source) lines.push(`  来源：${org.source}`);
    if (org.source_url) lines.push(`  官方页面：${org.source_url}`);
    lines.push(DIV);
  }

  // 邮件信息区
  lines.push(`✉️ 邮件`);
  lines.push(`  发件人：${reply.from_email}`);
  lines.push(`  主题：${reply.subject || "(无主题)"}`);
  lines.push(`  时间：${reply.received_at}`);

  // 正文预览（剥离引用历史和签名，限 200 字符防企业微信截断）
  const cleaned = cleanReplyBody(reply.body);
  if (cleaned) {
    lines.push(DIV);
    lines.push(`💬 回复内容`);
    if (cleaned.length > 200) {
      lines.push(cleaned.slice(0, 200) + "……");
      lines.push(`📎 内容较长，请登录邮箱查看完整回复`);
    } else {
      lines.push(cleaned);
    }
  }

  // 操作提示
  lines.push(DIV);
  if (org) {
    lines.push(`👉 请及时跟进回复`);
  } else {
    lines.push(`👉 建议人工核对发件人身份`);
  }

  // 跟进负责人（让所有人知道通知已同步给谁）
  if (recipients && recipients.length > 0) {
    const names = recipients.map((r) => r.name).join("、");
    lines.push(`👥 跟进负责人：${names}`);
  }

  return lines.join("\n");
}

/**
 * 通过 docker exec 调用 openclaw CLI 发送消息到指定的企业微信用户
 * @param {string} userid - 企业微信 userid
 * @param {string} message - 消息内容
 */
async function sendMessageToUser(userid, message) {
  const args = [
    "exec", CONTAINER_NAME,
    "openclaw", "message", "send",
    "--channel", "wecom",
    "--target", `wecom:${userid}`,
    "--message", message,
  ];

  const { stdout, stderr } = await dockerExec(args);
  const output = (stdout + stderr).trim();
  const ok = output.includes("Sent via gateway") || output.includes("✅");
  return { success: ok, output };
}

/**
 * 发送消息给所有启用的负责人
 * @param {object} db - 数据库实例
 * @param {string} message - 消息内容
 */
async function sendToWecom(db, message) {
  if (!isNotifyConfigured(db)) {
    console.log("[wecom-notifier] 无启用的通知负责人，跳过推送");
    return { success: false, reason: "无启用的通知负责人" };
  }

  const recipients = runtimeConfig.getEnabledRecipients(db);
  const results = [];

  for (const r of recipients) {
    try {
      const result = await sendMessageToUser(r.wecom_userid, message);
      console.log(`[wecom-notifier] 推送 → ${r.name}(${r.wecom_userid}): ${result.output}`);
      results.push({ userid: r.wecom_userid, name: r.name, success: result.success, output: result.output });
    } catch (err) {
      const errMsg = (err.stderr || err.message || "").trim();
      console.error(`[wecom-notifier] 推送异常 → ${r.name}(${r.wecom_userid}): ${errMsg}`);
      results.push({ userid: r.wecom_userid, name: r.name, success: false, error: errMsg });
    }
  }

  return { success: results.some((r) => r.success), results };
}

/**
 * 推送邮件回复通知给所有启用的负责人
 * @param {object} db - 数据库实例
 * @param {object} reply - 回复信息
 * @param {object|null} org - 匹配的供应商（可选）
 */
async function notifyEmailReply(db, reply, org) {
  const recipients = runtimeConfig.getEnabledRecipients(db);
  const message = formatReplyNotification(reply, org, recipients);
  return sendToWecom(db, message);
}

/**
 * 格式化自动发送日报通知
 */
function formatAutoSendReport(stats) {
  const DIV = "━━━━━━━━━━━━━━━━━━━━";
  const elapsed = stats.elapsedMs >= 60000
    ? `${Math.floor(stats.elapsedMs / 60000)} 分 ${Math.floor((stats.elapsedMs % 60000) / 1000)} 秒`
    : `${(stats.elapsedMs / 1000).toFixed(1)} 秒`;
  const rate = stats.sent + stats.failed > 0
    ? Math.round(stats.successRate * 100)
    : 0;

  const lines = [
    `📤 每日邮件发送报告`,
    DIV,
    `📊 发送统计`,
    `  目标：${stats.targetCount} 封`,
    `  成功：${stats.sent} 封 ✓`,
    `  失败：${stats.failed} 封 ✗`,
    `  成功率：${rate}%`,
    `  耗时：${elapsed}`,
  ];

  if (stats.testMode) {
    lines.push(`  模式：🧪 测试模式（邮件发到测试邮箱）`);
  }

  if (stats.remaining) {
    lines.push(DIV);
    lines.push(`📋 剩余待发送`);
    for (const src of stats.remaining.bySource) {
      const label = src.source === "sra_api" ? "SRA"
        : src.source === "lawsociety_scraper" ? "Law Society"
        : src.source === "facultyoffice" ? "Faculty Office"
        : src.source;
      lines.push(`  ${label}：${src.c.toLocaleString()} 封`);
    }
    lines.push(`  合计：${stats.remaining.total.toLocaleString()} 封`);
  }

  lines.push(DIV);
  lines.push(`⏰ 下次发送：下个工作日 9:00 AM (UK)`);

  return lines.join("\n");
}

/**
 * 格式化自动发送异常报警
 */
function formatAutoSendAlert(stats) {
  const rate = Math.round((stats.successRate || 0) * 100);
  const lines = [
    `🚨 邮件发送异常警报`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `成功率仅 ${rate}%，请检查邮件服务状态！`,
  ];

  if (stats.failures && stats.failures.length > 0) {
    lines.push(``);
    lines.push(`失败详情：`);
    for (const f of stats.failures) {
      lines.push(`  - #${f.id} ${f.email}: ${f.error}`);
    }
  }

  return lines.join("\n");
}

module.exports = {
  notifyEmailReply,
  sendToWecom,
  sendMessageToUser,
  isNotifyConfigured,
  formatReplyNotification,
  formatAutoSendReport,
  formatAutoSendAlert,
};
