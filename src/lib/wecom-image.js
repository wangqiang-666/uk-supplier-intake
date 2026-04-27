/**
 * 企业微信图片消息发送（独立模块，不修改 wecom-notifier.js）
 *
 * 流程：
 *   1) 调用「上传临时素材」接口把 PNG 上传，拿到 media_id（3 天有效）
 *   2) 调用「应用消息」接口以 msgtype=image 发送
 *
 * 复用 wecom-notifier 的 access_token/recipients 配置（通过环境变量与 db）。
 */
const axios = require("axios");
const fs = require("node:fs");
const path = require("node:path");
const FormData = require("form-data");
const runtimeConfig = require("./runtime-config");

const CORP_ID = process.env.WECOM_CORP_ID;
const AGENT_ID = Number(process.env.WECOM_AGENT_ID) || 1000114;
const APP_SECRET = process.env.WECOM_APP_SECRET;

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  if (!CORP_ID || !APP_SECRET) {
    throw new Error("企业微信凭证未配置：WECOM_CORP_ID / WECOM_APP_SECRET");
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${APP_SECRET}`;
  const { data } = await axios.get(url, { timeout: 10000 });
  if (data.errcode !== 0) {
    throw new Error(`获取 access_token 失败: ${data.errcode} ${data.errmsg}`);
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.token;
}

/**
 * 上传临时素材，返回 media_id。type=image
 */
async function uploadImageMedia(filePath) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`;

  const form = new FormData();
  form.append("media", fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: "image/png",
  });

  const { data } = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 30000,
  });

  if (data.errcode && data.errcode !== 0) {
    throw new Error(`上传素材失败: ${data.errcode} ${data.errmsg}`);
  }
  return data.media_id;
}

async function sendImageToUser(userid, mediaId) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
  const payload = {
    touser: userid,
    msgtype: "image",
    agentid: AGENT_ID,
    image: { media_id: mediaId },
  };
  const { data } = await axios.post(url, payload, { timeout: 10000 });
  if (data.errcode === 0) {
    return { success: true, output: `已推送图片给 ${userid}` };
  }
  return {
    success: false,
    output: `errcode=${data.errcode}, errmsg=${data.errmsg}`,
  };
}

/**
 * 上传一次图片，分发给所有启用负责人。
 */
async function sendImageToAllRecipients(db, filePath) {
  const recipients = runtimeConfig.getEnabledRecipients(db);
  if (!recipients.length) return { success: false, reason: "no-recipients" };

  const mediaId = await uploadImageMedia(filePath);
  console.log(`[wecom-image] 素材上传成功 media_id=${mediaId.slice(0, 16)}…`);

  const results = [];
  for (const r of recipients) {
    try {
      const res = await sendImageToUser(r.wecom_userid, mediaId);
      console.log(`[wecom-image] → ${r.name}: ${res.output}`);
      results.push({ userid: r.wecom_userid, name: r.name, ...res });
    } catch (err) {
      console.error(`[wecom-image] 推送异常 → ${r.name}: ${err.message}`);
      results.push({ userid: r.wecom_userid, name: r.name, success: false, error: err.message });
    }
  }
  return { success: results.some((r) => r.success), results };
}

module.exports = { uploadImageMedia, sendImageToUser, sendImageToAllRecipients };
