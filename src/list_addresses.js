const fs = require("fs");
const path = require("path");
const { sendAuthorizedRequest } = require("./request_helper");
const cookiesHelper = require("./cookies");

function extractAddressIdsFromHtml(html) {
  const ids = [];
  const seen = new Set();
  const blocks = html.split('id="ya-myab-display-address-block-');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const idMatch = block.match(/name="addressAddressId"\s*value="([^"]+)"/) ||
                    block.match(/name="addressID"\s*value="([^"]+)"/) ||
                    block.match(/addressId=([a-zA-Z0-9_-]{10,120})/) ||
                    block.match(/^([^"]{10,120})"/);
    if (idMatch && !seen.has(idMatch[1])) {
      seen.add(idMatch[1]);
      ids.push(idMatch[1]);
    }
  }
  return ids;
}

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
    console.log("Usage: node list_addresses.js [--email email@domain.com]");
    process.exit(0);
  }

  const email = cookiesHelper.getActiveEmail(config.email);
  if (!email) {
    console.error("❌ Error: Active email could not be determined. Set in credentials.json or pass --email.");
    process.exit(1);
  }

  console.log(`Fetching saved addresses for ${email}...`);

  try {
    const response = await sendAuthorizedRequest({
      method: "GET",
      url: "https://www.amazon.in/a/addresses",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    }, email);

    const html = response.data;
    const blocks = html.split('id="ya-myab-display-address-block-');
    
    if (blocks.length <= 1) {
      console.log("\nNo saved addresses found on your account.\n");
      return;
    }

    console.log(`\n\x1b[32mSaved Addresses Found (${blocks.length - 1}):\x1b[0m`);
    
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      
      // Extract Address ID
      const idMatch = block.match(/name="addressAddressId"\s*value="([^"]+)"/) || 
                      block.match(/name="addressID"\s*value="([^"]+)"/) ||
                      block.match(/addressId=([a-zA-Z0-9_-]{10,120})/);
      const addressId = idMatch ? idMatch[1] : "UNKNOWN_ID";

      const firstGt = block.indexOf('>');
      const content = firstGt !== -1 ? block.substring(firstGt + 1) : block;

      // Strip tags and grab text lines
      const cleanText = content
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]*>/g, "\n")
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.includes("addressAddressId") && !l.includes("addressID"));

      console.log(`------------------------------------------`);
      console.log(`Address ID : \x1b[36m${addressId}\x1b[0m`);
      console.log(`Details    :`);
      cleanText.slice(0, 5).forEach(line => {
        if (!line.includes("Edit") && !line.includes("Delete") && !line.includes("Default")) {
          console.log(`  ${line}`);
        }
      });
    }
    console.log(`------------------------------------------\n`);

  } catch (error) {
    if (error.message === "SESSION_EXPIRED") {
      process.exit(1);
    }
    console.error("❌ Failed to list addresses:", error.message);
    process.exit(1);
  }
}

main();
