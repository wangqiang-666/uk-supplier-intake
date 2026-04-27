const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const { normalizeEmail, normalizePhone, normalizePostcode } = require("../lib/validators");

puppeteer.use(StealthPlugin());

const BASE_URL = "https://solicitors.lawsociety.org.uk";
const SEARCH_URL = `${BASE_URL}/search/results`;
const STATE_FILE = path.join(__dirname, "../../data/lawsociety-state.json");

// Law Society 2026-04 起对每个搜索 query 限制最多 5 页（~100 条）
// 解决方案：把 query 切成 (area × city) 组合，每个组合是独立 query，各拿 5 页
// 实测 city 维度有效（Location=Manchester + AreaOfPractice1=IMM → 152 条独立结果集）
// 单组合命中率 30-60% 新数据，全队列轮一圈预计净增 1000-2000 条
const AREA_CODES = [
  "IMM", // Immigration - general
  "IMG", // Immigration - general - legal aid
  "IMN", // Immigration - nationality and citizenship
  "PCP", // Private client - Probate
  "PCW", // Private client - Wills
  "PCT", // Private client - trusts
  "PCI", // Private client - international
  "PRP", // Private client - disputed probate
  "PRT", // Private client - disputed trusts
  "PRW", // Private client - disputed wills
];

// UK 主要城市（按律所密度排序），Location 参数留空表示全国
// 全国 query 放第一位，能拿到 SRA 没覆盖的全国级头部律所
const CITIES = [
  "",            // 全国（不带 Location 参数）
  "London",
  "Manchester",
  "Birmingham",
  "Liverpool",
  "Leeds",
  "Glasgow",
  "Edinburgh",
  "Bristol",
  "Sheffield",
  "Newcastle",
  "Cardiff",
  "Belfast",
  "Nottingham",
  "Leicester",
  "Coventry",
  "Oxford",
  "Cambridge",
  "Brighton",
  "Reading",
  "Southampton",
];

// 生成 (area, city) 组合队列：area 外层、city 内层
// 这样同一 area 连续抓不同城市，减少同一区域内重复
const COMBINATIONS = [];
for (const area of AREA_CODES) {
  for (const city of CITIES) {
    COMBINATIONS.push({ area, city });
  }
}

/**
 * 每日爬取版本：支持代理 IP + 智能分页
 *
 * 策略：
 * 1. 每天爬取不同的页段，避免重复
 * 2. 支持代理 IP 轮换
 * 3. 记录爬取进度
 */

// 读取爬取状态
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    }
  } catch (e) {
    console.log(`[State] 无法读取状态文件，使用默认值`);
  }
  return {
    lastPageStart: 1,
    totalPages: 1000, // 假设总共 1000 页
    lastRunDate: null,
  };
}

