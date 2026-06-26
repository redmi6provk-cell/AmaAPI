const readline = require('readline');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load DB to fetch account counts
let db = null;
if (fs.existsSync(path.join(__dirname, '..', 'config', 'db_config.json'))) {
  try { db = require('./db'); } catch (e) {}
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function getAccountCount(userId) {
  if (!db) return null;
  try {
    const accounts = await db.getAccountsByUser(userId);
    return accounts.length;
  } catch (e) {
    return null;
  }
}

async function main() {
  console.clear();
  console.log("====================================================");
  console.log("   🤖 Amazon Automation Interactive Terminal Runner   ");
  console.log("====================================================");

  const startUrl = await askQuestion("\n🔗 Enter Affiliate/Product URL (or press Enter to skip): ");
  const confirmStr = await askQuestion("🛒 Place order & confirm payment? (yes/no) [default: no]: ");
  const confirm = confirmStr.trim().toLowerCase() === 'yes' || confirmStr.trim().toLowerCase() === 'y';

  const headlessStr = await askQuestion("👁️  Run in Headless mode (hide browser windows)? (yes/no) [default: yes]: ");
  const headless = headlessStr.trim().toLowerCase() !== 'no' && headlessStr.trim().toLowerCase() !== 'n';

  // ── Profile / User ID ──
  console.log("\n👤 Profile Selection:");

  // Fetch counts for both profiles in parallel
  const [count1, count2] = await Promise.all([
    getAccountCount(1),
    getAccountCount(2)
  ]);

  const label1 = count1 !== null ? `\x1b[33m${count1} IDs\x1b[0m` : '? IDs';
  const label2 = count2 !== null ? `\x1b[33m${count2} IDs\x1b[0m` : '? IDs';

  console.log(`   Profile 1 = vkkykh@kanuvk.com        (pauljohnson... accounts)    ── ${label1}`);
  console.log(`   Profile 2 = johnsonsmithh880@gmail.com  (johnsonsmithh... accounts) ── ${label2}`);

  const profileStr = await askQuestion("   Select Profile (1 or 2) [default: 1]: ");
  const userId = profileStr.trim() === '2' ? 2 : 1;
  const totalCount = userId === 2 ? count2 : count1;

  if (totalCount !== null) {
    console.log(`   \x1b[32m✅ Profile ${userId} selected — Total accounts: \x1b[1m${totalCount}\x1b[0m`);
  }

  // ── Target ──
  console.log("");
  if (totalCount !== null) {
    console.log(`   📋 Available range: 1 to ${totalCount} (total ${totalCount} accounts)`);
  }
  const targetType = await askQuestion("👥 Target: (1) All  (2) Specific email  (3) Range  OR type directly e.g. 26-165 [default: 1]: ");
  let email = "";
  let rangeFrom = 0;
  let rangeTo = 0;

  const trimmedTarget = targetType.trim();
  const isDirectRange = /^\d+-\d+$/.test(trimmedTarget);
  const isSingleNum   = /^\d+$/.test(trimmedTarget) && parseInt(trimmedTarget) > 3;

  if (trimmedTarget === '2') {
    email = await askQuestion("📧 Enter target email address: ");

  } else if (trimmedTarget === '3') {
    const hint = totalCount !== null ? ` (1-${totalCount})` : '';
    const rangeStr = await askQuestion(`📊 Enter range${hint} e.g. 26-${totalCount || 50}: `);
    const parts = rangeStr.trim().split('-');
    rangeFrom = parseInt(parts[0]) || 1;
    rangeTo   = parseInt(parts[1]) || 0;
    const willRun = totalCount !== null
      ? Math.min(rangeTo || totalCount, totalCount) - rangeFrom + 1
      : (rangeTo ? rangeTo - rangeFrom + 1 : '?');
    console.log(`   \x1b[32m✅ Range: ${rangeFrom} \u2192 ${rangeTo || totalCount || '?'}  |  \x1b[1m${willRun} accounts\x1b[0m`);

  } else if (isDirectRange) {
    // User typed "26-165" directly — auto detected!
    const parts = trimmedTarget.split('-');
    rangeFrom = parseInt(parts[0]);
    rangeTo   = parseInt(parts[1]);
    const willRun = totalCount !== null
      ? Math.min(rangeTo, totalCount) - rangeFrom + 1
      : rangeTo - rangeFrom + 1;
    console.log(`   \x1b[32m✅ Range auto-detected: ${rangeFrom} \u2192 ${rangeTo}  |  \x1b[1m${willRun} accounts\x1b[0m`);

  } else if (isSingleNum) {
    // User typed a number > 3 like "50" — treat as "from 50 to end"
    rangeFrom = parseInt(trimmedTarget);
    const willRun = totalCount !== null ? totalCount - rangeFrom + 1 : '?';
    console.log(`   \x1b[32m✅ Range: ${rangeFrom} \u2192 ${totalCount || 'end'}  |  \x1b[1m${willRun} accounts\x1b[0m`);

  } else {
    // Default: All accounts
    if (totalCount !== null) {
      console.log(`   \x1b[32m✅ All ${totalCount} accounts will run\x1b[0m`);
    }
  }

  // ── Concurrency ──
  const concurrencyStr = await askQuestion("\n⚡ Concurrency (parallel accounts at once) [default: 3]: ");
  const concurrency = parseInt(concurrencyStr.trim()) || 3;

  const minPrice = await askQuestion("💵 Enter Min Price limit (optional): ");
  const maxPrice = await askQuestion("💵 Enter Max Price limit (optional): ");

  // ── IP Rotation ──
  console.log("\n📱 IP Rotation (requires Android phone via USB with USB Tethering ON)");
  const rotateStr = await askQuestion("🔄 Enable IP rotation? (yes/no) [default: no]: ");
  const useRotation = rotateStr.trim().toLowerCase() === 'yes' || rotateStr.trim().toLowerCase() === 'y';
  let rotateEvery = 0;
  let waitOn = 4;
  let waitReconnect = 30;
  if (useRotation) {
    const rotateEveryStr = await askQuestion("   After how many accounts rotate IP? [default: 3]: ");
    rotateEvery = parseInt(rotateEveryStr.trim()) || 3;
    const waitOnStr = await askQuestion("   Airplane ON duration in seconds? [default: 4]: ");
    waitOn = parseInt(waitOnStr.trim()) || 4;
    const waitReconnectStr = await askQuestion("   Wait for 4G reconnect in seconds? [default: 30]: ");
    waitReconnect = parseInt(waitReconnectStr.trim()) || 30;
  }

  // ── Build command ──
  const args = [path.join(__dirname, "parallel_pipeline.js")];
  if (confirm)          args.push("--confirm-place-order");
  if (startUrl.trim())  args.push("--start-url", startUrl.trim());
  if (headless) {
    args.push("--headless", "true");
  } else {
    args.push("--browser");
  }
  if (email.trim())     args.push("--emails", email.trim());
  args.push("--user-id", String(userId));
  args.push("--concurrency", String(concurrency));
  if (rangeFrom > 0)    args.push("--from", String(rangeFrom));
  if (rangeTo > 0)      args.push("--to",   String(rangeTo));
  if (minPrice.trim())  args.push("--min-price", minPrice.trim());
  if (maxPrice.trim())  args.push("--max-price", maxPrice.trim());
  if (useRotation && rotateEvery > 0) {
    args.push("--rotate-every",    String(rotateEvery));
    args.push("--wait-on",         String(waitOn));
    args.push("--wait-reconnect",  String(waitReconnect));
  }

  // ── Final Confirmation ──
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log(  "║              ✅ CONFIRM RUN DETAILS                  ║");
  console.log(  "╚══════════════════════════════════════════════════════╝");
  console.log(`  👤 Profile   : ${userId === 2 ? 'Profile 2 (johnsonsmithh)' : 'Profile 1 (pauljohnson)'}`);
  if (email.trim()) {
    console.log(`  📧 Account  : ${email.trim()}  (1 account)`);
  } else if (rangeFrom > 0 || rangeTo > 0) {
    const runFrom = rangeFrom > 0 ? rangeFrom : 1;
    const runTo   = rangeTo   > 0 ? rangeTo   : (totalCount || '?');
    const runCount = totalCount ? Math.min(runTo, totalCount) - runFrom + 1 : '?';
    console.log(`  📊 Range    : ${runFrom} → ${runTo}   (\x1b[1m${runCount} accounts\x1b[0m)`);
  } else {
    console.log(`  📊 Range    : ALL   (\x1b[1m${totalCount || '?'} accounts\x1b[0m)`);
  }
  console.log(`  ⚡ Concurrency : ${concurrency} parallel`);
  console.log(`  🛒 Place Order : ${confirm ? '\x1b[32mYES (real orders!)\x1b[0m' : '\x1b[33mNO (simulation)\x1b[0m'}`);
  console.log(`  🔄 IP Rotation : ${useRotation ? `Every ${rotateEvery} accounts` : 'Disabled'}`);
  if (startUrl.trim()) console.log(`  🔗 Start URL   : ${startUrl.trim().substring(0, 60)}...`);
  console.log("══════════════════════════════════════════════════════");

  const goStr = await askQuestion("  ▶️  Type 'yes' to START or anything else to CANCEL: ");
  rl.close();
  if (goStr.trim().toLowerCase() !== 'yes' && goStr.trim().toLowerCase() !== 'y') {
    console.log("\n❌ Cancelled by user.");
    process.exit(0);
  }

  console.log("\n----------------------------------------------------");
  console.log(`🚀 Starting parallel pipeline...`);
  console.log(`👤 Profile: ${userId}  |  ⚡ Concurrency: ${concurrency}  |  🔄 IP Rotation: ${useRotation ? `Every ${rotateEvery} accounts` : 'Disabled'}`);
  if (totalCount !== null) {
    if (email.trim()) {
      console.log(`📧 Account: ${email.trim()}`);
    } else if (rangeFrom > 0 || rangeTo > 0) {
      const runFrom = rangeFrom > 0 ? rangeFrom : 1;
      const runTo   = rangeTo   > 0 ? rangeTo   : totalCount;
      console.log(`📊 Range: ${runFrom} → ${runTo}  |  Total: ${Math.min(runTo, totalCount) - runFrom + 1} accounts`);
    } else {
      console.log(`📊 Total accounts: ${totalCount}`);
    }
  }
  console.log("----------------------------------------------------");
  console.log(`🔍 Args: ${args.slice(1).join(" ")}`);
  console.log("----------------------------------------------------\n");

  const child = spawn("node", args, { shell: false, stdio: "inherit" });

  child.on("close", (code) => {
    console.log(`\n🏁 Execution completed with code ${code}`);
  });
}

main().catch(console.error);
