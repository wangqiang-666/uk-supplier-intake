/**
 * 邮件模板渲染模块
 * 支持 {{variable}} 变量替换，纯文本格式
 */
const fs = require("node:fs");
const path = require("node:path");
const cfg = require("../config/email-config");

const DEFAULT_TEMPLATE = `Dear {{salutation}},
My name is Edward, and I represent a global digital platform focused on cross-border notarisation and legalisation services. We are inviting a select number of experienced, qualified notaries to join our international network, and I would very much like to discuss a potential collaboration with you.
Our platform currently receives notarisation and legalisation enquiries from over 100 clients around the world every day. In light of your professional background, we would like to connect these genuine, prescreened matters directly to you – whilst fully respecting your professional independence and your freedom to set your own fees – helping you to:
Steadily increase the volume of high-quality instructions
Attract more international clients
Improve efficiency in handling cross-border matters
By joining our platform, you will benefit from:
Direct access to global clients
Without additional investment of time or budget in marketing, you receive real requests that specifically require notarisation in your jurisdiction.
Sustainable growth in fee income
A stable pipeline of cases from the platform can help you build an additional, longterm and sustainable revenue stream alongside your existing practice.
A straightforward, streamlined workflow
Our team looks after initial client consultations, needs assessment and document preparation. You simply carry out the professional notarisation and execution at the agreed time, significantly reducing your communication burden.
Digital and cross-border support
Leveraging our AIdriven tools and global service network, we support you in efficiently managing cross-border documentation, notarisation/legalisation processes and multilingual communication, enhancing both efficiency and client experience.
If you are looking to:
Increase matter volume and revenue per billable hour
Broaden your international client base and cross-border work
Access more high-quality instructions without adding marketing or administrative overhead
I would be delighted to hear from you. Please reply briefly to this email and let us know:
Your current jurisdiction(s) of practice and notarial qualification
Your preferred time slots for a short call or online meeting (please indicate your time zone)
Upon receiving your reply, our team will contact you as soon as possible to provide:
A detailed overview of the collaboration model
A short demonstration of the workflow and representative case studies
Information on fee settlement and the safeguards we provide
I look forward to the possibility of establishing a longterm, stable and mutually beneficial partnership with you, and working together to deliver highquality notarisation and legalisation services to clients worldwide.
Kind regards,
Edward
Global Digital Platform for Notarisation & Legalisation
Email: [Your Email]
Phone: [Your Phone Number]
WhatsApp: [Your WhatsApp]
Website: [Your Website]`;

const DEFAULT_SUBJECT = "Invitation to Join a Global Notarisation Platform and Expand Your International Practice";

/**
 * 加载模板：优先从 EMAIL_TEMPLATE_PATH 读取文件，否则用内置默认
 */
function loadTemplate() {
  const templatePath = process.env.EMAIL_TEMPLATE_PATH;
  if (templatePath) {
    const full = path.isAbsolute(templatePath)
      ? templatePath
      : path.resolve(process.cwd(), templatePath);
    try {
      return fs.readFileSync(full, "utf-8");
    } catch (err) {
      console.warn(`[email-template] 无法读取模板文件 ${full}，使用默认模板:`, err.message);
    }
  }
  return DEFAULT_TEMPLATE;
}

/**
 * 替换模板中的 {{variable}} 变量
 */
function replaceVars(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const val = vars[key];
    if (val === undefined || val === null || val === "") return "";
    return String(val);
  });
}

/**
 * 从 organisation name 中提取称呼
 * "Mr M Abdulkuddus (Aldgate Notary Services)" → "Mr Abdulkuddus"
 * "Mrs J Abrahams (AB Notaries Ltd)" → "Mrs Abrahams"
 * "3CS CORPORATE SOLICITORS LIMITED" → "Sir/Madam"
 */
function extractSalutation(name) {
  if (!name) return "Sir/Madam";

  const match = name.match(/^(Mr|Mrs|Ms|Miss|Dr)\s+(?:[A-Z]\s+)*([A-Z][a-zA-Z'-]+)/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }

  return "Sir/Madam";
}

/**
 * 渲染邮件模板
 * @param {Object} org - organisation 数据库记录
 * @returns {{ subject: string, body: string }}
 */
function renderTemplate(org) {
  const vars = {
    org_name: org.name || "",
    org_city: org.city || "",
    org_postcode: org.postcode || "",
    org_source: org.source || "",
    salutation: extractSalutation(org.name),
    work_areas: formatWorkAreas(org.work_areas),
    from_name: cfg.email.fromName || "",
    from_email: cfg.email.fromAddress || "",
  };

  const template = loadTemplate();
  const subjectTemplate = cfg.email.subject || DEFAULT_SUBJECT;

  return {
    subject: replaceVars(subjectTemplate, vars),
    body: replaceVars(template, vars),
  };
}

function formatWorkAreas(workAreas) {
  if (!workAreas) return "";
  try {
    const arr = typeof workAreas === "string" ? JSON.parse(workAreas) : workAreas;
    if (Array.isArray(arr) && arr.length > 0) return arr.join(", ");
  } catch (_) {}
  return "";
}

module.exports = { renderTemplate, replaceVars, DEFAULT_TEMPLATE, DEFAULT_SUBJECT };