// 保存爬取状态
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[State] 状态已保存: 下次从第 ${state.lastPageStart} 页开始`);
  } catch (e) {
    console.error(`[State] 保存状态失败:`, e.message);
  }
}

// 计算今天应该爬取的组合 (area × city) + 页段
// 策略：每个组合爬 5 页后切到下一个组合，轮完所有组合再重头来（全队列 ~210 个组合）
function calculatePageRange(pagesPerDay = 5) {
  const state = loadState();
  const today = new Date().toISOString().split("T")[0];

  // 兼容旧 state：
  //   - comboIndex 新字段：直接用
  //   - 没有 comboIndex 但有 areaIndex：从老 areaIndex 映射到新队列的 area 起点
  //   - 都没有：从 0 开始
  let comboIndex;
  if (typeof state.comboIndex === "number") {
    comboIndex = state.comboIndex % COMBINATIONS.length;
  } else if (typeof state.areaIndex === "number") {
    // 老 state 迁移：areaIndex*N_CITIES 就是该 area 第一个 city 的组合位置
    comboIndex = (state.areaIndex * CITIES.length) % COMBINATIONS.length;
  } else {
    comboIndex = 0;
  }

  let startPage = state.lastPageStart || 1;

  // 老数据可能记录到 lastPageStart>5，Law Society 硬限制重置
  if (startPage > 5) {
    startPage = 1;
    comboIndex = (comboIndex + 1) % COMBINATIONS.length;
  }

  const { area, city } = COMBINATIONS[comboIndex];
  const maxPage = 5; // Law Society 硬上限
  const endPage = Math.min(startPage + pagesPerDay - 1, maxPage);

  const cityLabel = city || "全国";
  console.log(`[Strategy] 今天爬取 ${area} × ${cityLabel} (组合 ${comboIndex + 1}/${COMBINATIONS.length}): 第 ${startPage}-${endPage} 页`);

  return { startPage, endPage, state, today, area, city, comboIndex };
}

/**
 * 每日爬取函数
 */
async function searchSolicitorsDaily(options = {}) {
  const {
    workAreas = [],
    pagesPerDay = 5, // 每天爬 5 页
    maxOrgs = 0,
    headless = false,
    proxyServer = null, // 代理服务器地址，例如: "http://proxy.example.com:8080"
  } = options;

  console.log(`[Daily] 启动每日爬取...`);

  // 计算今天要爬的组合 + 页段
  const { startPage, endPage, state, today, area, city, comboIndex } = calculatePageRange(pagesPerDay);

  // 构造 query string：必带 AreaOfPractice1，可选 Location
  const buildUrl = (pageNum) => {
    const params = [`AreaOfPractice1=${area}`];
    if (city) params.push(`Location=${encodeURIComponent(city)}`);
    params.push(`Page=${pageNum}`);
    return `${SEARCH_URL}?${params.join("&")}`;
  };

  // 配置浏览器参数
  // userDataDir: 持久化 Chrome profile（cookie/cache/fingerprint/fastoken）
  // 让 reCAPTCHA Enterprise 在后续运行累积信任分，避免每次从 0 开始验证
  const userDataDir = path.join(__dirname, "../../data/chrome-profile");
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    console.log(`[Daily] 初始化 Chrome profile 目录: ${userDataDir}`);
  }
  const launchOptions = {
    headless,
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  // 如果有代理，添加代理参数
  if (proxyServer) {
    launchOptions.args.push(`--proxy-server=${proxyServer}`);
    console.log(`[Daily] 使用代理: ${proxyServer}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const results = [];

  try {
    // URL 必须带 AreaOfPractice1 参数；Location 可选，用来绕过 5 页硬限制
    const startUrl = buildUrl(startPage);

    console.log(`[Daily] 访问起始页: 第 ${startPage} 页`);
    // =====================================================================
    // 关键修复 (2026-04-11):
    // Law Society 使用 Google reCAPTCHA Enterprise 做浏览器验证，流程为：
    //   1. 页面返回 503 + reCAPTCHA JS
    //   2. JS 自动执行 grecaptcha.enterprise.execute() 获取 token
    //   3. JS 自动 POST token 到同一 URL
    //   4. 服务器验证 token 分数，通过则返回 302 + fastoken cookie
    //   5. 浏览器跟随 302 重定向，加载真正的搜索结果页
    //
    // 之前用 waitUntil: "networkidle2" + timeout: 30000 会在步骤 1-2 就超时，
    // 导致验证流程被中断。
    //
    // 解决方案：不设 waitUntil（让页面自由完成整个验证+重定向流程），
    // 然后轮询检查结果是否出现。整个过程通常需要 10-50 秒。
    // =====================================================================
    page.goto(startUrl, { timeout: 0 }).catch(() => {});

    console.log(`[Daily] 等待 reCAPTCHA Enterprise 验证（最多 120 秒）...`);

    // 轮询等待验证通过：检查搜索结果 DOM 元素是否出现
    const maxWait = 120000;
    const pollInterval = 5000;
    let waited = 0;
    let found = false;
    while (waited < maxWait) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      waited += pollInterval;
      const count = await page.evaluate(() =>
        document.querySelectorAll("section.solicitor-outer").length
      ).catch(() => 0);
      if (count > 0) {
        found = true;
        console.log(`[Daily] ✓ 验证通过！(${waited / 1000}s, ${count} 条结果)`);
        break;
      }
    }

    if (!found) {
      throw new Error("验证超时，请重试");
    }

    await new Promise(resolve => setTimeout(resolve, 3000));

    // 爬取指定页段
    for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
      console.log(`[Daily] 正在爬取第 ${pageNum} 页...`);

      const pageData = await extractSolicitorsFromPage(page);
      console.log(`[Daily] 第 ${pageNum} 页找到 ${pageData.length} 条记录`);

      results.push(...pageData);

      if (maxOrgs > 0 && results.length >= maxOrgs) {
        console.log(`[Daily] 已达到最大数量 ${maxOrgs}`);
        break;
      }

      // 如果不是最后一页，翻页
      if (pageNum < endPage) {
        const nextUrl = buildUrl(pageNum + 1);
        console.log(`[Daily] 跳转到第 ${pageNum + 1} 页...`);
        // 翻页同样不设 waitUntil，因为后续页也可能触发 reCAPTCHA 验证
        page.goto(nextUrl, { timeout: 0 }).catch(() => {});
        // 轮询等待下一页结果加载
        let nextFound = false;
        for (let w = 0; w < 60000; w += 5000) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          const c = await page.evaluate(() =>
            document.querySelectorAll("section.solicitor-outer").length
          ).catch(() => 0);
          if (c > 0) { nextFound = true; break; }
        }
        if (!nextFound) {
          console.log(`[Daily] 第 ${pageNum + 1} 页加载超时，停止翻页`);
          break;
        }
      }
    }

    // 更新状态：翻完 5 页就切到下一个组合 (area × city)
    let nextStart = endPage + 1;
    let nextComboIndex = comboIndex;
    if (nextStart > 5) {
      nextStart = 1;
      nextComboIndex = (comboIndex + 1) % COMBINATIONS.length;
      const nextCombo = COMBINATIONS[nextComboIndex];
      const cityLabel = city || "全国";
      const nextCityLabel = nextCombo.city || "全国";
      console.log(`[Daily] ${area} × ${cityLabel} 已抓完 5 页，下次切到 ${nextCombo.area} × ${nextCityLabel}`);
    }
    state.lastPageStart = nextStart;
    state.comboIndex = nextComboIndex;
    // 清掉旧字段防混淆
    delete state.areaIndex;
    state.lastRunDate = today;
    saveState(state);

  } catch (error) {
    console.error(`[Daily] 爬取出错:`, error.message);
  } finally {
    await browser.close();
  }

  console.log(`[Daily] 爬取完成，共 ${results.length} 条记录`);
  console.log(`[Daily] 下次将从第 ${state.lastPageStart} 页开始`);

  return results;
}

