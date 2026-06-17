const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

// Ensure logs directory exists
const LOGS_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

let db = null;
if (fs.existsSync(path.join(__dirname, "db_config.json"))) {
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
  --help, -h                 Show help
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    emails: null,
    concurrency: 5,
    confirm: false,
    minPrice: null,
    maxPrice: null,
    startUrl: null,
    headless: "true",
    browser: false,
    userId: 1,
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

function drawDashboard(concurrency) {
  // Clear screen and move cursor to top left
  console.clear();
  
  const activeCount = workers.filter(w => w.status === "RUNNING").length;
  const successCount = workers.filter(w => w.status === "SUCCESS").length;
  const failedCount = workers.filter(w => w.status === "FAILED").length;
  const pendingCount = workers.filter(w => w.status === "PENDING").length;

  console.log(`╔══════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║                  Amazon Parallel Execution Dashboard                     ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════╝`);
  console.log(`  [Concurrency Limit: ${concurrency}]  [Running: ${activeCount}]  [Success: ${successCount}]  [Failed: ${failedCount}]  [Queue: ${pendingCount}]`);
  console.log(`----------------------------------------------------------------------------`);

  workers.forEach((w, index) => {
    let statusIcon = "⏳";
    let statusColor = "\x1b[37m"; // White
    
    if (w.status === "RUNNING") {
      statusIcon = "🔄";
      statusColor = "\x1b[36m"; // Cyan
    } else if (w.status === "SUCCESS") {
      statusIcon = "✅";
      statusColor = "\x1b[32m"; // Green
    } else if (w.status === "FAILED") {
      statusIcon = "❌";
      statusColor = "\x1b[31m"; // Red
    }

    const paddedEmail = w.email.padEnd(35, " ");
    const paddedStep = w.step.padEnd(25, " ");
    console.log(` ${String(index + 1).padStart(2, " ")}. ${statusColor}${statusIcon} ${paddedEmail}\x1b[0m | ${statusColor}${paddedStep}\x1b[0m | Log: logs/pipeline_${w.safeEmail}.log`);
  });
  
  console.log(`----------------------------------------------------------------------------`);
}

async function runWorker(worker, config) {
  worker.status = "RUNNING";
  worker.step = "Starting pipeline...";
  drawDashboard(config.concurrency);

  const logFile = path.join(LOGS_DIR, `pipeline_${worker.safeEmail}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: "w" });

  const args = ["pipeline.js", "--email", worker.email];
  if (config.confirm) args.push("--confirm-place-order");
  if (config.headless === "true") args.push("--headless");
  if (config.browser) args.push("--browser");
  if (config.minPrice) args.push("--min-price", config.minPrice);
  if (config.maxPrice) args.push("--max-price", config.maxPrice);
  if (config.startUrl) args.push("--start-url", config.startUrl);
  if (config.userId) args.push("--user-id", String(config.userId));

  const child = spawn("node", args, { shell: true });

  child.stdout.on("data", (data) => {
    const text = data.toString();
    logStream.write(data);

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
    if (fs.existsSync(path.join(__dirname, "credentials.json"))) {
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "credentials.json"), "utf8"));
        if (creds.email) emailList = [creds.email];
      } catch (e) {}
    }
  }

  if (emailList.length === 0) {
    console.error("❌ Error: No email addresses specified or found in database.");
    process.exit(1);
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

  console.log(`🚀 Starting parallel execution for ${workers.length} accounts (Concurrency: ${config.concurrency})...`);
  drawDashboard(config.concurrency);

  const queue = [...workers];
  const activeWorkers = [];

  // Manage concurrency pool manually
  while (queue.length > 0 || activeWorkers.length > 0) {
    while (activeWorkers.length < config.concurrency && queue.length > 0) {
      const nextWorker = queue.shift();
      const promise = runWorker(nextWorker, config).then(() => {
        // Remove from active list when done
        const index = activeWorkers.indexOf(promise);
        if (index > -1) activeWorkers.splice(index, 1);
      });
      activeWorkers.push(promise);
    }

    if (activeWorkers.length > 0) {
      // Wait for at least one worker to finish
      await Promise.race(activeWorkers);
    }
  }

  console.log(`\n\x1b[32m🏁 ALL PARALLEL TASKS COMPLETED!\x1b[0m`);
  const successCount = workers.filter(w => w.status === "SUCCESS").length;
  console.log(`Success: ${successCount}/${workers.length} accounts.`);
}

main();
