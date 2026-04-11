require("dotenv").config();

const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { getDb, closeDb, insertRun, finishRun, upsertOrganisation } = require("./db");
const { fetchAllOrganisations, filterOrganisations, mapOrganisationRow } = require("./sources/sra");
const lawSociety = require("./sources/lawsociety-daily");
const facultyOffice = require("./sources/facultyoffice");
const { getWorkingProxy } = require("./lib/proxy");
const { validateRecord, generateRunReport } = require("./lib/validate");

function nowRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}_${randomUUID().slice(0, 8)}`;
}

function parseListEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

async function ingestSraOrganisations() {
  const runId = nowRunId();
  const outDir = path.resolve("output", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const workAreas = parseListEnv("WORK_AREAS", ["Immigration", "Private client"]);
  const maxOrgs = Number(process.env.MAX_ORGS || "0") || 0;

  const cfgSnapshot = {
    source: "sra_api",
    workAreas,
    maxOrgs,
    apiUrl: process.env.SRA_API_URL || null,
  };

  console.log("[ingest] run_id:", runId);
  console.log("[ingest] workAreas:", workAreas.join(", "));
  console.log("[ingest] maxOrgs:", maxOrgs || "all");

  const db = getDb();
  insertRun(db, {
    run_id: runId,
    source: "sra_api",
    started_at: new Date().toISOString(),
    config: JSON.stringify(cfgSnapshot),
  });

  try {
    const { count, orgs } = await fetchAllOrganisations();
    const filtered = filterOrganisations(orgs, { workAreas, maxOrgs });
    console.log(`[ingest] API Count: ${count}, payload: ${orgs.length}, kept: ${filtered.length}`);

    // 增量入库统计
    let newCount = 0;
    let updateCount = 0;
    let skipCount = 0;
    const qualityIssues = [];

    const tx = db.transaction(() => {
      for (const o of filtered) {
        const row = mapOrganisationRow(o);

        // 强制邮箱验证 - 无邮箱记录不入库
        if (!row.email || row.email.trim() === "") {
          console.warn(`[skip] ${row.external_id}: 无邮箱`);
          continue;
        }

        // 跨源去重 — 检查其他数据源是否已有同名记录
        const nameLower = (row.name || "").trim().toLowerCase();
        if (nameLower && nameLower !== "无") {
          const crossDupe = db.prepare(
            "SELECT id FROM organisations WHERE source != ? AND LOWER(TRIM(name)) = ?"
          ).get(row.source, nameLower);
          if (crossDupe) {
            continue;
          }
        }

        // 验证数据质量
        const validation = validateRecord(row);
        if (validation.errors.length > 0) {
          console.warn(`[validate] ${row.external_id}: ${validation.errors.map(e => e.message).join(", ")}`);
        }
        qualityIssues.push(validation);

        const existing = db
          .prepare("SELECT id, name, telephone, email FROM organisations WHERE source = ? AND external_id = ?")
          .get(row.source, row.external_id);

        if (!existing) {
          // 新增
          upsertOrganisation(db, row, runId);
          newCount++;
        } else {
          // 检查是否有变化
          const hasChanged =
            existing.name !== row.name ||
            existing.telephone !== row.telephone ||
            existing.email !== row.email;

          if (hasChanged) {
            // 有变化才更新
            upsertOrganisation(db, row, runId);
            updateCount++;
            console.log(`[update] ${row.external_id} | ${existing.name} → ${row.name}`);
          } else {
            // 无变化，跳过写入
            skipCount++;
            db.prepare("UPDATE organisations SET last_seen_run = ? WHERE id = ?")
              .run(runId, existing.id);
          }
        }
      }
    });
    tx();

    finishRun(db, {
      run_id: runId,
      finished_at: new Date().toISOString(),
      org_total: orgs.length,
      org_kept: filtered.length,
    });

    console.log("\n[ingest] ========== 入库统计 ==========");
    console.log(`[ingest] 本次筛选符合条件: ${filtered.length} 条`);
    console.log(`[ingest] ✓ 新增入库: ${newCount} 条`);
    console.log(`[ingest] ↻ 有变化更新: ${updateCount} 条`);
    console.log(`[ingest] - 无变化跳过: ${skipCount} 条`);
    console.log("[ingest] =================================");

    // 数据库现有总数
    const totalInDb = db.prepare("SELECT COUNT(*) as c FROM organisations").get().c;
    console.log(`[ingest] 数据库现有总数: ${totalInDb} 条`);

    // 生成质量报告
    const qualityReport = generateRunReport(qualityIssues, "sra_api");
    console.log(`[ingest] 数据质量评分: ${qualityReport.avgScore}/100, 错误: ${qualityReport.errorCount}, 警告: ${qualityReport.warningCount}`);

    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
      runId,
      org_total: orgs.length,
      org_kept: filtered.length,
      newCount,
      updateCount,
      skipCount,
      totalInDb,
      quality: qualityReport,
      cfg: cfgSnapshot,
    }, null, 2));

    console.log("[ingest] wrote:", path.join("output", runId, "summary.json"));
  } finally {
    closeDb();
  }

  return { runId, outDir };
}

async function ingestLawSocietyOrganisations() {
  const runId = nowRunId();
  const outDir = path.resolve("output", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const workAreas = parseListEnv("WORK_AREAS", ["Immigration", "Private client"]);
  const maxOrgs = Number(process.env.MAX_ORGS || "0") || 0;
  const pagesPerDay = Number(process.env.LAW_SOCIETY_PAGES_PER_DAY || "5") || 5;
  const useProxy = process.env.LAW_SOCIETY_USE_PROXY === "true";

  const cfgSnapshot = {
    source: "lawsociety_scraper",
    workAreas,
    maxOrgs,
    pagesPerDay,
    useProxy,
  };

  console.log("[ingest] run_id:", runId);
  console.log("[ingest] source: Law Society (每日爬取)");
  console.log("[ingest] workAreas:", workAreas.join(", "));
  console.log("[ingest] maxOrgs:", maxOrgs || "all");
  console.log("[ingest] pagesPerDay:", pagesPerDay);
  console.log("[ingest] useProxy:", useProxy);

  const db = getDb();
  insertRun(db, {
    run_id: runId,
    source: "lawsociety_scraper",
    started_at: new Date().toISOString(),
    config: JSON.stringify(cfgSnapshot),
  });

  try {
    // 如果启用代理，获取一个可用代理
    let proxyServer = null;
    if (useProxy) {
      console.log("[ingest] 正在获取代理 IP...");
      proxyServer = await getWorkingProxy();
      if (proxyServer) {
        console.log(`[ingest] 使用代理: ${proxyServer}`);
      } else {
        console.log("[ingest] 未找到可用代理，将直接连接");
      }
    }

    const orgs = await lawSociety.searchSolicitorsDaily({
      workAreas,
      maxOrgs,
      pagesPerDay,
      headless: false, // 使用 headful 模式 + Xvfb 虚拟显示（Docker 中通过 DISPLAY=:99）
      proxyServer,
    });

    console.log(`[ingest] Law Society 爬取到: ${orgs.length} 条`);

    let newCount = 0;
    let updateCount = 0;
    let skipCount = 0;
    let filterSkip = 0;
    let dupeSkip = 0;
    const qualityIssues = [];

    const tx = db.transaction(() => {
      for (const o of orgs) {
        const row = lawSociety.mapOrganisationRow(o);

        // 1. 无邮箱的跳过
        if (!row.email || row.email.trim() === "") {
          continue;
        }

        // 2. 专业领域过滤 — 与 SRA 保持一致
        if (workAreas.length > 0 && row.work_areas && row.work_areas.length > 0) {
          const waLower = row.work_areas.map(a => (a || "").toLowerCase());
          const match = workAreas.some(wanted =>
            waLower.some(a => a.includes(wanted.toLowerCase()))
          );
          if (!match) {
            filterSkip++;
            continue;
          }
        }

        // 3. 跨源去重 — 检查 SRA/Faculty Office 是否已有同名记录
        const nameLower = (row.name || "").trim().toLowerCase();
        if (nameLower && nameLower !== "无") {
          const crossDupe = db.prepare(
            "SELECT id FROM organisations WHERE source != ? AND LOWER(TRIM(name)) = ?"
          ).get(row.source, nameLower);
          if (crossDupe) {
            dupeSkip++;
            continue;
          }
        }

        // 验证数据质量
        const validation = validateRecord(row);
        if (validation.errors.length > 0) {
          console.warn(`[validate] ${row.external_id}: ${validation.errors.map(e => e.message).join(", ")}`);
        }
        qualityIssues.push(validation);

        const existing = db
          .prepare("SELECT id, name, telephone, email FROM organisations WHERE source = ? AND external_id = ?")
          .get(row.source, row.external_id);

        if (!existing) {
          upsertOrganisation(db, row, runId);
          newCount++;
        } else {
          const hasChanged =
            existing.telephone !== row.telephone ||
            existing.email !== row.email;

          if (hasChanged) {
            upsertOrganisation(db, row, runId);
            updateCount++;
            console.log(`[update] ${row.name}`);
          } else {
            skipCount++;
            db.prepare("UPDATE organisations SET last_seen_run = ? WHERE id = ?")
              .run(runId, existing.id);
          }
        }
      }
    });
    tx();

    finishRun(db, {
      run_id: runId,
      finished_at: new Date().toISOString(),
      org_total: orgs.length,
      org_kept: orgs.length,
    });

    console.log("\n[ingest] ========== 入库统计 ==========");
    console.log(`[ingest] 本次爬取: ${orgs.length} 条`);
    console.log(`[ingest] ✓ 新增入库: ${newCount} 条`);
    console.log(`[ingest] ↻ 有变化更新: ${updateCount} 条`);
    console.log(`[ingest] - 无变化跳过: ${skipCount} 条`);
    console.log(`[ingest] - 专业领域不符: ${filterSkip} 条`);
    console.log(`[ingest] - 跨源重复: ${dupeSkip} 条`);
    console.log("[ingest] =================================");

    const totalInDb = db.prepare("SELECT COUNT(*) as c FROM organisations").get().c;
    console.log(`[ingest] 数据库现有总数: ${totalInDb} 条`);

    const qualityReport = generateRunReport(qualityIssues, "lawsociety_scraper");
    console.log(`[ingest] 数据质量评分: ${qualityReport.avgScore}/100, 错误: ${qualityReport.errorCount}, 警告: ${qualityReport.warningCount}`);

    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
      runId,
      org_total: orgs.length,
      org_kept: orgs.length,
      newCount,
      updateCount,
      skipCount,
      totalInDb,
      quality: qualityReport,
      cfg: cfgSnapshot,
    }, null, 2));

    console.log("[ingest] wrote:", path.join("output", runId, "summary.json"));
  } finally {
    closeDb();
  }

  return { runId, outDir };
}

async function ingestFacultyOfficeOrganisations() {
  const runId = nowRunId();
  const outDir = path.resolve("output", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const maxPages = Number(process.env.FACULTYOFFICE_MAX_PAGES || "0") || 0;
  const maxOrgs = Number(process.env.MAX_ORGS || "0") || 0;
  const delayMs = Number(process.env.FACULTYOFFICE_DELAY_MS || "1500") || 1500;

  const cfgSnapshot = {
    source: "facultyoffice",
    maxPages,
    maxOrgs,
    delayMs,
  };

  console.log("[ingest] run_id:", runId);
  console.log("[ingest] source: Faculty Office (NotaryPRO)");
  console.log("[ingest] maxPages:", maxPages || "全部");
  console.log("[ingest] maxOrgs:", maxOrgs || "全部");
  console.log("[ingest] delayMs:", delayMs);

  const db = getDb();
  insertRun(db, {
    run_id: runId,
    source: "facultyoffice",
    started_at: new Date().toISOString(),
    config: JSON.stringify(cfgSnapshot),
  });

  try {
    const orgs = await facultyOffice.fetchAllNotaries({
      maxPages,
      maxOrgs,
      delayMs,
    });

    console.log(`[ingest] Faculty Office 爬取到: ${orgs.length} 条`);

    let newCount = 0;
    let updateCount = 0;
    let skipCount = 0;
    const qualityIssues = [];

    const tx = db.transaction(() => {
      for (const o of orgs) {
        const row = facultyOffice.mapOrganisationRow(o);

        if (!row.email) {
          // 无邮箱的跳过，营销必须有联系方式
          continue;
        }

        // 跨源去重 — 检查其他数据源是否已有同名记录
        const nameLower = (row.name || "").trim().toLowerCase();
        if (nameLower && nameLower !== "无") {
          const crossDupe = db.prepare(
            "SELECT id FROM organisations WHERE source != ? AND LOWER(TRIM(name)) = ?"
          ).get(row.source, nameLower);
          if (crossDupe) {
            continue;
          }
        }

        // 验证数据质量
        const validation = validateRecord(row);
        if (validation.errors.length > 0) {
          console.warn(`[validate] ${row.external_id}: ${validation.errors.map(e => e.message).join(", ")}`);
        }
        qualityIssues.push(validation);

        const existing = db
          .prepare("SELECT id, name, telephone, email FROM organisations WHERE source = ? AND external_id = ?")
          .get(row.source, row.external_id);

        if (!existing) {
          upsertOrganisation(db, row, runId);
          newCount++;
        } else {
          const hasChanged =
            existing.name !== row.name ||
            existing.telephone !== row.telephone ||
            existing.email !== row.email;

          if (hasChanged) {
            upsertOrganisation(db, row, runId);
            updateCount++;
            console.log(`[update] ${row.external_id} | ${existing.name} → ${row.name}`);
          } else {
            skipCount++;
            db.prepare("UPDATE organisations SET last_seen_run = ? WHERE id = ?")
              .run(runId, existing.id);
          }
        }
      }
    });
    tx();

    finishRun(db, {
      run_id: runId,
      finished_at: new Date().toISOString(),
      org_total: orgs.length,
      org_kept: orgs.length - skipCount,
    });

    console.log("\n[ingest] ========== 入库统计 ==========");
    console.log(`[ingest] 本次爬取: ${orgs.length} 条`);
    console.log(`[ingest] ✓ 新增入库: ${newCount} 条`);
    console.log(`[ingest] ↻ 有变化更新: ${updateCount} 条`);
    console.log(`[ingest] - 无变化跳过: ${skipCount} 条`);
    console.log(`[ingest] - 无邮箱跳过: ${orgs.length - newCount - updateCount - skipCount} 条`);
    console.log("[ingest] =================================");

    const totalInDb = db.prepare("SELECT COUNT(*) as c FROM organisations").get().c;
    console.log(`[ingest] 数据库现有总数: ${totalInDb} 条`);

    const qualityReport = generateRunReport(qualityIssues, "facultyoffice");
    console.log(`[ingest] 数据质量评分: ${qualityReport.avgScore}/100, 错误: ${qualityReport.errorCount}, 警告: ${qualityReport.warningCount}`);

    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
      runId,
      org_total: orgs.length,
      org_kept: orgs.length,
      newCount,
      updateCount,
      skipCount,
      totalInDb,
      quality: qualityReport,
      cfg: cfgSnapshot,
    }, null, 2));

    console.log("[ingest] wrote:", path.join("output", runId, "summary.json"));
  } finally {
    closeDb();
  }

  return { runId, outDir };
}

async function ingestAll() {
  console.log("========== 开始全量数据采集 ==========\n");

  console.log("1. 采集 SRA 数据...");
  await ingestSraOrganisations();

  console.log("\n2. 采集 Law Society 数据...");
  await ingestLawSocietyOrganisations();

  console.log("\n3. 采集 Faculty Office 公证人数据...");
  await ingestFacultyOfficeOrganisations();

  console.log("\n========== 全量采集完成 ==========");
}

if (require.main === module) {
  const source = process.env.SOURCE || "all";

  if (source === "sra") {
    ingestSraOrganisations().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else if (source === "lawsociety") {
    ingestLawSocietyOrganisations().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else if (source === "facultyoffice") {
    ingestFacultyOfficeOrganisations().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else {
    ingestAll().catch((e) => {
      console.error(e);
      process.exit(1);
    });
  }
}

module.exports = {
  ingestSraOrganisations,
  ingestLawSocietyOrganisations,
  ingestFacultyOfficeOrganisations,
  ingestAll,
};

