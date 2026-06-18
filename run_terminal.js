const readline = require('readline');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function askQuestion(query) {
  return new Promise(resolve => rl.question(query, resolve));
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

  const targetType = await askQuestion("👥 Target: (1) All accounts in DB, (2) Specific email [default: 1]: ");
  let email = "";
  if (targetType.trim() === '2') {
    email = await askQuestion("📧 Enter target email address: ");
  }

  const minPrice = await askQuestion("💵 Enter Min Price limit (optional): ");
  const maxPrice = await askQuestion("💵 Enter Max Price limit (optional): ");

  rl.close();

  // Build the command arguments for parallel_pipeline.js
  const args = ["parallel_pipeline.js"];
  if (confirm) {
    args.push("--confirm-place-order");
  }
  if (startUrl.trim()) {
    args.push("--start-url", startUrl.trim());
  }
  if (headless) {
    args.push("--headless", "true");
  } else {
    args.push("--browser"); // open visible browser
  }
  if (email.trim()) {
    args.push("--emails", email.trim());
  }
  if (minPrice.trim()) {
    args.push("--min-price", minPrice.trim());
  }
  if (maxPrice.trim()) {
    args.push("--max-price", maxPrice.trim());
  }

  console.log("\n----------------------------------------------------");
  console.log(`🚀 Starting execution: node ${args.join(" ")}`);
  console.log("----------------------------------------------------\n");

  const child = spawn("node", args, { shell: true, stdio: "inherit" });

  child.on("close", (code) => {
    console.log(`\n🏁 Execution completed with code ${code}`);
  });
}

main().catch(console.error);
