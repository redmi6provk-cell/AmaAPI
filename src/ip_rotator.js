/**
 * ip_rotator.js
 * Master orchestrator: runs pipeline batches and rotates IP via ADB airplane mode.
 *
 * Flow:
 *   1. Run N pipelines (parallel)
 *   2. After every `rotateEvery` completions → Airplane ON → wait → OFF → new IP
 *   3. Repeat until all accounts processed (or infinite loop if --loop)
 *
 * Usage:
 *   node ip_rotator.js [options]
 *
 * Options:
 *   --emails <e1,e2,...>    Comma-separated emails (optional if DB configured)
 *   --concurrency <N>       Max parallel pipelines per batch (default: 5)
 *   --rotate-every <N>      Rotate IP after every N pipeline completions (default: 5)
 *   --wait-on <N>           Seconds to keep Airplane ON (default: 4)
 *   --wait-reconnect <N>    Seconds to wait for 4G reconnect after OFF (default: 30)
 *   --loop                  Keep looping through accounts indefinitely
 *   --max-rotations <N>     Stop after N rotations (0 = unlimited, default: 0)
 *   --dry-run               Test ADB + IP check only, skip pipelines
 *   --skip-ip-check         Don't verify IP changed (just rotate and continue)
 *   --confirm               Pass --confirm-place-order to pipelines
 *   --min-price <N>         Min price filter
 *   --max-price <N>         Max price filter
 *   --start-url <url>       Start URL for pipeline
 *   --headless <true|false> Browser headless mode (default: true)
 *   --user-id <N>           User ID for DB lookup
 *   --help, -h              Show help
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const adb = require("./adb_helper");

const LOGS_DIR = path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    const settingsPath = path.join(__dirname, "..", "config", "settings.json");
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch (_) {}
  return {};
}

// ─── ARG PARSING ─────────────────────────────────────────────────────────────
function parseArgs() {
  const settings = loadSettings();
  const rot = settings.ipRotation || {};
  const args = process.argv.slice(2);

  const config = {
    emails: null,
    concurrency: 5,
    rotateEvery: rot.rotateEvery || 5,
    waitOnSec: rot.waitAirplaneOnSec || 4,
    waitReconnectSec: rot.waitReconnectSec || 30,
    maxRotations: rot.maxRotations || 0,
    loop: false,
    dryRun: false,
    skipIpCheck: false,
    // pipeline pass-through
    confirm: false,
    minPrice: null,
    maxPrice: null,
    startUrl: null,
    headless: "true",
    browser: false,
    userId: 1,
    table: "accounts",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--emails":        config.emails = args[++i]; break;
      case "--concurrency":   config.concurrency = parseInt(args[++i], 10) || 5; break;
      case "--rotate-every":  config.rotateEvery = parseInt(args[++i], 10) || 5; break;
      case "--wait-on":       config.waitOnSec = parseInt(args[++i], 10) || 4; break;
      case "--wait-reconnect":config.waitReconnectSec = parseInt(args[++i], 10) || 30; break;
      case "--max-rotations": config.maxRotations = parseInt(args[++i], 10) || 0; break;
      case "--loop":          config.loop = true; break;
      case "--dry-run":       config.dryRun = true; break;
      case "--skip-ip-check": config.skipIpCheck = true; break;
      case "--confirm-place-order":
      case "--confirm":       config.confirm = true; break;
      case "--min-price":     config.minPrice = args[++i]; break;
      case "--max-price":     config.maxPrice = args[++i]; break;
      case "--start-url":     config.startUrl = args[++i]; break;
      case "--headless":      config.headless = args[++i]; break;
      case "--browser":       config.browser = true; break;
      case "--user-id":       config.userId = parseInt(args[++i], 10) || 1; break;
      case "--table":         config.table = args[++i]; break;
      case "--help": case "-h": config.help = true; break;
    }
  }
  return config;
}

// ─── DISPLAY ─────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         ADB IP Rotator — 4G/5G Airplane Mode Rotation        ║
╚══════════════════════════════════════════════════════════════╝

Setup required:
  1. Android phone connected via USB
  2. USB Debugging enabled on phone
  3. USB Tethering enabled on phone (Settings → Hotspot & Tethering)
  4. ADB in PATH  OR  adbPath set in settings.json

Flow:
  Run ${"{rotateEvery}"} pipelines → Airplane ON → wait → OFF → New IP → repeat

Usage:
  node ip_rotator.js [options]

Options:
  --emails <e1,e2,...>    Emails to process (comma-separated)
  --concurrency <N>       Parallel pipelines per batch (default: 5)
  --rotate-every <N>      Pipelines before each IP rotation (default: 5)
  --wait-on <N>           Seconds airplane stays ON (default: 4)
  --wait-reconnect <N>    Seconds to wait for 4G reconnect (default: 30)
  --loop                  Loop through accounts indefinitely
  --max-rotations <N>     Max IP rotations (0=unlimited, default: 0)
  --dry-run               Only test ADB + IP, skip pipelines
  --skip-ip-check         Don't verify new IP (just rotate and continue)
  --confirm               Place order (pass-through to pipeline)
  --min-price <N>         Min price filter
  --max-price <N>         Max price filter
  --start-url <url>       Affiliate/product start URL
  --headless <true|false> Headless browser (default: true)
  --user-id <N>           DB user ID (default: 1)
  --help, -h              Show this help

Examples:
  node ip_rotator.js --dry-run
  node ip_rotator.js --rotate-every 3 --emails a@x.com,b@x.com
  node ip_rotator.js --loop --rotate-every 5 --confirm
`);
}

function printBanner(config, currentIp) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🔄 ADB IP Rotator — Started                        ║
╚══════════════════════════════════════════════════════════════╝
  📱 Mode         : ${config.dryRun ? "DRY RUN (no pipelines)" : "LIVE"}
  🌐 Current IP   : ${currentIp || "unknown"}
  🔁 Rotate every : ${config.rotateEvery} pipeline(s)
  ✈️  Airplane ON  : ${config.waitOnSec}s
  📶 Reconnect    : up to ${config.waitReconnectSec}s
  ♾️  Loop mode    : ${config.loop ? "YES" : "NO"}
  🔢 Max rotations: ${config.maxRotations === 0 ? "unlimited" : config.maxRotations}
${"═".repeat(64)}
`);
}

// ─── PIPELINE RUNNER ──────────────────────────────────────────────────────────
function runPipeline(email, config) {
  return new Promise((resolve) => {
    const args = ["pipeline.js", "--email", email];
    if (config.confirm)   args.push("--confirm-place-order");
    if (config.headless === "true") args.push("--headless");
    if (config.browser)   args.push("--browser");
    if (config.minPrice)  args.push("--min-price", config.minPrice);
    if (config.maxPrice)  args.push("--max-price", config.maxPrice);
    if (config.startUrl)  args.push("--start-url", config.startUrl);
    if (config.userId)    args.push("--user-id", String(config.userId));

    const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
    const logFile = path.join(LOGS_DIR, `rotator_${safeEmail}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: "a" });
    const startTime = Date.now();

    console.log(`  ▶️  [Pipeline] Starting: ${email}`);
    const child = spawn("node", args, { shell: true });

    child.stdout.on("data", (d) => logStream.write(d));
    child.stderr.on("data", (d) => logStream.write(d));

    child.on("close", async (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logStream.end();
      if (code === 0) {
        console.log(`  ✅ [Pipeline] Done:    ${email} (${elapsed}s)`);
        if (config.table !== "success_accounts") {
          try {
            const db = require("./db");
            await db.moveAccount(email, config.userId, config.table || "accounts", "success_accounts");
            console.log(`  🎉 [Database] Moved ${email} to success_accounts`);
          } catch (dbErr) {
            console.warn(`  ⚠️  [Database] Failed to move successful account ${email}:`, dbErr.message);
          }
        }
        resolve({ email, success: true, elapsed });
      } else {
        console.log(`  ❌ [Pipeline] Failed:  ${email} (exit ${code}, ${elapsed}s)`);
        resolve({ email, success: false, elapsed, code });
      }
    });
  });
}

/**
 * Run up to `concurrency` pipelines in parallel, resolving when ALL finish.
 */
