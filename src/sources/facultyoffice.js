const axios = require("axios");
const cheerio = require("cheerio");
const { normalizeEmail, normalizePhone, normalizePostcode } = require("../lib/validators");

const NOTARYPRO_BASE = "https://notarypro.facultyoffice.org.uk";
const FIND_NOTARY_URL = `${NOTARYPRO_BASE}/find-a-notary`;

function norm(s) {
  return String(s || "").trim();
}

/**
 * 从 HTML 提取单个公证人行数据
 */
function parseRow(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const name = norm($(".views-field-field-profile-last-name .field-content").text());
  const company = norm($(".views-field-field-profile-company .field-content").text());

  const address1 = norm($(".views-field-field-profile-company-address-1 .field-content").text());
  const address2 = norm($(".views-field-field-profile-company-address-2 .field-content").text());
  const city = norm($(".views-field-field-profile-company-city .field-content").text());
  const postcode = norm($(".views-field-field-profile-company-postcode .field-content").text());

  const phoneLabel = $(".views-field-field-profile-business-phone .views-label").text().trim();
  const phoneRaw = $(".views-field-field-profile-business-phone .field-content").text().trim();
  const telephone = phoneLabel ? phoneRaw.replace(phoneLabel, "").trim() : phoneRaw;

  const emailRaw = $(".views-field-field-profile-company-email .field-content a").attr("href") || "";
  const email = emailRaw.replace(/^mailto:/i, "").trim();

  const websiteRaw = $(".views-field-field-profile-company-website .field-content a").attr("href") || "";
  const website = norm($(".views-field-field-profile-company-website .field-content a").text());

  const languages = norm(
    $(".views-field-field-profile-languages .field-content").text().replace(/^Languages:\s*/i, "")
  );

  const photoRaw = $(".views-field-field-profile-public-photo .field-content img").attr("src") || "";

  const amlNotice = norm(
    $(".views-field-field-aml-supervision .field-content").text()
  );

  const dx = norm(
    $(".views-field-field-profile-dx .field-content").text().replace(/^DX\s*/i, "")
  );

  return {
    name,
    company,
    address1,
    address2,
    city,
    postcode,
    telephone,
    email,
    website,
    website_url: websiteRaw,
    languages,
    photo_url: photoRaw,
    aml_supervision: amlNotice,
    dx,
  };
}

/**
 * 从搜索结果页 HTML 中提取所有公证人行
 */
function parsePageRows(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const rows = [];

  $(".view-content .views-row").each((_, el) => {
    const rowHtml = $(el).html() || "";
    const row = parseRow(rowHtml);
    if (row.name) {
      rows.push(row);
    }
  });

  return rows;
}

/**
 * 获取总页数
 */