// 提取页面数据
// 提取页面数据（先展开所有专业领域）
async function extractSolicitorsFromPage(page) {
  // 先点击所有 "View areas of law" 链接展开专业领域
  await page.evaluate(() => {
    const viewLinks = document.querySelectorAll('a[href*="#"], a.toggle, .info-panel a');
    viewLinks.forEach(link => {
      const text = link.textContent?.trim().toLowerCase() || '';
      if (text.includes('view') || text.includes('areas') || text.includes('show')) {
        try {
          link.click();
        } catch (e) {
          // 忽略点击失败
        }
      }
    });
  });

  // 等待展开动画完成
  await new Promise(resolve => setTimeout(resolve, 1000));

  return await page.evaluate(() => {
    const results = [];
    const items = document.querySelectorAll("section.solicitor-outer");

    items.forEach((item) => {
      try {
        const id = item.id || "";
        const name = item.querySelector("h2 a.token")?.textContent?.trim() || "";

        const details = item.querySelectorAll("ul.details li");
        let address = "";
        let website = "";
        let phone = "";
        let email = "";

        details.forEach((li) => {
          const label = li.querySelector("span")?.textContent?.trim() || "";
          const textContent = li.textContent.replace(label, "").trim();

          if (label.includes("Address") || label.includes("office")) {
            address = textContent;
          } else if (label.includes("Website")) {
            website = li.querySelector("a")?.href || textContent;
          } else if (label.includes("Phone") || label.includes("Tel")) {
            phone = textContent;
          } else if (label.includes("Email")) {
            const emailLink = li.querySelector("a[data-email]");
            email = emailLink?.getAttribute("data-email") || li.querySelector("a")?.textContent?.trim() || textContent;
          }
        });

        const workAreas = [];
        // 展开后，专业领域可能出现在多个位置
        const areaSelectors = [
          ".info-panel .areas a",
          ".info-panel .work-areas a",
          ".work-areas a",
          ".practice-areas a",
          "ul.areas li a",
          ".categories a",
          ".info-panel .body a",
          // 展开后的内容区域
          ".panel-body a",
          ".collapse a",
          ".expanded a",
          "ul.list a",
          "a[href*='AreaOfLaw']",
          "a[href*='areaoflaw']",
          "a[href*='area-of-law']",
        ];
        const seen = new Set();
        for (const sel of areaSelectors) {
          const links = item.querySelectorAll(sel);
          links.forEach(a => {
            const area = a.textContent?.trim();
            if (area
              && !seen.has(area)
              && !area.includes("View") && !area.includes("Hide")
              && !area.includes("Show") && !area.includes("Close")
              && !/^\d+\s+(office|solicitor|partner)/i.test(area)
              && area.length > 2
              && area.length < 80) {
              seen.add(area);
              workAreas.push(area);
            }
          });
        }

        if (name) {
          results.push({
            id, name, address, phone, email, website,
            work_areas: workAreas,
          });
        }
      } catch (e) {
        // 忽略
      }
    });

    return results;
  });
}