async function runBatch(emails, config) {
  if (emails.length === 0) return [];

  console.log(`\n📦 Running batch of ${emails.length} pipeline(s)...`);
  const results = [];
  const queue = [...emails];
  const active = [];

  while (queue.length > 0 || active.length > 0) {
    while (active.length < config.concurrency && queue.length > 0) {
      const email = queue.shift();
      const promise = runPipeline(email, config).then((res) => {
        const idx = active.indexOf(promise);
        if (idx > -1) active.splice(idx, 1);
        results.push(res);
      });
      active.push(promise);
    }
    if (active.length > 0) await Promise.race(active);
  }

  return results;
}

// ─── EMAIL SOURCE ─────────────────────────────────────────────────────────────
async function resolveEmails(config) {
  if (config.emails) {
    return config.emails.split(",").map((e) => e.trim()).filter(Boolean);
  }

  // Try DB
  try {
    const db = require("./db");
    const dbAccounts = await db.getAccountsByUser(config.userId);
    if (dbAccounts && dbAccounts.length > 0) return dbAccounts;
  } catch (_) {}

  // Try credentials.json fallback
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "credentials.json"), "utf8"));
    if (creds.email) return [creds.email];
  } catch (_) {}

  return [];
}

// ─── STATS TRACKER ───────────────────────────────────────────────────────────
const stats = {
  totalPipelines: 0,
  succeeded: 0,
  failed: 0,
  rotations: 0,
  ipHistory: [],
  startTime: Date.now(),
};

