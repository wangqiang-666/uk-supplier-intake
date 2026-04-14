/**
 * 企业微信通知模块
 * 通过企业微信「应用消息」API 推送通知给指定成员
 *
 * 需要环境变量：
 *   WECOM_CORP_ID     - 企业 CorpID
 *   WECOM_AGENT_ID    - 应用 AgentId
 *   WECOM_APP_SECRET  - 应用 Secret
 */
const axios = require("axios");
const crypto = require("crypto");
const runtimeConfig = require("./runtime-config");

const CORP_ID = process.env.WECOM_CORP_ID;
const AGENT_ID = Number(process.env.WECOM_AGENT_ID) || 1000114;
const APP_SECRET = process.env.WECOM_APP_SECRET;

// access_token 缓存（有效期 7200 秒，提前 5 分钟刷新）
let tokenCache = { token: null, expiresAt: 0 };

/**
 * 获取 access_token（带缓存）
 */
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  if (!CORP_ID || !APP_SECRET) {
    throw new Error("企业微信凭证未配置：请设置 WECOM_CORP_ID 和 WECOM_APP_SECRET 环境变量");
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${APP_SECRET}`;
  const { data } = await axios.get(url, { timeout: 10000 });

  if (data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: errcode=${data.errcode}, errmsg=${data.errmsg}`);
  }

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
  };

  console.log("[wecom-notifier] access_token 已刷新");
  return tokenCache.token;
}

/**
 * 检查通知是否已配置（数据库中是否有启用的负责人）
 * @param {object} db - 数据库实例
 */
