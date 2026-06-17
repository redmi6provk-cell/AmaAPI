const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const { sendAuthorizedRequest } = require("./request_helper");
const cookiesHelper = require("./cookies");

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseForm(html, searchStr) {
  const idx = html.toLowerCase().indexOf(searchStr.toLowerCase());
  if (idx === -1) return null;
  
  const formStart = html.lastIndexOf("<form", idx);
  if (formStart === -1) return null;
  
  const tagEnd = html.indexOf(">", formStart);
  const formTag = html.substring(formStart, tagEnd + 1);
  
  const actionMatch = formTag.match(/action=["']([^"']*)["']/i);
  const methodMatch = formTag.match(/method=["']([^"']*)["']/i);
  const action = actionMatch ? decodeHtmlEntities(actionMatch[1]) : "";
  const method = methodMatch ? methodMatch[1].toLowerCase() : "get";
  
  const formEnd = html.indexOf("</form>", formStart);
  const innerHtml = formEnd !== -1 ? html.substring(tagEnd + 1, formEnd) : html.substring(tagEnd + 1);
  
  const inputs = {};
  const inputRegex = /<input([^>]*?)>/gi;
  let m;
  while ((m = inputRegex.exec(innerHtml)) !== null) {
    const attrs = m[1];
    const nameMatch = attrs.match(/name=["']([^"']*)["']/i);
    if (nameMatch) {
      const name = nameMatch[1];
      const typeMatch = attrs.match(/type=["']([^"']*)["']/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : "text";
      
      if (type === "submit") continue;
      if ((type === "radio" || type === "checkbox") && !attrs.match(/\bchecked\b/i)) continue;
      
      const valueMatch = attrs.match(/value=["']([^"']*)["']/i);
      const value = valueMatch ? decodeHtmlEntities(valueMatch[1]) : "";
      inputs[name] = value;
    }
  }
  
  return { action, method, inputs };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    fullName: null,
    phone: null,
    pin: null,
    line1: null,
    line2: null,
    city: null,
    state: null,
    landmark: "",
    email: null,
    help: false
  };

  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email") {
      config.email = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      config.help = true;
    } else if (args[i] === "--headless") {
      // Ignore in API-only mode
    } else {
      positionals.push(args[i]);
    }
  }

  if (positionals.length >= 7) {
    config.fullName = positionals[0];
    config.phone = positionals[1];
    config.pin = positionals[2];
    config.line1 = positionals[3];
    config.line2 = positionals[4];
    config.city = positionals[5];
    config.state = positionals[6];
    if (positionals.length > 7) {
      config.landmark = positionals[7];
    }
  }

  return config;
}

const REAL_NAMES = [
  "Aarav", "Vihaan", "Arjun", "Aditya", "Rohan", "Karan", "Rahul", "Vikram", "Siddharth", "Aryan",
  "Kabir", "Dev", "Ishaan", "Yash", "Ayaan", "Aniket", "Nikhil", "Varun", "Manav", "Shivam",
  "Pranav", "Harsh", "Amit", "Akash", "Rajat", "Saurabh", "Abhishek", "Deepak", "Nitin", "Gaurav",
  "Rakesh", "Sameer", "Ajay", "Vivek", "Mohit", "Pankaj", "Uday", "Tarun", "Ravindra", "Ashwin",
  "Krishna", "Omkar", "Dhruv", "Parth", "Ritvik", "Laksh", "Tanish", "Neil", "Reyansh", "Vedant","Ashutosh"
];

function getRandomRealName() {
  const idx = Math.floor(Math.random() * REAL_NAMES.length);
  return REAL_NAMES[idx];
}

function generateRandomNumber(length) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += Math.floor(Math.random() * 10);
  }
  if (result.startsWith("0") && length > 1) {
    result = "1" + result.slice(1);
  }
  return result || "1";
}

function randomizeBrackets(text, isNameField) {
  if (!text) return "";
  const regex = /\(([^)]+)\)/g;
  return text.replace(regex, (match, p1) => {
    if (isNameField) {
      return getRandomRealName();
    } else {
      if (/^\d+$/.test(p1)) {
        return generateRandomNumber(p1.length);
      } else {
        return generateRandomNumber(p1.length > 0 ? p1.length : 3);
      }
    }
  });
}

