const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const cookiesHelper = require("./cookies");

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    confirm: false,
    email: null,
    headless: false,
    minPrice: null,
    maxPrice: null,
    startUrl: null,
    browser: false,
    userId: 1,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--confirm-place-order":
      case "--confirm":
        config.confirm = true;
        break;
      case "--email":
        config.email = args[++i];
        break;
      case "--headless":
        config.headless = true;
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
      case "--browser":
      case "--force-browser":
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

let userId = 1;

function runScript(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const finalArgs = [...args];
    if (userId) {
      finalArgs.push("--user-id", String(userId));
    }
    const formattedArgs = finalArgs.map(arg => {
      if (arg.includes(" ") || arg.includes("&") || arg.includes("?")) {
        return `"${arg}"`;
      }
      return arg;
    });
    const fullCommand = `node ${scriptName} ${formattedArgs.join(" ")}`;
    console.log(`\n\x1b[36m🚀 Running: ${fullCommand}\x1b[0m`);
    
    const child = spawn("node", [scriptName, ...finalArgs], { shell: false, stdio: "inherit" });
    
    child.on("close", (code) => {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`\x1b[32m⏱️  [Finished] ${scriptName} took ${elapsedSec}s\x1b[0m`);
        resolve();
      } else {
        console.log(`\x1b[31m⏱️  [Failed] ${scriptName} failed after ${elapsedSec}s\x1b[0m`);
        reject(new Error(`Script ${scriptName} exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const config = parseArgs();
  userId = config.userId;
  if (config.help) {
    console.log(`
Amazon Full API Automation Pipeline Orchestrator

Usage:
  node pipeline.js [options]

Options:
  --confirm-place-order, --confirm   Actually place the order (confirm final payment)
  --email <email>                     Specify Amazon email
  --headless                          Run browser steps in headless mode
  --min-price <number>                Set minimum allowed price check
  --max-price <number>                Set maximum allowed price check
  --start-url <url>                   Set initial affiliate start url
  --browser, --force-browser          Run checkout step inside a visible browser window
  --help, -h                          Show help
`);
    process.exit(0);
  }

  let email = null;
  try {
    email = cookiesHelper.getActiveEmail(config.email);
    if (!email) {
      console.error("❌ Error: Active email could not be determined. Set in credentials.json or pass --email.");
      process.exit(1);
    }

    console.log("======================================================");
    console.log(`🎬 STARTING FULL AUTOMATED PIPELINE FOR: ${email}`);
    console.log("======================================================");
    // --- Step 1/6: Delete all saved addresses ---
    console.log("\n--- [Step 1/6] CLEANING SAVED ADDRESSES ---");
    const deleteAddressArgs = ["all"];
    if (config.email) deleteAddressArgs.push("--email", config.email);
    await runScript("delete_address.js", deleteAddressArgs);

    // --- Step 2/6: Add shipping address ---
    console.log("\n--- [Step 2/6] ADDING NEW SHIPPING ADDRESS ---");
    const addAddressArgs = [];
    if (config.email) addAddressArgs.push("--email", config.email);
    if (config.headless) addAddressArgs.push("--headless");
    await runScript("add_address.js", addAddressArgs);

    // --- Step 3/6: Clear cart ---
    console.log("\n--- [Step 3/6] CLEANING CURRENT CART ---");
    const deleteItemArgs = ["all"];
    if (config.email) deleteItemArgs.push("--email", config.email);
    await runScript("delete_item.js", deleteItemArgs);

    // --- Step 4/6: Add target products to cart ---
    console.log("\n--- [Step 4/6] ADDING PRODUCT(S) TO CART ---");
    const cartInputPath = path.join(__dirname, "cart_input.json");
    if (!fs.existsSync(cartInputPath)) {
      console.warn("⚠️ Warning: cart_input.json not found. Skipping cart addition.");
    } else {
      const cartInput = JSON.parse(fs.readFileSync(cartInputPath, "utf8"));
      let products = [];
      if (cartInput.products && Array.isArray(cartInput.products)) {
        products = cartInput.products;
      } else if (cartInput.asin) {
        products = [{ asin: cartInput.asin, quantity: cartInput.quantity || 1 }];
      }

      if (products.length === 0) {
        console.warn("⚠️ Warning: No products found in cart_input.json. Skipping cart addition.");
      } else {
        console.log(`Found ${products.length} product(s) to add.`);
        for (let i = 0; i < products.length; i++) {
          const { asin, quantity = 1 } = products[i];
          console.log(`\nAdding [Product ${i + 1}/${products.length}] ASIN/URL: ${asin}, Qty: ${quantity}`);
          
          const addToCartArgs = [asin, String(quantity)];
          if (config.email) addToCartArgs.push("--email", config.email);
          if (config.headless) addToCartArgs.push("--headless");
          
          await runScript("add_to_cart.js", addToCartArgs);
        }
      }
    }

    // --- Step 5/6: Retrieve current cart items ---
    console.log("\n--- [Step 5/6] FETCHING CURRENT CART ITEMS ---");
    const getCartArgs = [];
    if (config.email) getCartArgs.push("--email", config.email);
    await runScript("get_cart.js", getCartArgs);

    // --- Step 6/6: POD Checkout ---
    console.log("\n--- [Step 6/6] PERFORMING CASH ON DELIVERY CHECKOUT ---");
    const checkoutArgs = [];
    if (config.confirm) checkoutArgs.push("--confirm-place-order");
    if (config.email) checkoutArgs.push("--email", config.email);
    if (config.minPrice) checkoutArgs.push("--min-price", config.minPrice);
    if (config.maxPrice) checkoutArgs.push("--max-price", config.maxPrice);
    if (config.startUrl) checkoutArgs.push("--start-url", config.startUrl);
    if (config.headless) checkoutArgs.push("--headless");
    if (config.browser) checkoutArgs.push("--browser");
    
    await runScript("pay_on_delivery.js", checkoutArgs);

    console.log("\n======================================================");
    console.log("🎉 FULL AUTOMATED PIPELINE COMPLETED SUCCESSFULLY!");
    console.log("======================================================");

  } catch (error) {
    console.error("\n❌ Pipeline failed:", error.message);
    process.exit(1);
  } finally {
    if (email) {
      const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
      const tempCartPath = path.join(__dirname, `cart_response_${safeEmail}.json`);
      if (fs.existsSync(tempCartPath)) {
        try {
          fs.unlinkSync(tempCartPath);
        } catch (e) {}
      }
    }
  }
}

main();