function isNotifyConfigured(db) {
  if (!db) return false;
  return runtimeConfig.getEnabledRecipients(db).length > 0;
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
 * 根据 IMAP 用户邮箱找到对应的回复负责人
 * 规则：邮箱 local part（@前面部分，去空格去点，小写）与 recipient.name 小写后相等
 * 找不到就返回第一个启用的 recipient
 */
function pickReplyHandler(db) {
  const recipients = runtimeConfig.getEnabledRecipients(db);
  if (!recipients.length) return null;

  try {
    const imap = runtimeConfig.getImapConfig(db);
    const localPart = String(imap.user || "").split("@")[0].replace(/[.\s]/g, "").toLowerCase();
    if (localPart) {
      const match = recipients.find((r) => String(r.name || "").replace(/\s/g, "").toLowerCase() === localPart);
      if (match) return match;
    }
  } catch (_) {}

  return recipients[0];
}

/**
 * 格式化邮件回复为通知消息
 */
function formatReplyNotification(reply, org, recipients) {
  const DIV = "━━━━━━━━━━━━━━━━━━━━";
  const lines = [];

  if (org) {
    lines.push(`📬 新回复 · 已匹配供应商`);
  } else {
    lines.push(`⚠️ 新回复 · 未匹配（陌生发件人）`);
  }
  lines.push(DIV);

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

  lines.push(`✉️ 邮件`);
  lines.push(`  发件人：${reply.from_email}`);
  lines.push(`  主题：${reply.subject || "(无主题)"}`);
  lines.push(`  时间：${reply.received_at}`);

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

  lines.push(DIV);
  // recipients 这里传入的是"回复负责人"单个对象或包含一个元素的数组
  const handler = Array.isArray(recipients) ? recipients[0] : recipients;
  const handlerName = handler && handler.name ? handler.name : "负责人";
  if (org) {
    lines.push(`👉 ${handlerName}，请及时回复客户`);
  } else {
    lines.push(`👉 ${handlerName}，请核对发件人身份并回复客户`);
  }

  return lines.join("\n");
}

/**
 * 通过企业微信应用消息 API 发送文本消息到指定用户
 * @param {string} userid - 企业微信 userid
 * @param {string} message - 消息内容
 */
async function sendMessageToUser(userid, message) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

  const payload = {
    touser: userid,
    msgtype: "text",
    agentid: AGENT_ID,
    text: { content: message },
  };

  const { data } = await axios.post(url, payload, { timeout: 10000 });

  if (data.errcode === 0) {
    if (data.invaliduser) {
      console.warn(`[wecom-notifier] ⚠️ ${userid} 在 invaliduser 列表中: ${data.invaliduser}`);
      return { success: false, output: `userid ${userid} 无效（invaliduser: ${data.invaliduser}）` };
    }
    return { success: true, output: `已通过应用消息推送给 ${userid}` };
  }

  // token 过期，刷新后重试一次
  if (data.errcode === 40014 || data.errcode === 42001) {
    console.log("[wecom-notifier] access_token 过期，重新获取…");
    tokenCache = { token: null, expiresAt: 0 };
    const newToken = await getAccessToken();
    const retryUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${newToken}`;
    const retry = await axios.post(retryUrl, payload, { timeout: 10000 });
    if (retry.data.errcode === 0) {
      return { success: true, output: `已通过应用消息推送给 ${userid}（token 已刷新）` };
    }
    return {
      success: false,
      output: `errcode=${retry.data.errcode}, errmsg=${retry.data.errmsg}`,
      error: `推送失败: ${retry.data.errmsg}`,
    };
  }

  return {
    success: false,
    output: `errcode=${data.errcode}, errmsg=${data.errmsg}`,
    error: `推送失败: ${data.errmsg}`,
  };
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
      const errMsg = (err.message || "").trim();
      console.error(`[wecom-notifier] 推送异常 → ${r.name}(${r.wecom_userid}): ${errMsg}`);
      results.push({ userid: r.wecom_userid, name: r.name, success: false, error: errMsg });
    }
  }

  return { success: results.some((r) => r.success), results };
}

/**
 * 推送邮件回复通知给全员，但文案只显示回复负责人的名字
 */
async function notifyEmailReply(db, reply, org) {
  const handler = pickReplyHandler(db);
  const message = formatReplyNotification(reply, org, handler);
  return sendToWecom(db, message);
}

/**
 * 格式化自动发送日报通知
 */
function formatAutoSendReport(db, stats) {
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

  // 邮件追踪漏斗 — 昨日
  const { getEmailTrackingMetrics, getRecentBouncesAndComplaints } = require("../db");
  const yd = getEmailTrackingMetrics(db, { days: 1 });
  if (yd.totalSent > 0) {
    lines.push(DIV);
    lines.push(`📈 昨日邮件漏斗`);
    lines.push(`  发送 ${yd.totalSent} → 送达 ${yd.delivered} → 打开 ${yd.opened}`);
    lines.push(``);
    lines.push(`  送达率 ${(yd.deliveryRate * 100).toFixed(0)}% ｜ 打开率 ${(yd.openRate * 100).toFixed(0)}%`);
    if (yd.bounced > 0 || yd.complained > 0) {
      const parts = [];
      if (yd.bounced > 0) parts.push(`退信 ${yd.bounced}`);
      if (yd.complained > 0) parts.push(`投诉 ${yd.complained}`);
      lines.push(`  ⚠️ ${parts.join(' ｜ ')}`);
    }
  }

  // 邮件追踪漏斗 — 最近7日
  const wk = getEmailTrackingMetrics(db, { days: 7 });
  if (wk.totalSent > 0) {
    lines.push(DIV);
    lines.push(`📊 最近7日漏斗`);
    lines.push(`  发送 ${wk.totalSent} → 送达 ${wk.delivered} → 打开 ${wk.opened}`);
    lines.push(``);
    lines.push(`  送达率 ${(wk.deliveryRate * 100).toFixed(0)}% ｜ 打开率 ${(wk.openRate * 100).toFixed(0)}%`);
    if (wk.bounced > 0 || wk.complained > 0) {
      const parts = [];
      if (wk.bounced > 0) parts.push(`退信 ${wk.bounced} (${(wk.bounceRate * 100).toFixed(1)}%)`);
      if (wk.complained > 0) parts.push(`投诉 ${wk.complained} (${(wk.complaintRate * 100).toFixed(1)}%)`);
      lines.push(`  ⚠️ ${parts.join(' ｜ ')}`);
    }
  }

  // 问题邮件详情
  const problemEmails = getRecentBouncesAndComplaints(db, 5);
  if (problemEmails.length > 0) {
    lines.push(DIV);
    lines.push(`⚠️ 问题邮件（${problemEmails.length}）`);
    problemEmails.forEach((e, idx) => {
      const label = e.event_type === 'email.bounced' ? '退信' : '投诉';
      const time = new Date(e.created_at).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      lines.push(`  ${idx + 1}. ${label} — ${e.org_name || '未知'} (${e.org_email || '无'}) ${time}`);
    });
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

// ──────────────────────────────────────────────
// 企业微信应用消息回调处理（接收用户消息 + 回复）
// ──────────────────────────────────────────────

const CALLBACK_TOKEN = process.env.WECOM_TOKEN || "";
const CALLBACK_ENCODING_KEY = process.env.WECOM_ENCODING_KEY || "";

/**
 * 验证企业微信回调签名
 */
function verifyCallbackSignature(signature, timestamp, nonce, encrypt) {
  const arr = [CALLBACK_TOKEN, timestamp, nonce, encrypt].sort();
  const sha1 = crypto.createHash("sha1").update(arr.join("")).digest("hex");
  return sha1 === signature;
}

/**
 * 解密企业微信回调消息
 */
function decryptCallbackMessage(encrypt) {
  if (!CALLBACK_ENCODING_KEY) {
    throw new Error("WECOM_ENCODING_KEY 未配置");
  }

  const key = Buffer.from(CALLBACK_ENCODING_KEY + "=", "base64");
  const iv = key.slice(0, 16);

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);

  let decrypted = Buffer.concat([decipher.update(encrypt, "base64"), decipher.final()]);

  // 去除 PKCS#7 填充
  const pad = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - pad);

  // 格式：16字节随机数 + 4字节消息长度(大端) + 消息内容 + corpId
  const content = decrypted.slice(16);
  const msgLen = content.readUInt32BE(0);
  const msg = content.slice(4, 4 + msgLen).toString("utf8");

  return msg;
}

/**
 * 处理企业微信 URL 验证请求 (GET)
 */
function handleCallbackVerify(req, res) {
  const { msg_signature, timestamp, nonce, echostr } = req.query;

  console.log("[wecom-callback] 收到 URL 验证请求");

  if (!verifyCallbackSignature(msg_signature, timestamp, nonce, echostr)) {
    console.log("[wecom-callback] ❌ 签名验证失败");
    return res.status(403).send("signature verification failed");
  }

  console.log("[wecom-callback] ✅ 签名验证通过");

  try {
    const echoStr = decryptCallbackMessage(echostr);
    console.log("[wecom-callback] ✅ 解密成功，返回 echostr");
    res.send(echoStr);
  } catch (err) {
    console.error("[wecom-callback] ❌ 解密失败:", err.message);
    res.status(500).send("decrypt error");
  }
}

/**
 * 处理企业微信消息推送 (POST)
 * @param {Function} onMessage - 收到用户消息时的回调: (userid, content, msgType) => Promise<string|null>
 */
function handleCallbackMessage(onMessage) {
  return async (req, res) => {
    const { msg_signature, timestamp, nonce } = req.query;
    const body = req.body;

    console.log("[wecom-callback] 收到消息推送");

    try {
      // 解析 Encrypt 字段
      const encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/);
      if (!encryptMatch) {
        console.error("[wecom-callback] ❌ 无法解析 Encrypt 字段");
        return res.send("success");
      }

      const encrypt = encryptMatch[1];

      // 验证签名
      if (!verifyCallbackSignature(msg_signature, timestamp, nonce, encrypt)) {
        console.error("[wecom-callback] ❌ 签名验证失败");
        return res.status(403).send("signature verification failed");
      }

      // 解密消息
      const msg = decryptCallbackMessage(encrypt);
      console.log("[wecom-callback] ✅ 消息解密成功");

      // 解析 XML
      const useridMatch = msg.match(/<FromUserName><!\[CDATA\[(.*?)\]\]><\/FromUserName>/);
      const contentMatch = msg.match(/<Content><!\[CDATA\[(.*?)\]\]><\/Content>/);
      const msgTypeMatch = msg.match(/<MsgType><!\[CDATA\[(.*?)\]\]><\/MsgType>/);

      if (useridMatch && msgTypeMatch) {
        const userid = useridMatch[1];
        const content = contentMatch ? contentMatch[1] : "";
        const msgType = msgTypeMatch[1];

        console.log(`[wecom-callback] 📨 用户: ${userid}, 类型: ${msgType}, 内容: ${content}`);

        if (msgType === "text" && onMessage) {
          // 调用业务逻辑处理，获取回复
          const reply = await onMessage(userid, content, msgType);
          if (reply) {
            await sendMessageToUser(userid, reply);
          }
        }
      }

      res.send("success");
    } catch (err) {
      console.error("[wecom-callback] ❌ 处理错误:", err.message);
      res.send("success"); // 即使出错也返回 success，避免企业微信重试
    }
  };
}

/**
 * 检查回调配置是否完整
 */
function isCallbackConfigured() {
  return !!(CALLBACK_TOKEN && CALLBACK_ENCODING_KEY);
}

/**
 * 推送邮件退信提醒
 */
async function pushBounceAlert(db, org, bounceData) {
  const reason = bounceData.bounce?.type || "未知原因";
  const message = `
📧 邮件退信提醒
━━━━━━━━━━━━━━━━
供应商: ${org.name}
邮箱: ${org.email}
退信原因: ${reason}
时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
━━━━━━━━━━━━━━━━
建议: 检查邮箱地址是否有效
  `.trim();

  await sendToWecom(db, message);
}

/**
 * 推送垃圾邮件投诉提醒
 */
async function pushComplaintAlert(db, org, complaintData) {
  const message = `
⚠️ 垃圾邮件投诉
━━━━━━━━━━━━━━━━
供应商: ${org.name}
邮箱: ${org.email}
时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
━━━━━━━━━━━━━━━━
建议: 暂停向该邮箱发送邮件
  `.trim();

  await sendToWecom(db, message);
}

module.exports = {
  notifyEmailReply,
  sendToWecom,
  sendMessageToUser,
  isNotifyConfigured,
  formatReplyNotification,
  formatAutoSendReport,
  formatAutoSendAlert,
  pushBounceAlert,
  pushComplaintAlert,
  // 回调相关
  handleCallbackVerify,
  handleCallbackMessage,
  isCallbackConfigured,
};