function printStats() {
  const elapsed = ((Date.now() - stats.startTime) / 1000 / 60).toFixed(1);
  console.log(`
${"═".repeat(64)}
  📊 SESSION STATS
  ─────────────────────────────────────────────
  ⏱️  Runtime      : ${elapsed} minutes
  📦 Pipelines    : ${stats.totalPipelines} total (✅ ${stats.succeeded} / ❌ ${stats.failed})
  🔄 IP Rotations : ${stats.rotations}
  🌐 IP History   : ${stats.ipHistory.join(" → ") || "none"}
${"═".repeat(64)}
`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const config = parseArgs();

  if (config.help) {
    printHelp();
    process.exit(0);
  }

  console.log("\n🔍 Checking ADB connection...");
  const adbStatus = await adb.checkAdbStatus();

  if (!adbStatus.adbFound) {
    console.error(`
❌ ADB NOT FOUND!

Kaise install karein:
  1. Download: https://developer.android.com/tools/releases/platform-tools
  2. Extract to: C:\\platform-tools\\
  3. Add to PATH: C:\\platform-tools
  4. Ya settings.json mein add karein:
     { "adbPath": "C:\\\\platform-tools\\\\adb.exe" }
`);
    process.exit(1);
  }

  if (!adbStatus.deviceConnected) {
    console.error(`
❌ PHONE CONNECTED NAHI HAI!

Steps:
  1. USB cable se phone connect karein
  2. Phone mein: Settings → Developer Options → USB Debugging ON
  3. Phone screen par "Allow USB Debugging" accept karein
  4. Phone mein: Settings → Hotspot & Tethering → USB Tethering ON
  5. Check karein: adb devices

Device ID found: ${adbStatus.deviceId || "none"}
`);
    process.exit(1);
  }

  console.log(`✅ Phone connected: ${adbStatus.deviceId}`);

  // Get initial IP
  let currentIp = null;
  console.log("🌐 Getting current public IP...");
  try {
    currentIp = await adb.getPublicIp();
    console.log(`✅ Current IP: ${currentIp}`);
    stats.ipHistory.push(currentIp);
  } catch (err) {
    console.warn(`⚠️  Could not get IP: ${err.message}`);
    console.warn("   (Is USB Tethering enabled on the phone?)");
    if (!config.skipIpCheck) {
      console.warn("   Use --skip-ip-check to continue anyway.\n");
      process.exit(1);
    }
  }

  // Dry run mode — just test ADB + IP rotation and exit
  if (config.dryRun) {
    printBanner(config, currentIp);
    console.log("🧪 DRY RUN — Testing IP rotation now...\n");
    const result = await adb.rotateIp(currentIp, {
      waitOnSec: config.waitOnSec,
      waitReconnectSec: config.waitReconnectSec,
      retries: 1,
    });
    if (result.success) {
      console.log("🎉 Dry run complete! ADB rotation is working.");
    } else {
      console.log("⚠️  Dry run complete, but IP did not change. Check wait times.");
    }
    process.exit(0);
  }

  // Get email list
  const emailList = await resolveEmails(config);
  if (emailList.length === 0) {
    console.error("❌ No emails found. Use --emails or configure DB/credentials.json");
    process.exit(1);
  }

  printBanner(config, currentIp);
  console.log(`📧 Processing ${emailList.length} account(s): ${emailList.join(", ")}\n`);

  // ── MAIN LOOP ──
  let completedCount = 0;
  let rotationCount = 0;
  let loopIteration = 0;

  do {
    loopIteration++;
    if (config.loop && loopIteration > 1) {
      console.log(`\n🔁 Loop iteration #${loopIteration}...`);
    }

    // Chunk emails into batches of rotateEvery
    const chunkSize = Math.min(config.rotateEvery, config.concurrency);
    let emailQueue = [...emailList];

    while (emailQueue.length > 0) {
      // Take next chunk
      const batch = emailQueue.splice(0, config.rotateEvery);

      // Run batch
      const results = await runBatch(batch, config);

      // Update stats
      const successes = results.filter((r) => r.success).length;
      const failures  = results.filter((r) => !r.success).length;
      stats.totalPipelines += results.length;
      stats.succeeded += successes;
      stats.failed += failures;
      completedCount += results.length;

      console.log(`\n  📈 Batch complete: ${successes}✅ ${failures}❌  |  Total: ${stats.totalPipelines}`);

      // Check if we should rotate
      const shouldRotate = emailQueue.length > 0 || config.loop;
      if (shouldRotate) {
        // Check max rotations limit
        if (config.maxRotations > 0 && rotationCount >= config.maxRotations) {
          console.log(`\n⛔ Max rotations (${config.maxRotations}) reached. Stopping.`);
          break;
        }

        // Perform IP rotation
        const rotResult = await adb.rotateIp(currentIp, {
          waitOnSec: config.waitOnSec,
          waitReconnectSec: config.waitReconnectSec,
          retries: config.skipIpCheck ? 0 : 1,
        });

        rotationCount++;
        stats.rotations++;

        if (rotResult.newIp) {
          currentIp = rotResult.newIp;
          stats.ipHistory.push(currentIp);
        }
      }
    }

    // Break if max rotations hit
    if (config.maxRotations > 0 && rotationCount >= config.maxRotations) break;

  } while (config.loop);

  // ── DONE ──
  printStats();
  console.log("🏁 IP Rotator finished!\n");
}

// Graceful Ctrl+C
process.on("SIGINT", () => {
  console.log("\n\n⛔ Interrupted by user (Ctrl+C)");
  printStats();
  process.exit(0);
});

main().catch((err) => {
  console.error("❌ Fatal error:", err.message);
  process.exit(1);
});
