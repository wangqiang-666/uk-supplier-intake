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
 * 格式化邮件回复为通知消息
 */
function formatReplyNotification(reply, org) {
  const lines = [
    `📧 收到新的邮件回复`,
    ``,
    `发件人: ${reply.from_email}`,
    `主题: ${reply.subject || "(无主题)"}`,
    `时间: ${reply.received_at}`,
  ];

  if (org) {
    lines.push(``);
    lines.push(`✅ 已匹配到供应商:`);
    lines.push(`名称: ${org.name}`);
    if (org.city) lines.push(`城市: ${org.city}`);
    if (org.telephone) lines.push(`电话: ${org.telephone}`);
    if (org.source) lines.push(`来源: ${org.source}`);
  } else {
    lines.push(``);
    lines.push(`⚠️ 未匹配到供应商（发件人不在数据库中）`);
  }

  // 正文预览（最多 300 字符）
  const bodyPreview = (reply.body || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (bodyPreview) {
    lines.push(``);
    lines.push(`正文预览:`);
    lines.push(bodyPreview);
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
  const message = formatReplyNotification(reply, org);
  return sendToWecom(db, message);
}

module.exports = {
  notifyEmailReply,
  sendToWecom,
  sendMessageToUser,
  isNotifyConfigured,
  formatReplyNotification,
};
