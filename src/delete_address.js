const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const { sendAuthorizedRequest } = require("./request_helper");
const cookiesHelper = require("./cookies");

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

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
    addressId: null, // Address ID or "all"
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
    config.addressId = positionals[0];
  }
  return config;
}

async function runAddressDelete(addressId, email) {
  const listUrl = "https://www.amazon.in/a/addresses";
  console.log(`Fetching address page to delete address ID: ${addressId}...`);

  try {
    const getResponse = await sendAuthorizedRequest({
      method: "GET",
      url: listUrl,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    }, email);

    const html = getResponse.data;
    const savedAddressIds = extractAddressIdsFromHtml(html);
    if (!savedAddressIds.includes(addressId)) {
      console.log(`\x1b[33m[SKIPPED] Address ${addressId} not found on Amazon addresses page.\x1b[0m`);
      return false;
    }

    const cardIndex = html.indexOf(addressId);
    const tokenMatch = html.match(/name=["']csrfToken["']\s*value=["']([^"']*)["']/i) || 
                       html.match(/name=["']anti-csrftoken-a2z["']\s*value=["']([^"']*)["']/i);
    const stateMatch = html.match(/name=["']serializedState["']\s*value=["']([^"']*)["']/i);

    let csrfToken = tokenMatch ? tokenMatch[1] : "";
    let serializedState = stateMatch ? stateMatch[1] : "";
    let cardSnippet = "";

    if (cardIndex !== -1) {
      cardSnippet = html.substring(Math.max(0, cardIndex - 2500), cardIndex + 6000);
      if (!csrfToken) {
        const m = cardSnippet.match(/name=["']csrfToken["']\s*value=["']([^"']*)["']/i);
        if (m) csrfToken = m[1];
      }
      if (!serializedState) {
        const sm = cardSnippet.match(/name=["']serializedState["']\s*value=["']([^"']*)["']/i);
        if (sm) serializedState = sm[1];
      }
    }

    if (!csrfToken) {
      console.error("❌ Error: Could not extract csrfToken for address deletion.");
      return false;
    }

    const formMatch = cardSnippet.match(/<form\b[^>]*action=["']([^"']+)["'][\s\S]*?<\/form>/i);
    const formHtml = formMatch ? formMatch[0] : cardSnippet;
    const formAction = formMatch ? decodeHtmlEntities(formMatch[1]) : "";
    const formData = {};
    const inputRegex = /<input\b[^>]*>/gi;
    let inputMatch;
    
    while ((inputMatch = inputRegex.exec(formHtml)) !== null) {
      const input = inputMatch[0];
      const nameMatch = input.match(/\bname=["']([^"']+)["']/i);
      if (!nameMatch) continue;
      const valueMatch = input.match(/\bvalue=["']([^"']*)["']/i);
      formData[decodeHtmlEntities(nameMatch[1])] = decodeHtmlEntities(valueMatch ? valueMatch[1] : "");
    }

    console.log(`Sending delete POST request for address ID: ${addressId}...`);
    const postData = {
      ...formData,
      addressID: addressId,
      addressAddressId: addressId,
      isStoreAddress: "false",
      csrfToken: csrfToken
    };
    if (serializedState) {
      postData.serializedState = serializedState;
    }

    const candidateUrls = [];
    if (formAction) {
      candidateUrls.push(formAction.startsWith("http") ? formAction : `https://www.amazon.in${formAction}`);
    }
    candidateUrls.push(
      "https://www.amazon.in/a/addresses/delete",
      "https://www.amazon.in/a/addresses/sadDelete"
    );

    for (const deleteUrl of Array.from(new Set(candidateUrls))) {
      const postResponse = await sendAuthorizedRequest({
        method: "POST",
        url: deleteUrl,
        data: querystring.stringify(postData),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Origin": "https://www.amazon.in",
          "Referer": listUrl
        }
      }, email);

      // Verify deletion
      const verifyResponse = await sendAuthorizedRequest({
        method: "GET",
        url: listUrl,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      }, email);
      
      const remainingIds = extractAddressIdsFromHtml(verifyResponse.data);
      if (!remainingIds.includes(addressId)) {
        console.log(`\n\x1b[32m✅ Success! Address ${addressId} was deleted successfully via API.\x1b[0m\n`);
        return true;
      }
      console.log(`Delete via ${deleteUrl} returned status ${postResponse.status}, but address still exists. Trying next method...`);
    }

    console.log("❌ Error: API deletion completed but address still exists.");
    return false;

  } catch (error) {
    if (error.message === "SESSION_EXPIRED") {
      process.exit(1);
    }
    console.error("❌ Address deletion failed:", error.message);
    return false;
  }
}

async function runAddressDeleteFast(html, addressId, email) {
  const listUrl = "https://www.amazon.in/a/addresses";
  const savedAddressIds = extractAddressIdsFromHtml(html);
  if (!savedAddressIds.includes(addressId)) {
    console.log(`\x1b[33m[SKIPPED] Address ${addressId} not found on Amazon addresses page.\x1b[0m`);
    return false;
  }

  const cardIndex = html.indexOf(addressId);
  const tokenMatch = html.match(/name=["']csrfToken["']\s*value=["']([^"']*)["']/i) || 
                     html.match(/name=["']anti-csrftoken-a2z["']\s*value=["']([^"']*)["']/i);
  const stateMatch = html.match(/name=["']serializedState["']\s*value=["']([^"']*)["']/i);

  let csrfToken = tokenMatch ? tokenMatch[1] : "";
  let serializedState = stateMatch ? stateMatch[1] : "";
  let cardSnippet = "";

  if (cardIndex !== -1) {
    cardSnippet = html.substring(Math.max(0, cardIndex - 2500), cardIndex + 6000);
    if (!csrfToken) {
      const m = cardSnippet.match(/name=["']csrfToken["']\s*value=["']([^"']*)["']/i);
      if (m) csrfToken = m[1];
    }
    if (!serializedState) {
      const sm = cardSnippet.match(/name=["']serializedState["']\s*value=["']([^"']*)["']/i);
      if (sm) serializedState = sm[1];
    }
  }

  if (!csrfToken) {
    console.error(`❌ Error: Could not extract csrfToken for address deletion of ${addressId}.`);
    return false;
  }

  const formMatch = cardSnippet.match(/<form\b[^>]*action=["']([^"']+)["'][\s\S]*?<\/form>/i);
  const formHtml = formMatch ? formMatch[0] : cardSnippet;
  const formAction = formMatch ? decodeHtmlEntities(formMatch[1]) : "";
  const formData = {};
  const inputRegex = /<input\b[^>]*>/gi;
  let inputMatch;
  
  while ((inputMatch = inputRegex.exec(formHtml)) !== null) {
    const input = inputMatch[0];
    const nameMatch = input.match(/\bname=["']([^"']+)["']/i);
    if (!nameMatch) continue;
    const valueMatch = input.match(/\bvalue=["']([^"']*)["']/i);
    formData[decodeHtmlEntities(nameMatch[1])] = decodeHtmlEntities(valueMatch ? valueMatch[1] : "");
  }

  console.log(`Sending delete POST request for address ID: ${addressId}...`);
  const postData = {
    ...formData,
    addressID: addressId,
    addressAddressId: addressId,
    isStoreAddress: "false",
    csrfToken: csrfToken
  };
  if (serializedState) {
    postData.serializedState = serializedState;
  }

  const candidateUrls = [];
  if (formAction) {
    candidateUrls.push(formAction.startsWith("http") ? formAction : `https://www.amazon.in${formAction}`);
  }
  candidateUrls.push(
    "https://www.amazon.in/a/addresses/delete",
    "https://www.amazon.in/a/addresses/sadDelete"
  );

  const deleteUrl = candidateUrls[0];
  try {
    await sendAuthorizedRequest({
      method: "POST",
      url: deleteUrl,
      data: querystring.stringify(postData),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.amazon.in",
        "Referer": listUrl
      }
    }, email);
    return true;
  } catch (error) {
    console.error(`❌ Failed to send delete POST for ${addressId}:`, error.message);
    return false;
  }
}

async function main() {
  const config = parseArgs();
  if (config.help || !config.addressId) {
    console.log(`
Usage:
  node delete_address.js <addressAddressId or "all"> [options]

Options:
  --email <email>     Specify Amazon email
  --help, -h          Show help

Examples:
  node delete_address.js B0CDXYZ123
  node delete_address.js all
`);
    process.exit(config.help ? 0 : 1);
  }

  const email = cookiesHelper.getActiveEmail(config.email);
  if (!email) {
    console.error("❌ Error: Active email could not be determined. Set in credentials.json or pass --email.");
    process.exit(1);
  }

  if (config.addressId.toLowerCase() === "all") {
    console.log(`Fetching addresses for ${email} to delete all...`);
    try {
      const listUrl = "https://www.amazon.in/a/addresses";
      const response = await sendAuthorizedRequest({
        method: "GET",
        url: listUrl,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      }, email);
      
      const html = response.data;
      const addressIds = extractAddressIdsFromHtml(html);
      if (addressIds.length === 0) {
        console.log("No saved addresses found to delete.");
        process.exit(0);
      }
      
      console.log(`Found ${addressIds.length} addresses. Deleting sequentially...`);
      for (const addressId of addressIds) {
        await runAddressDeleteFast(html, addressId, email);
      }
      
      console.log("Verifying deletions...");
      const verifyResponse = await sendAuthorizedRequest({
        method: "GET",
        url: listUrl,
        headers: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      }, email);
      
      const remainingIds = extractAddressIdsFromHtml(verifyResponse.data);
      const deletedCount = addressIds.length - remainingIds.length;
      console.log(`\n\x1b[32m✅ Completed. Deleted ${deletedCount}/${addressIds.length} addresses. (Remaining: ${remainingIds.length})\x1b[0m\n`);
      process.exit(0);
    } catch (err) {
      if (err.message === "SESSION_EXPIRED") process.exit(1);
      console.error("❌ Failed to delete all addresses:", err.message);
      process.exit(1);
    }
  } else {
    const success = await runAddressDelete(config.addressId, email);
    if (!success) process.exit(1);
    process.exit(0);
  }
}

main();
