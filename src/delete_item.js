const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const axios = require("axios");
const { sendAuthorizedRequest } = require("./request_helper");
const cookiesHelper = require("./cookies");

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    target: null, // ASIN or "all"
    email: null,
    help: false
  };

  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email") {
      config.email = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      config.help = true;
    } else {
      positionals.push(args[i]);
    }
  }

  if (positionals.length > 0) {
    config.target = positionals[0];
  }
  return config;
}

async function syncCartResponse(email, cookieString) {
  const cartApiUrl = "https://www.amazon.in/cart/add-to-cart/get-cart-items?clientName=SiteWideActionExecutor&_=1779954926131";
  const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
  try {
    const response = await axios.get(cartApiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Cookie": cookieString,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    if (typeof response.data === "object" && response.data !== null) {
      fs.writeFileSync(path.join(__dirname, "..", "data", `cart_response_${safeEmail}.json`), JSON.stringify(response.data, null, 2), "utf8");
      fs.writeFileSync(path.join(__dirname, "..", "data", "cart_response.json"), JSON.stringify(response.data, null, 2), "utf8");
    }
  } catch (error) {
    console.error(`Failed to sync cart_response_${safeEmail}.json:`, error.message);
  }
}

async function performCartDelete(itemId, csrfToken, asin, email) {
  const postUrl = "https://www.amazon.in/cart/ref=ord_cart_shr?app-nav-type=none&dc=df";
  const postData = {};
  postData["anti-csrftoken-a2z"] = csrfToken;
  postData[`submit.delete-active.${itemId}`] = "Delete";

  try {
    const response = await sendAuthorizedRequest({
      method: "POST",
      url: postUrl,
      data: querystring.stringify(postData),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.amazon.in",
        "Referer": "https://www.amazon.in/gp/cart/view.html"
      }
    }, email);

    const isSuccess = (typeof response.data === "string" && response.data.includes("was removed from Shopping Cart")) || 
                      (typeof response.data === "object" && response.data !== null && response.data.isSuccess) ||
                      response.status === 200;

    if (isSuccess) {
      console.log(`  \x1b[32m[SUCCESS] Deleted ASIN ${asin}\x1b[0m`);
      return true;
    } else {
      console.log(`  \x1b[33m[WARNING] POST completed but deletion not confirmed for ASIN ${asin}.\x1b[0m`);
      return false;
    }
  } catch (error) {
    console.error(`  [ERROR] Failed to delete ASIN ${asin}: ${error.message}`);
    return false;
  }
}

async function main() {
  const config = parseArgs();
  if (config.help || !config.target) {
    console.log(`
Usage:
  node delete_item.js <ASIN or "all"> [options]

Options:
  --email <email>     Specify Amazon email
  --help, -h          Show help

Examples:
  node delete_item.js B0C3ZYFZ77
  node delete_item.js all
`);
    process.exit(config.help ? 0 : 1);
  }

  const email = cookiesHelper.getActiveEmail(config.email);
  if (!email) {
    console.error("❌ Error: Active email could not be determined. Set in credentials.json or pass --email.");
    process.exit(1);
  }

  const cartUrl = "https://www.amazon.in/gp/cart/view.html?ref_=nav_cart";
  console.log(`Fetching cart for ${email} to extract CSRF token...`);

  try {
    const getResponse = await sendAuthorizedRequest({
      method: "GET",
      url: cartUrl
    }, email);

    const html = getResponse.data;
    const tokenMatch = html.match(/name="anti-csrftoken-a2z" value="([^"]*)"/);
    if (!tokenMatch) {
      console.error("❌ Error: Could not find CSRF token on the cart page.");
      process.exit(1);
    }
    const csrfToken = tokenMatch[1];

    let asinsToDelete = [];
    if (config.target.toLowerCase() === "all") {
      const matches = [...html.matchAll(/data-asin="([A-Z0-9]{10})"/g)];
      const uniqueAsins = new Set(matches.map(m => m[1]));
      asinsToDelete = Array.from(uniqueAsins);
      
      if (asinsToDelete.length === 0) {
        console.log("Cart is already empty.");
        process.exit(0);
      }
    } else {
      asinsToDelete = [config.target.toUpperCase()];
    }

    console.log(`Processing deletion of ${asinsToDelete.length} item(s) in parallel...`);
    const deletePromises = asinsToDelete.map(async (asin) => {
      const asinIndex = html.indexOf(`data-asin="${asin}"`);
      if (asinIndex === -1) {
        console.log(`  \x1b[33m[SKIPPED] ASIN ${asin} not found in current cart.\x1b[0m`);
        return false;
      }

      const snippet = html.substring(asinIndex, asinIndex + 2000);
      const itemIdMatch = snippet.match(/data-itemid="([^"]*)"/);
      if (!itemIdMatch) {
        console.log(`  \x1b[33m[SKIPPED] Could not find item ID for ASIN ${asin}.\x1b[0m`);
        return false;
      }
      const itemId = itemIdMatch[1];

      return performCartDelete(itemId, csrfToken, asin, email);
    });

    const results = await Promise.all(deletePromises);
    const successCount = results.filter(Boolean).length;

    console.log(`\nCompleted deleting ${successCount} items.`);
    
    // Sync cart_response.json
    await syncCartResponse(email, await cookiesHelper.getCookieString(email));
    process.exit(0);
  } catch (error) {
    if (error.message === "SESSION_EXPIRED") {
      process.exit(1);
    }
    console.error("❌ Cart deletion failed:", error.message);
    process.exit(1);
  }
}

main();
