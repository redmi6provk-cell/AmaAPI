const fs = require("fs");
const path = require("path");
const { sendAuthorizedRequest } = require("./request_helper");
const cookiesHelper = require("./cookies");

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    email: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        config.help = true;
        break;
      case "--email":
        config.email = args[++i];
        break;
    }
  }
  return config;
}

async function main() {
  const config = parseArgs();
  if (config.help) {
    console.log("Usage: node get_cart.js [--email email@domain.com]");
    process.exit(0);
  }

  const email = cookiesHelper.getActiveEmail(config.email);
  if (!email) {
    console.error("Error: Active email could not be determined. Set in credentials.json or pass --email.");
    process.exit(1);
  }

  console.log(`Fetching cart items for ${email}...`);
  try {
    const response = await sendAuthorizedRequest({
      method: "GET",
      url: "https://www.amazon.in/cart/add-to-cart/get-cart-items?clientName=SiteWideActionExecutor&_=1779954926131",
      headers: {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest"
      }
    }, email);

    const isJson = typeof response.data === "object" && response.data !== null;
    if (isJson) {
      const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
      const targetPath = path.join(__dirname, `cart_response_${safeEmail}.json`);
      fs.writeFileSync(targetPath, JSON.stringify(response.data, null, 2), "utf8");
      fs.writeFileSync(path.join(__dirname, "cart_response.json"), JSON.stringify(response.data, null, 2), "utf8");
      console.log(`\n\x1b[32m✅ Cart Items Saved to cart_response_${safeEmail}.json and cart_response.json (${response.data.length} items found):\x1b[0m`);
      
      const items = Array.isArray(response.data) ? response.data : Object.values(response.data);
      items.forEach((item, index) => {
        console.log(`  ${index + 1}. ASIN: ${item.asin} | Qty: ${item.quantity} | Merchant: ${item.merchantId || "N/A"}`);
      });
      console.log("");
    } else {
      console.log("Unexpected HTML response. Showing preview:");
      console.log(String(response.data).substring(0, 500));
    }
    process.exit(0);
  } catch (error) {
    if (error.message === "SESSION_EXPIRED") {
      process.exit(1);
    }
    console.error("Failed to fetch cart:", error.message);
    process.exit(1);
  }
}

main();