async function main() {
  const config = parseArgs();
  
  if (config.help) {
    console.log(`
Usage:
  node add_address.js "<Name>" "<Phone>" "<Pincode>" "<Address Line 1>" "<Address Line 2>" "<City>" "<State>" "[Landmark]" [options]

If no arguments are provided, it tries to load address details from address_input.json.

Options:
  --email <email>     Specify Amazon email
  --help, -h          Show help

Examples:
  node add_address.js "Kabir Jalaram" "6266645965" "400009" "123 Ramya House" "Masjid Bunder" "Mumbai" "Maharashtra" "Chinchbunder"
  node add_address.js
`);
    process.exit(0);
  }

  const email = cookiesHelper.getActiveEmail(config.email);
  if (!email) {
    console.error("❌ Error: Active email could not be determined. Set in credentials.json or pass --email.");
    process.exit(1);
  }

  let { fullName, phone, pin, line1, line2, city, state, landmark } = config;
  
  if (!fullName) {
    console.log("No arguments passed. Checking for address_input.json...");
    const filePath = path.join(__dirname, "address_input.json");
    if (fs.existsSync(filePath)) {
      try {
        const addressInput = JSON.parse(fs.readFileSync(filePath, "utf8"));
        fullName = addressInput.fullName;
        phone = addressInput.phone;
        pin = addressInput.pin;
        line1 = addressInput.line1;
        line2 = addressInput.line2;
        city = addressInput.city;
        state = addressInput.state;
        landmark = addressInput.landmark || "";
        console.log(`Loaded details from address_input.json: ${fullName} (${phone})`);
      } catch (e) {
        console.error("❌ Error parsing address_input.json:", e.message);
        process.exit(1);
      }
    } else {
      console.error("❌ Error: Missing address parameters and address_input.json not found.");
      process.exit(1);
    }
  }

  // Randomize bracket contents (kabir) -> Random string, (123) -> Random number
  fullName = randomizeBrackets(fullName, true);
  line1 = randomizeBrackets(line1, false);
  line2 = randomizeBrackets(line2, false);

  console.log(`Adding address for: ${fullName} (${phone}) via API...`);

  try {
    const getUrl = "https://www.amazon.in/a/addresses/add?ref=ya_address_book_add_button";
    const getResponse = await sendAuthorizedRequest({
      method: "GET",
      url: getUrl,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    }, email);
    
    const html = getResponse.data;
    const form = parseForm(html, "address-ui-widgets-enterAddressFullName");
    if (!form) {
      console.error("❌ Error: Could not find add address form on the page.");
      process.exit(1);
    }
    
    const postData = { ...form.inputs };
    
    postData["address-ui-widgets-enterAddressFullName"] = fullName;
    postData["address-ui-widgets-enterAddressPhoneNumber"] = phone;
    postData["address-ui-widgets-enterAddressPostalCode"] = pin;
    postData["address-ui-widgets-enterAddressLine1"] = line1;
    postData["address-ui-widgets-enterAddressLine2"] = line2;
    postData["address-ui-widgets-landmark"] = landmark || "";
    postData["address-ui-widgets-enterAddressCity"] = city;
    postData["address-ui-widgets-enterAddressStateOrRegion"] = state.toUpperCase();
    postData["address-ui-widgets-countryCode"] = "IN";
    postData["address-ui-widgets-use-as-my-default"] = "true";
    postData["address-ui-widgets-addressFormButtonText"] = "save";
    
    // Suppress AVS warnings/soft-blocks programmatically
    postData["address-ui-widgets-avsSuppressSoftblock"] = "true";
    postData["address-ui-widgets-avsSuppressSuggestion"] = "true";
    
    // Extract CSRF token
    const tokenMatch = html.match(/name=["']csrfToken["']\s*value=["']([^"']*)["']/i) || 
                       html.match(/name=["']anti-csrftoken-a2z["']\s*value=["']([^"']*)["']/i);
    const csrfToken = tokenMatch ? tokenMatch[1] : "";
    if (csrfToken) {
      postData["csrfToken"] = csrfToken;
    }
    
    const postUrl = form.action.startsWith("http") ? form.action : `https://www.amazon.in${form.action}`;
    
    const postResponse = await sendAuthorizedRequest({
      method: "POST",
      url: postUrl,
      data: querystring.stringify(postData),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.amazon.in",
        "Referer": getUrl
      },
      maxRedirects: 10,
      validateStatus: s => s >= 200 && s < 500
    }, email);
    
    const responseHtml = postResponse.data;
    const finalUrl = postResponse.headers?.location || postResponse.request?.res?.responseUrl || "";
    
    const success = finalUrl.includes("/a/addresses") || 
                    responseHtml.includes("ya_ab_address_added") || 
                    responseHtml.includes("yaab-enterAddressSucceed");

    if (success) {
      console.log("\n\x1b[32m✅ Success! Address successfully added programmatically.\x1b[0m\n");
      process.exit(0);
    } else {
      fs.writeFileSync(path.join(__dirname, "debug_address_add_failed.html"), responseHtml, "utf8");
      console.error(`❌ Address addition failed. Saved debug_address_add_failed.html. Final URL: ${finalUrl}`);
      process.exit(1);
    }

  } catch (error) {
    if (error.message === "SESSION_EXPIRED") {
      process.exit(1);
    }
    console.error("❌ Address add failed:", error.message);
    process.exit(1);
  }
}

main();
