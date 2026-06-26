const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const adb = require("./adb_helper");

// Ensure logs directory exists
const LOGS_DIR = path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

let db = null;
if (fs.existsSync(path.join(__dirname, "..", "config", "db_config.json"))) {
  try {
    db = require("./db");
  } catch (e) {}
}
const cookiesHelper = require("./cookies");

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║               Parallel Order Orchestrator                ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node parallel_pipeline.js [options]

Options:
  --emails <emails>          Comma-separated list of account emails
  --concurrency <number>     Max number of parallel orders (default: 5)
  --confirm-place-order      Actually place the order (confirm final payment)
  --min-price <number>       Set minimum allowed price check
  --max-price <number>       Set maximum allowed price check
  --start-url <url>          Set initial affiliate start URL
  --headless <true|false>    Run browser in headless mode (default: true)
  --browser                  Force checkout in visible browser window (default: false)
  --user-id <number>         Active user context ID (default: 1)
  --rotate-every <number>    Rotate IP after every N accounts (0 = disabled, default: 0)
  --wait-on <seconds>        Seconds airplane mode stays ON (default: 4)
  --wait-reconnect <seconds> Seconds to wait for 4G reconnect (default: 30)
  --skip-ip-check            Don't verify IP changed after rotation
  --help, -h                 Show help
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    emails: null,
    concurrency: 3,
    confirm: false,
    minPrice: null,
    maxPrice: null,
    startUrl: null,
    headless: "true",
    browser: false,
    userId: 1,
    from: 0,
    to: 0,
    rotateEvery: 0,
    waitOnSec: 4,
    waitReconnectSec: 30,
    skipIpCheck: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--emails":
        config.emails = args[++i];
        break;
      case "--concurrency":
        config.concurrency = parseInt(args[++i], 10) || 5;
        break;
      case "--confirm-place-order":
      case "--confirm":
        config.confirm = true;
        break;
      case "--min-price":
        config.minPrice = args[++i];
        break;
      case "--max-price":
        config.maxPrice = args[++i];
        break;
      case "--start-url":
        config.startUrl = args[++i];
        break;
      case "--headless":
        config.headless = args[++i];
        break;
      case "--browser":
        config.browser = true;
        break;
      case "--user-id":
        config.userId = parseInt(args[++i], 10) || 1;
        break;
      case "--from":
        config.from = parseInt(args[++i], 10) || 0;
        break;
      case "--to":
        config.to = parseInt(args[++i], 10) || 0;
        break;
      case "--rotate-every":
        config.rotateEvery = parseInt(args[++i], 10) || 0;
        break;
      case "--wait-on":
        config.waitOnSec = parseInt(args[++i], 10) || 4;
        break;
      case "--wait-reconnect":
        config.waitReconnectSec = parseInt(args[++i], 10) || 30;
        break;
      case "--skip-ip-check":
        config.skipIpCheck = true;
        break;
      case "--help":
      case "-h":
        config.help = true;
        break;
    }
  }
  return config;
}

// Global state tracking for reporting
const workers = [];
let ipRotationStatus = "";
let currentIp = "unknown";
let totalRotations = 0;

function drawDashboard(concurrency) {
  // Clear full terminal including scroll buffer, then move cursor to top
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  
  const activeCount   = workers.filter(w => w.status === "RUNNING").length;
  const successCount  = workers.filter(w => w.status === "SUCCESS").length;
  const failedCount   = workers.filter(w => w.status === "FAILED").length;
  const skippedCount  = workers.filter(w => w.status === "SKIPPED").length;
  const pendingCount  = workers.filter(w => w.status === "PENDING").length;

  console.log(`╔══════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║                  Amazon Parallel Execution Dashboard                     ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝`);
  console.log(`  [Concurrency: ${concurrency}]  [Running: ${activeCount}]  [✅ ${successCount}]  [❌ ${failedCount}]  [⏭️  ${skippedCount}]  [Queue: ${pendingCount}]`);
  if (ipRotationStatus) {
    console.log(`  🌐 IP: ${currentIp}  |  🔄 Rotations: ${totalRotations}  |  Status: ${ipRotationStatus}`);
  }
  console.log(`----------------------------------------------------------------------------`);

  // Show active running workers
  console.log(`\x1b[1m⚙️  ACTIVE RUNS:\x1b[0m`);
  const activeWorkers = workers.filter(w => w.status === "RUNNING");
  if (activeWorkers.length === 0) {
    console.log(`  (None)`);
  } else {
    activeWorkers.forEach((w) => {
      const idx = workers.indexOf(w) + 1;
      const paddedEmail = w.email.padEnd(35, " ");
      const paddedStep = w.step.padEnd(25, " ");
      console.log(`  ${String(idx).padStart(3, " ")}. \x1b[36m🔄 ${paddedEmail}\x1b[0m | \x1b[36m${paddedStep}\x1b[0m | Log: logs/pipeline_${w.safeEmail}.log`);
    });
  }

  console.log(`----------------------------------------------------------------------------`);
  
  // Show recently completed (success, failed, skipped) - up to 10 latest
  console.log(`\x1b[1m🏁 RECENTLY COMPLETED:\x1b[0m`);
  const completedWorkers = workers.filter(w => w.status === "SUCCESS" || w.status === "FAILED" || w.status === "SKIPPED");
  if (completedWorkers.length === 0) {
    console.log(`  (None)`);
  } else {
    const recentCompleted = completedWorkers.slice(-10);
    recentCompleted.forEach((w) => {
      const idx = workers.indexOf(w) + 1;
      let statusIcon, statusColor;
      if (w.status === "SUCCESS")  { statusIcon = "✅"; statusColor = "\x1b[32m"; }
      else if (w.status === "SKIPPED") { statusIcon = "⏭️ "; statusColor = "\x1b[33m"; }
      else                          { statusIcon = "❌"; statusColor = "\x1b[31m"; }
      const paddedEmail = w.email.padEnd(35, " ");
      const paddedStep  = w.step.padEnd(25, " ");
      console.log(`  ${String(idx).padStart(3, " ")}. ${statusColor}${statusIcon} ${paddedEmail}\x1b[0m | ${statusColor}${paddedStep}\x1b[0m | Log: logs/pipeline_${w.safeEmail}.log`);
    });
  }

  console.log(`----------------------------------------------------------------------------`);
}

