/**
 * 定时任务调度器 — 替代 PM2 cron_restart（在 Docker 中不可靠）
 * 使用 node-cron 在 server 进程内调度数据采集任务
 */
const cron = require("node-cron");
const { fork } = require("node:child_process");
const path = require("node:path");

const INGEST_SCRIPT = path.resolve(__dirname, "ingest.js");

// 任务运行状态（防止重叠执行）
const running = { sra: false, lawsociety: false, facultyoffice: false, replyCheck: false, autoSend: false };

function runIngest(source) {
  if (running[source]) {
    console.log(`[scheduler] ${source} 正在运行中，跳过本次调度`);
    return;
  }
  running[source] = true;
  console.log(`[scheduler] 启动 ${source} 数据采集 @ ${new Date().toISOString()}`);

  const child = fork(INGEST_SCRIPT, [], {
    env: { ...process.env, SOURCE: source },
    stdio: "inherit",
  });

  child.on("exit", (code) => {
    running[source] = false;
    if (code === 0) {
      console.log(`[scheduler] ${source} 采集完成`);
    } else {
      console.error(`[scheduler] ${source} 采集失败，退出码: ${code}`);
    }
  });

  child.on("error", (err) => {
    running[source] = false;
    console.error(`[scheduler] ${source} 进程错误:`, err.message);
  });
}

function startScheduler() {
  console.log("[scheduler] 定时任务调度器启动");
  console.log("[scheduler] 调度计划:");
  console.log("  - SRA:            每周一 02:00 (Asia/Shanghai)");
  console.log("  - Law Society:    每天   03:00 (Asia/Shanghai)");
  console.log("  - Faculty Office: 每周一 04:00 (Asia/Shanghai)");

  // SRA — 每周一凌晨 2 点
  cron.schedule("0 2 * * 1", () => runIngest("sra"), { timezone: "Asia/Shanghai" });

  // Law Society — 每天凌晨 3 点
  cron.schedule("0 3 * * *", () => runIngest("lawsociety"), { timezone: "Asia/Shanghai" });

  // Faculty Office — 每周一凌晨 4 点
  cron.schedule("0 4 * * 1", () => runIngest("facultyoffice"), { timezone: "Asia/Shanghai" });

  // 自动批量发送邮件 — 英国工作日 9:00 AM (Europe/London，自动处理 BST/GMT)
  const { runAutoSend } = require("./lib/auto-sender");
  const { getDb, getMonitorState, setMonitorState, getReplyByMessageId, insertEmailReply, matchOrgByEmail, markOrgReplied } = require("./db");
  const db = getDb();

  console.log("  - 自动邮件发送: 英国工作日 09:03 (Europe/London)");

  cron.schedule("3 9 * * 1-5", async () => {
    if (running.autoSend) {
      console.log("[scheduler] 自动发送正在运行中，跳过本次");
      return;
    }
    running.autoSend = true;
    try {
      await runAutoSend(db);
    } catch (err) {
      console.error("[scheduler] 自动发送异常:", err.message);
    } finally {
      running.autoSend = false;
    }
  }, { timezone: "Europe/London" });

  // 邮件回复检查 — 由 email-monitor.startImapMonitor() 管理（支持热重启）
  const { startImapMonitor } = require("./lib/email-monitor");
  const dbOps = { getMonitorState, setMonitorState, getReplyByMessageId, insertEmailReply, matchOrgByEmail, markOrgReplied };
  startImapMonitor({ db, dbOps });
}

module.exports = { startScheduler, runIngest };