async function getTotalPages(http) {
  const res = await http.get(FIND_NOTARY_URL, {
    params: { "distance[origin]": "", language: "All", submit: "Submit", page: 1000 },
  });
  const html = res.data;
  const match = html.match(/page=(\d+)\"[^>]*>(\d+)<\/a>.*?pager-current[^>]*>(\d+)</);
  if (match) {
    return parseInt(match[3], 10);
  }
  const pageNumbers = [...html.matchAll(/<li class=\"pager-item\"[^>]*>.*?page=(\d+)[^>]*>/gi)];
  if (pageNumbers.length > 0) {
    const max = Math.max(...pageNumbers.map((m) => parseInt(m[1], 10)));
    return max + 1;
  }
  return 1;
}

/**
 * 爬取 Faculty Office 公证人数据
 * @param {Object} options
 * @param {number} options.maxPages - 最大爬取页数（0=全部）
 * @param {number} options.maxOrgs - 最大公证人数量（0=全部）
 * @param {number} options.delayMs - 请求间隔（毫秒）
 * @param {boolean} options.headless - 是否使用无头模式（预留）
 */
async function fetchAllNotaries(options = {}) {
  const { maxPages = 0, maxOrgs = 0, delayMs = 1500 } = options;

  console.log("[FacultyOffice] 启动公证人数据爬虫...");
  console.log(`[FacultyOffice] maxPages=${maxPages || "全部"}, maxOrgs=${maxOrgs || "全部"}, delay=${delayMs}ms`);

  const http = axios.create({
    baseURL: NOTARYPRO_BASE,
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-GB,en;q=0.9",
    },
  });

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  let totalPages;
  if (maxPages > 0) {
    totalPages = maxPages;
  } else {
    console.log("[FacultyOffice] 检测总页数...");
    totalPages = await getTotalPages(http);
    console.log(`[FacultyOffice] 共 ${totalPages} 页`);
  }

  const allNotaries = [];

  for (let page = 0; page < totalPages; page++) {
    process.stdout.write(`[FacultyOffice] 爬取第 ${page + 1}/${totalPages} 页... `);

    try {
      const params = new URLSearchParams({
        "distance[origin]": "",
        language: "All",
        submit: "Submit",
        page: page,
      });

      const res = await http.get(`/find-a-notary?${params.toString()}`);
      const rows = parsePageRows(res.data);

      console.log(`找到 ${rows.length} 条记录`);
      allNotaries.push(...rows);

      if (maxOrgs > 0 && allNotaries.length >= maxOrgs) {
        console.log(`[FacultyOffice] 已达到最大数量 ${maxOrgs}，停止`);
        break;
      }

      if (page < totalPages - 1) {
        await delay(delayMs);
      }
    } catch (err) {
      console.error(`错误: ${err.message}`);
      await delay(3000);
    }
  }

  console.log(`[FacultyOffice] 爬取完成，共 ${allNotaries.length} 条公证人记录`);
  return allNotaries.slice(0, maxOrgs > 0 ? maxOrgs : undefined);
}

function mapOrganisationRow(o) {
  const name = o.name || "无";
  const company = o.company || "";
  const rawEmail = (o.email || "").trim().toLowerCase();

  // 使用 email 作为主键（最稳定），回退到 name+postcode
  const externalId = rawEmail
    ? `fo_${rawEmail}`
    : `fo_${(name).trim().toLowerCase().replace(/\s+/g, "_")}|${(o.postcode || "").replace(/\s+/g, "")}`;

  // Faculty Office 官方注册目录中的公证人均为执业状态
  const authorisationStatus = "Practising";

  // 将 languages、AML 等信息映射到 work_areas
  const workAreas = ["Notarial Services"];
  if (o.languages) {
    const langs = o.languages.split(/[,;]/).map((l) => l.trim()).filter(Boolean);
    for (const lang of langs) {
      workAreas.push(`Language: ${lang}`);
    }
  }
  if (o.aml_supervision) {
    workAreas.push("AML Supervised");
  }

  // 将 AML 和 DX 信息映射到 office_type
  const officeInfo = [
    o.aml_supervision ? `AML: ${o.aml_supervision.trim()}` : "",
    o.dx ? `DX: ${o.dx.trim()}` : "",
  ].filter(Boolean).join("; ");

  // 标准化联系方式
  const email = o.email ? normalizeEmail(o.email) : "";
  const telephone = o.telephone ? normalizePhone(o.telephone) : "";
  const postcode = o.postcode ? normalizePostcode(o.postcode) : "";

  return {
    source: "facultyoffice",
    external_id: externalId,
    name: company && company !== name ? `${name} (${company})` : name,
    authorisation_status: authorisationStatus,
    organisation_type: "Notary",

    address_line1: o.address1 || "",
    address_line2: o.address2 || "",
    address_line3: "",
    city: o.city || "",
    county: "",
    postcode,
    country: "United Kingdom",
    telephone,
    email,
    website: o.website_url || o.website || "",
    office_type: officeInfo,

    work_areas: workAreas,

    apostille_qualified: 1, // Faculty Office 注册公证人具备海牙认证资质

    source_url: FIND_NOTARY_URL,
    raw_json: o,
  };
}

module.exports = {
  fetchAllNotaries,
  parsePageRows,
  mapOrganisationRow,
  NOTARYPRO_BASE,
  FIND_NOTARY_URL,
};