async function runWorker(worker, config) {
  worker.status = "RUNNING";
  worker.step = "Starting pipeline...";
  worker.priceSkipped = false;   // flag: price was out of range
  drawDashboard(config.concurrency);

  const logFile = path.join(LOGS_DIR, `pipeline_${worker.safeEmail}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  const args = [path.join(__dirname, "pipeline.js"), "--email", worker.email];
  if (config.confirm) args.push("--confirm-place-order");
  if (config.headless === "true") args.push("--headless");
  if (config.browser) args.push("--browser");
  if (config.minPrice) args.push("--min-price", config.minPrice);
  if (config.maxPrice) args.push("--max-price", config.maxPrice);
  if (config.startUrl) args.push("--start-url", config.startUrl);
  if (config.userId) args.push("--user-id", String(config.userId));

  const child = spawn("node", args, { shell: false });

  child.stdout.on("data", (data) => {
    const text = data.toString();
    logStream.write(data);

    // Detect price out of range
    if (text.includes("Price Check Failed") || text.includes("PRICE_CHECK_FAILED") || text.includes("price check validation failed")) {
      worker.priceSkipped = true;
      worker.step = "⏭️  Price out of range";
    }
    // Detect steps from output
    if (text.includes("CLEANING SAVED ADDRESSES")) {
      worker.step = "Cleaning addresses...";
    } else if (text.includes("ADDING NEW SHIPPING ADDRESS")) {
      worker.step = "Adding address...";
    } else if (text.includes("CLEANING CURRENT CART")) {
      worker.step = "Clearing cart...";
    } else if (text.includes("ADDING PRODUCT(S) TO CART")) {
      worker.step = "Adding to cart...";
    } else if (text.includes("FETCHING CURRENT CART ITEMS")) {
      worker.step = "Fetching cart...";
    } else if (text.includes("PERFORMING CASH ON DELIVERY CHECKOUT")) {
      worker.step = "Checking out (COD)...";
    } else if (text.includes("Success! Address successfully added programmatically")) {
      worker.step = "Address added [OK]";
    } else if (text.includes("Success! ASIN") && text.includes("added to cart")) {
      worker.step = "Product added [OK]";
    }
    drawDashboard(config.concurrency);
  });

  child.stderr.on("data", (data) => {
    logStream.write(data);
    drawDashboard(config.concurrency);
  });

  return new Promise((resolve) => {
    child.on("close", (code) => {
      logStream.end();
      if (code === 0) {
        worker.status = "SUCCESS";
        worker.step = "Order Success!";
      } else if (worker.priceSkipped) {
        worker.status = "SKIPPED";
        worker.step = "Price out of range";
      } else {
        worker.status = "FAILED";
        worker.step = `Exit Code: ${code}`;
      }
      drawDashboard(config.concurrency);
      resolve();
    });
  });
}

async function main() {
  const config = parseArgs();

  if (config.help) {
    printHelp();
    process.exit(0);
  }

  let emailList = [];
  if (config.emails) {
    emailList = config.emails.split(",").map(e => e.trim()).filter(Boolean);
  } else if (db) {
    try {
      const dbAccounts = await db.getAccountsByUser(config.userId);
      if (dbAccounts && dbAccounts.length > 0) {
        emailList = dbAccounts;
      }
    } catch (e) {
      console.error("❌ Failed to query emails from database:", e.message);
    }
  }

  if (emailList.length === 0) {
    // Try fallback from credentials.json
    if (fs.existsSync(path.join(__dirname, "..", "config", "credentials.json"))) {
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "credentials.json"), "utf8"));
        if (creds.email) emailList = [creds.email];
      } catch (e) {}
    }
  }

  if (emailList.length === 0) {
    console.error("❌ Error: No email addresses specified or found in database.");
    process.exit(1);
  }

  // Apply range filter (--from / --to) — 1-based index
  if (config.from > 0 || config.to > 0) {
    const fromIdx = config.from > 0 ? config.from - 1 : 0;
    const toIdx   = config.to > 0   ? config.to       : emailList.length;
    emailList = emailList.slice(fromIdx, toIdx);
    if (emailList.length === 0) {
      console.error(`❌ No accounts in range ${config.from}-${config.to}. Total accounts: ${emailList.length}`);
      process.exit(1);
    }
  }

  // Initialize workers state
  emailList.forEach(email => {
    workers.push({
      email,
      safeEmail: email.replace(/[^a-zA-Z0-9]/g, "_"),
      status: "PENDING",
      step: "Queued..."
    });
  });


  // ── IP Rotation Setup ──
  const useIpRotation = config.rotateEvery > 0;
  if (useIpRotation) {
    ipRotationStatus = "Checking ADB...";
    drawDashboard(config.concurrency);
    const adbStatus = await adb.checkAdbStatus();
    if (!adbStatus.adbFound || !adbStatus.deviceConnected) {
      ipRotationStatus = "\x1b[31m❌ Phone not connected — IP rotation disabled\x1b[0m";
      drawDashboard(config.concurrency);
      config.rotateEvery = 0; // disable rotation
    } else {
      try {
        currentIp = await adb.getPublicIp() || "unknown";
      } catch (_) {}
      ipRotationStatus = `\x1b[32m✅ Active (every ${config.rotateEvery} accounts)\x1b[0m`;
      drawDashboard(config.concurrency);
    }
  } else {
    drawDashboard(config.concurrency);
  }

  const fullQueue = [...workers];

  // ── MAIN LOOP — with optional IP rotation batching ──
  if (config.rotateEvery > 0) {
    // Batch mode: run rotateEvery accounts, rotate IP, repeat
    while (fullQueue.length > 0) {
      const batch = fullQueue.splice(0, config.rotateEvery);

      // Run this batch with concurrency
      const batchQueue = [...batch];
      const activeWorkers = [];
      while (batchQueue.length > 0 || activeWorkers.length > 0) {
        while (activeWorkers.length < config.concurrency && batchQueue.length > 0) {
          const nextWorker = batchQueue.shift();
          const promise = runWorker(nextWorker, config).then(() => {
            const index = activeWorkers.indexOf(promise);
            if (index > -1) activeWorkers.splice(index, 1);
          });
          activeWorkers.push(promise);
        }
        if (activeWorkers.length > 0) await Promise.race(activeWorkers);
      }

      // Rotate IP if more accounts remain
      if (fullQueue.length > 0) {
        ipRotationStatus = `\x1b[33m✈️  Rotating IP...\x1b[0m`;
        drawDashboard(config.concurrency);
        try {
          const rotResult = await adb.rotateIp(currentIp, {
            waitOnSec: config.waitOnSec,
            waitReconnectSec: config.waitReconnectSec,
            retries: config.skipIpCheck ? 0 : 1,
          });
          totalRotations++;
          if (rotResult.newIp) currentIp = rotResult.newIp;
          ipRotationStatus = `\x1b[32m✅ Active (every ${config.rotateEvery} accounts) — New IP: ${currentIp}\x1b[0m`;
        } catch (err) {
          ipRotationStatus = `\x1b[31m⚠️ Rotation failed: ${err.message}\x1b[0m`;
        }
        drawDashboard(config.concurrency);
      }
    }
  } else {
    // No IP rotation — original concurrent pool mode
    const activeWorkers = [];
    const queue = [...workers];
    while (queue.length > 0 || activeWorkers.length > 0) {
      while (activeWorkers.length < config.concurrency && queue.length > 0) {
        const nextWorker = queue.shift();
        const promise = runWorker(nextWorker, config).then(() => {
          const index = activeWorkers.indexOf(promise);
          if (index > -1) activeWorkers.splice(index, 1);
        });
        activeWorkers.push(promise);
      }
      if (activeWorkers.length > 0) await Promise.race(activeWorkers);
    }
  }

  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  console.log(`\n\x1b[32m🏁 ALL PARALLEL TASKS COMPLETED!\x1b[0m`);
  const successCount = workers.filter(w => w.status === "SUCCESS").length;
  const failedCount2 = workers.filter(w => w.status === "FAILED").length;
  console.log(`✅ Success: ${successCount}/${workers.length}  |  ❌ Failed: ${failedCount2}/${workers.length}  |  🔄 IP Rotations: ${totalRotations}`);
}

main();