function mapOrganisationRow(org) {
  const { parseUkAddress } = require("../lib/validate");

  // 解析地址
  const parsed = parseUkAddress(org.address || "");

  // 生成稳定的 external_id
  let externalId;
  if (org.id) {
    externalId = `lawsoc_${org.id}`;
  } else {
    // 回退：使用名称的确定性hash
    const nameHash = (org.name || "").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    externalId = `lawsoc_name_${nameHash}`;
    console.warn(`[Law Society] 缺少 org.id，使用名称作为 external_id: ${externalId}`);
  }

  // 生成具体的 source_url
  const sourceUrl = org.id
    ? `${BASE_URL}/office/${org.id}/${encodeURIComponent((org.name || "").toLowerCase().replace(/\s+/g, "-"))}`
    : BASE_URL;

  // 标准化联系方式
  const email = org.email ? normalizeEmail(org.email) : "";
  const telephone = org.phone ? normalizePhone(org.phone) : "";
  const postcode = parsed.postcode ? normalizePostcode(parsed.postcode) : "";

  return {
    source: "lawsociety_scraper",
    external_id: externalId,
    name: org.name || "无",
    authorisation_status: "Authorised",  // Law Society 目录仅列出已授权事务所
    organisation_type: "Law Society Member",
    work_areas: org.work_areas || [],

    address_line1: parsed.address_line1,
    address_line2: parsed.address_line2,
    address_line3: parsed.address_line3,
    city: parsed.city,
    county: parsed.county,
    postcode,
    country: parsed.country || "United Kingdom",
    telephone,
    email,
    website: org.website || "",
    office_type: "",

    source_url: sourceUrl,
    raw_json: org,
  };
}

module.exports = {
  searchSolicitorsDaily,
  mapOrganisationRow,
  loadState,
  saveState,
};
