const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { ImapFlow } = require("imapflow");
const cookiesHelper = require("./cookies");
const googleSheets = require("./google_sheets");

let db = null;
if (fs.existsSync(path.join(__dirname, "db_config.json"))) {
  try {
    db = require("./db");
  } catch (e) {}
}

// ==================== CONFIGURATION ====================
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const OTP_INITIAL_WAIT_MS = 30000; // 30 seconds wait before first IMAP check

// ==================== CLI ARGUMENT PARSING ====================
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    headless: false,
    email: null,
    password: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        config.help = true;
        break;
      case "--headless":
        config.headless = true;
        break;
      case "--email":
        config.email = args[++i];
        break;
      case "--password":
        config.password = args[++i];
        break;
    }
  }
  return config;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║                Amazon Cookie Refresher                   ║
╚══════════════════════════════════════════════════════════╝

Usage:
  node get_cookies.js [options]

Options:
  --help, -h          Show this help message
  --headless          Run browser in headless mode (invisible)
  --email <email>     Process a specific email address
  --password <pass>   Override password for this email

Examples:
  node get_cookies.js                          Login default email from credentials.json
  node get_cookies.js --email test@example.com Login specific email
`);
}

// ==================== IMAP OTP FUNCTIONS ====================
function extractOtpFromEmail(rawEmail) {
  if (!rawEmail) return null;

  // 1. Decode base64 or quoted-printable boundaries if present to get clean HTML/Plaintext
  let decodedText = "";
  const boundaryMatch = rawEmail.match(/boundary="?([^"\s;]+)"?/i) || rawEmail.match(/boundary=([^;\s\r\n]+)/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1].replace(/["']/g, "");
    const parts = rawEmail.split(`--${boundary}`);
    for (const part of parts) {
      const hasHeader = part.toLowerCase().includes("content-type: text/html") || part.toLowerCase().includes("content-type: text/plain");
      if (hasHeader) {
        const bodyStartIndex = part.indexOf("\r\n\r\n");
        if (bodyStartIndex !== -1) {
          let body = part.substring(bodyStartIndex + 4);
          body = body.split(`--${boundary}`)[0];
          body = body.replace(/--\s*$/, "");
          
          if (part.toLowerCase().includes("content-transfer-encoding: base64")) {
            try {
              body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
            } catch (e) {}
          } else if (part.toLowerCase().includes("content-transfer-encoding: quoted-printable")) {
            body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          }
          decodedText += body + "\n";
        }
      }
    }
  } else {
    decodedText = rawEmail;
  }

  if (!decodedText.trim()) {
    decodedText = rawEmail;
  }

  // 2. Clean style sheets and HTML tags to prevent hex/CSS color codes matching
  let cleaned = decodedText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  cleaned = cleaned.replace(/<[^>]*>/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ");

  // 3. Search for known OTP context patterns in the cleaned text
  const patterns = [
    /your\s*verification\s*code\s*is:?\s*(\b\d{6}\b)/i,
    /one\s*time\s*password\s*\(otp\)\s*is:?\s*(\b\d{6}\b)/i,
    /otp:?\s*(\b\d{6}\b)/i,
    /verification\s*code:?\s*(\b\d{6}\b)/i,
    /enter\s*the\s*following\s*code\s*to\s*verify.*?:?\s*(\b\d{6}\b)/i,
    /use\s*the\s*following\s*one\s*time\s*password\s*\(otp\):\s*:?(\b\d{6}\b)/i,
    /(\b\d{6}\b)\s*is\s*your\s*amazon/i,
    /(\b\d{6}\b)\s*is\s*your\s*one\s*time\s*password/i
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      const code = match[1];
      if (code !== "000000" && code !== "303333" && code !== "565959" && code !== "007185" && code !== "252626") {
        return code;
      }
    }
  }

  // 4. Fallback: search for any non-dummy 6-digit code after cleaning
  const allMatches = cleaned.match(/\b\d{6}\b/g) || [];
  for (const code of allMatches) {
    if (
      code !== "000000" &&
      code !== "303333" &&
      code !== "565959" &&
      code !== "007185" &&
      code !== "252626" &&
      !code.startsWith("202") &&
      !code.startsWith("199")
    ) {
      return code;
    }
  }

  return null;
}

function isEmailTargetedTo(msg, targetEmail) {
  if (!targetEmail) return true;
  const normalizedTarget = targetEmail.toLowerCase().trim();

  // Check raw source first for maximum reliability on sub-addresses (aliases)
  if (msg.source) {
    const rawEmailStr = msg.source.toString().toLowerCase();
    if (rawEmailStr.includes(normalizedTarget)) {
      return true;
    }
  }

  // 1. Check envelope TO
  const envelopeTo = msg.envelope?.to || [];
  for (const addr of envelopeTo) {
    if (addr.address) {
      const emailPart = addr.address.toLowerCase().trim();
      if (emailPart === normalizedTarget || emailPart.includes(normalizedTarget)) {
        return true;
      }
    }
  }

  // 2. Check envelope CC
  const envelopeCc = msg.envelope?.cc || [];
  for (const addr of envelopeCc) {
    if (addr.address) {
      const emailPart = addr.address.toLowerCase().trim();
      if (emailPart === normalizedTarget || emailPart.includes(normalizedTarget)) {
        return true;
      }
    }
  }

  // 3. Check parsed headers
  if (msg.headers) {
    const headersStr = msg.headers.toString();
    const headerLines = headersStr.split(/\r?\n/);
    for (const line of headerLines) {
      const lowerLine = line.toLowerCase();
      if (
        lowerLine.startsWith("to:") ||
        lowerLine.startsWith("cc:") ||
        lowerLine.startsWith("delivered-to:") ||
        lowerLine.startsWith("x-original-to:") ||
        lowerLine.startsWith("envelope-to:")
      ) {
        if (lowerLine.includes(normalizedTarget)) {
          return true;
        }
      }
    }
  }

  // 4. Fallback check: Check msg.source headers
  if (msg.source) {
    const rawEmailStr = msg.source.toString();
    const headersEnd = rawEmailStr.indexOf("\r\n\r\n");
    const headers = headersEnd !== -1 ? rawEmailStr.substring(0, headersEnd) : rawEmailStr;
    const headerLines = headers.split(/\r?\n/);
    for (const line of headerLines) {
      const lowerLine = line.toLowerCase();
      if (
        lowerLine.startsWith("to:") ||
        lowerLine.startsWith("cc:") ||
        lowerLine.startsWith("delivered-to:") ||
        lowerLine.startsWith("x-original-to:") ||
        lowerLine.startsWith("envelope-to:")
      ) {
        if (lowerLine.includes(normalizedTarget)) {
          return true;
        }
      }
    }
  }

  return false;
}

async function fetchAmazonOtp(imapConfig, targetEmail) {
  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port || 993,
    secure: imapConfig.secure !== undefined ? imapConfig.secure : true,
    auth: {
      user: imapConfig.user,
      pass: imapConfig.password
    },
    logger: false
  });

  await client.connect();
  let lock = await client.getMailboxLock("INBOX");
  try {
    if (client.mailbox.exists === 0) {
      return null;
    }

    const totalEmails = client.mailbox.exists;
    const startRange = Math.max(1, totalEmails - 15); // Check last 15 emails to handle high concurrency
    const range = `${startRange}:${totalEmails}`;
    
    const messages = [];
    for await (let msg of client.fetch(range, { envelope: true, headers: true, source: true, flags: true })) {
      messages.push(msg);
    }
    
    messages.sort((a, b) => b.seq - a.seq);

    // Pass 1: Look for UNSEEN Amazon emails targeted to our account
    for (const msg of messages) {
      const from = msg.envelope?.from?.[0]?.address || "";
      const subject = msg.envelope?.subject || "";
      const flags = msg.flags ? [...msg.flags] : [];
      const isSeen = flags.includes("\\Seen");
      
      if (isSeen) continue;

      const isAmazon = from.toLowerCase().includes("amazon") || 
                       subject.toLowerCase().includes("amazon");
      if (!isAmazon) continue;

      if (!isEmailTargetedTo(msg, targetEmail)) continue;

      const rawEmail = msg.source ? msg.source.toString() : "";
      const otp = extractOtpFromEmail(rawEmail);
      if (otp) {
        console.log(`    📧 Found OTP in UNSEEN email: "${subject}" for ${targetEmail}`);
        try {
          await client.messageFlagsAdd(msg.seq, ["\\Seen"]);
        } catch (e) {}
        return otp;
      }
    }

    // Pass 2: Look for Seen Amazon emails (last 2 minutes) targeted to our account
    for (const msg of messages) {
      const from = msg.envelope?.from?.[0]?.address || "";
      const subject = msg.envelope?.subject || "";
      const flags = msg.flags ? [...msg.flags] : [];
      const isSeen = flags.includes("\\Seen");
      
      if (!isSeen) continue;

      const isAmazon = from.toLowerCase().includes("amazon") || 
                       subject.toLowerCase().includes("amazon");
      if (!isAmazon) continue;

      const date = msg.envelope?.date;
      if (date && (Date.now() - new Date(date).getTime()) > 120000) {
        continue;
      }

      if (!isEmailTargetedTo(msg, targetEmail)) continue;

      const rawEmail = msg.source ? msg.source.toString() : "";
      const otp = extractOtpFromEmail(rawEmail);
      if (otp) {
        console.log(`    📧 Found OTP in recent seen email: "${subject}" for ${targetEmail}`);
        return otp;
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return null;
}

async function pollForAmazonOtp(imapConfig, targetEmail, timeoutMs = 120000, intervalMs = 5000) {
  const startTime = Date.now();
  console.log(`    ⏳ Waiting ${OTP_INITIAL_WAIT_MS / 1000}s for Amazon to send OTP email to ${targetEmail}...`);
  await new Promise(resolve => setTimeout(resolve, OTP_INITIAL_WAIT_MS));
  console.log(`    ⏳ Now checking IMAP inbox for Amazon OTP sent to ${targetEmail}...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const otp = await fetchAmazonOtp(imapConfig, targetEmail);
      if (otp) {
        console.log(`    ✅ Found OTP: ${otp} for ${targetEmail}`);
        return otp;
      }
    } catch (e) {
      console.warn(`    ⚠️ IMAP error for ${targetEmail}: ${e.message}`);
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`    ⏳ Waiting for OTP email... (${elapsed}s elapsed) for ${targetEmail}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  console.log(`    ❌ OTP timeout - could not retrieve code from email for ${targetEmail}.`);
  return null;
}

// ==================== OTP HANDLER ====================
async function handleOtpInput(page, selector, imapConfig, targetEmail) {
  console.log(`    🔑 OTP prompt detected for ${targetEmail}.`);

  if (!imapConfig || !imapConfig.host) {
    console.log(`    ⚠️ No IMAP config found. Please type OTP manually in the browser window for ${targetEmail}.`);
    return false;
  }

  console.log(`    📧 Fetching OTP via IMAP for ${targetEmail}...`);
  const otp = await pollForAmazonOtp(imapConfig, targetEmail);
  
  if (otp) {
    await page.type(selector, otp, { delay: 100 });
    await new Promise(r => setTimeout(r, 1000));
    
    const submitClicked = await page.evaluate(() => {
      const selectors = [
        "input[aria-labelledby='cvf-submit-otp-button-announce']",
        "#cvf-submit-code-button",
        "#auth-signin-button",
        "#cvf-submit-button input[type='submit']",
        "input[type='submit'][aria-labelledby]",
        ".a-button-input[type='submit']",
        "input[type='submit']",
        "button[type='submit']"
      ];
      
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.click();
          return sel;
        }
      }
      
      const allButtons = document.querySelectorAll("input[type='submit'], button, .a-button-input");
      for (const btn of allButtons) {
        const text = (btn.value || btn.textContent || "").toLowerCase();
        if ((text.includes("submit") || text.includes("verify") || text.includes("code")) && btn.offsetParent !== null) {
          btn.click();
          return "fallback-button";
        }
      }
      return null;
    });
    
    if (submitClicked) {
      console.log(`    ✅ OTP submitted via JS click (${submitClicked}).`);
    } else {
      try {
        const btn = await page.waitForSelector("input[type='submit']", { visible: true, timeout: 3000 });
        if (btn) {
          await btn.click();
          console.log("    ✅ OTP submitted via puppeteer click.");
        }
      } catch (clickErr) {
        console.log("    ⚠️ Could not click submit button. OTP might work if auto-submitted.");
      }
    }
    return true;
  } else {
    console.log("    ❌ Could not fetch OTP. Please enter it manually in the browser window.");
    return false;
  }
}

// Password reset handler removed.
async function detectState(page, timeoutMs = 8000) {
  return Promise.any([
    page.waitForSelector("#ap_email", { visible: true, timeout: timeoutMs }).then(() => ({ type: "email", selector: "#ap_email" })),
    page.waitForSelector("#ap_email_login", { visible: true, timeout: timeoutMs }).then(() => ({ type: "email", selector: "#ap_email_login" })),
    page.waitForSelector("input[name='email']", { visible: true, timeout: timeoutMs }).then(() => ({ type: "email", selector: "input[name='email']" })),
    page.waitForSelector("#ap_password", { visible: true, timeout: timeoutMs }).then(() => ({ type: "password", selector: "#ap_password" })),
    page.waitForSelector("input[name='password']", { visible: true, timeout: timeoutMs }).then(() => ({ type: "password", selector: "input[name='password']" })),
    page.waitForSelector("#input-box-otp", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "#input-box-otp" })),
    page.waitForSelector("#auth-mfa-otpcode", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "#auth-mfa-otpcode" })),
    page.waitForSelector("#cvf-widget-input-code", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "#cvf-widget-input-code" })),
    page.waitForSelector("#cvf-input-code", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "#cvf-input-code" })),
    page.waitForSelector("input[name='otpCode']", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "input[name='otpCode']" })),
    page.waitForSelector("input[name='code']", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "input[name='code']" })),
    page.waitForSelector("input#cvf-a-input", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "input#cvf-a-input" })),
    page.waitForSelector("#cvf-otp-input", { visible: true, timeout: timeoutMs }).then(() => ({ type: "otp", selector: "#cvf-otp-input" })),
    page.waitForSelector("a[data-name='switch_account_request'], #cvf-account-switcher-add-accounts-link", { visible: true, timeout: timeoutMs }).then(() => ({ type: "switch_accounts" })),
    page.waitForSelector("#address-ui-widgets-enterAddressFullName", { visible: true, timeout: timeoutMs }).then(() => ({ type: "success" }))
  ]).catch(() => null);
}
async function safeClick(page, selector, label = "") {
  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return "not_found";
    
    el.scrollIntoView({ block: "center" });
    
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (e) {}
    
    try { el.click(); } catch (e) {}
    
    return "clicked";
  }, selector);

  if (result === "not_found") {
    try {
      await page.click(selector);
      if (label) console.log(`    ➡️ ${label}`);
      return true;
    } catch (e) {
      console.warn(`    ⚠️ Click failed for ${selector}: ${e.message}`);
      return false;
    }
  }

  if (label) console.log(`    ➡️ ${label} (${result})`);
  return true;
}

// ==================== CAPTCHA & ERROR CHECKER ====================
async function checkForCaptchaAndErrors(page, isHeadless, skipAuthError = false) {
  // Check for Captcha / Puzzle / CVF challenges

  // Check for Captcha / Puzzle / CVF challenges
  const captchaDetected = await page.evaluate(() => {
    const url = window.location.href.toLowerCase();
    
    // If there is an active OTP input field visible, it's not a captcha challenge (or it is already solved)
    const otpSelectors = [
      "#input-box-otp",
      "#auth-mfa-otpcode",
      "#cvf-widget-input-code",
      "#cvf-input-code",
      "input[name='otpCode']",
      "input[name='code']",
      "input#cvf-a-input",
      "#cvf-otp-input",
      ".cvf-widget-input-code"
    ];
    for (const sel of otpSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return false;
      }
    }

    if (url.includes("captcha") || url.includes("puzzle")) return true;
    if (url.includes("/cvf/")) {
      // If we are on /cvf/ page and don't have the OTP input field, it is a captcha/challenge
      if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return true;
      if (document.querySelector("iframe[title*='verification']")) return true;
      const text = document.body ? (document.body.innerText || "") : "";
      if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
      return true;
    }
    if (document.querySelector("input[placeholder='Type characters']")) return true;
    if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return true;
    if (document.querySelector("iframe[title*='verification']")) return true;
    if (document.title && document.title.toLowerCase().includes("authentication required")) return true;
    const text = document.body ? (document.body.innerText || "") : "";
    if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
    return false;
  });

  if (captchaDetected) {
    if (isHeadless) {
      throw new Error("RELAUNCH_HEADED");
    } else {
      console.log("\n    ⚠️ [!] ALERT: CAPTCHA/Puzzle/Verification Challenge Detected! Please solve it manually in the browser window.");
      console.log("    Waiting for manual captcha solution...");
      
      const startTime = Date.now();
      let stillCaptcha = true;
      while (stillCaptcha && (Date.now() - startTime < 300000)) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          stillCaptcha = await page.evaluate(() => {
            const url = window.location.href.toLowerCase();
            
            // If there is an active OTP input field visible, it's not a captcha challenge
            const otpSelectors = [
              "#input-box-otp",
              "#auth-mfa-otpcode",
              "#cvf-widget-input-code",
              "#cvf-input-code",
              "input[name='otpCode']",
              "input[name='code']",
              "input#cvf-a-input",
              "#cvf-otp-input",
              ".cvf-widget-input-code"
            ];
            for (const sel of otpSelectors) {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null) {
                return false;
              }
            }

            if (url.includes("captcha") || url.includes("puzzle")) return true;
            if (url.includes("/cvf/")) {
              if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return true;
              if (document.querySelector("iframe[title*='verification']")) return true;
              const text = document.body ? (document.body.innerText || "") : "";
              if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
              return true;
            }
            if (document.querySelector("input[placeholder='Type characters']")) return true;
            if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return true;
            if (document.querySelector("iframe[title*='verification']")) return true;
            if (document.title && document.title.toLowerCase().includes("authentication required")) return true;
            const text = document.body ? (document.body.innerText || "") : "";
            if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
            return false;
          });
        } catch (e) {
          // If evaluation fails (e.g., page navigates), assume captcha is gone
          stillCaptcha = false;
        }
      }
      console.log("    ✅ Captcha resolved! Continuing login flow...");
    }
  }

  // Check for Amazon auth error messages (wrong password, account locked, etc.)
  const authError = await page.evaluate(() => {
    const box = document.querySelector("#auth-error-message-box");
    if (box && box.offsetParent !== null) {
      return box.innerText.trim();
    }
    const alertBox = document.querySelector(".a-alert-error");
    if (alertBox && alertBox.offsetParent !== null) {
      return alertBox.innerText.trim();
    }
    const alertHeading = document.querySelector(".a-alert-heading");
    if (alertHeading && alertHeading.offsetParent !== null && alertHeading.textContent.includes("Important Message")) {
      const p = alertHeading.closest(".a-alert-container") || alertHeading.parentElement;
      return p ? p.innerText.trim() : alertHeading.textContent.trim();
    }
    return null;
  });

  if (authError && !skipAuthError) {
    throw new Error(`AMAZON_AUTH_ERROR: ${authError}`);
  }

  // Check for Password Reset Required pages
  const passwordResetDetected = await page.evaluate(() => {
    const text = document.body ? (document.body.innerText || "") : "";
    const url = window.location.href.toLowerCase();
    if (url.includes("passwordreset") || url.includes("/forgotpassword/") || url.includes("/cnp/")) {
      return true;
    }
    if (
      text.includes("Password reset required") ||
      text.includes("Please set a new password") ||
      text.includes("Choose a new password") ||
      text.includes("password reset is required") ||
      text.includes("It looks like you are new to Amazon") ||
      text.includes("create an account using your mobile number") ||
      text.includes("Proceed to create an account")
    ) {
      return true;
    }
    return false;
  });

  if (passwordResetDetected) {
    throw new Error("PASSWORD_RESET_REQUIRED");
  }
}

// ==================== LOGIN FLOW ====================
async function main() {
  const config = parseArgs();
  let hasFailed = false;
  if (config.help) {
    printHelp();
    process.exit(0);
  }

  // Determine emails to process
  let emailsToProcess = [];
  const currentUserId = cookiesHelper.getActiveUserId();

  if (config.email) {
    emailsToProcess = [config.email];
  } else if (db) {
    try {
      // Fetch all accounts for the active user
      const accounts = await db.getAccountsByUser(currentUserId);
      if (accounts && accounts.length > 0) {
        // Find accounts that are missing cookies in the database
        for (const accEmail of accounts) {
          const cookies = await db.getCookies(currentUserId, accEmail);
          if (!cookies || cookies.length === 0) {
            emailsToProcess.push(accEmail);
          }
        }
        if (emailsToProcess.length > 0) {
          console.log(`🔍 Found ${emailsToProcess.length} account(s) missing cookies in the database.`);
        } else {
          console.log("✅ All database accounts already have cookies saved. If you want to refresh a specific one, pass --email <email>.");
        }
      }
    } catch (err) {
      console.warn("⚠️ Error checking database accounts:", err.message);
    }
  }

  // Fallback if no specific email and no DB accounts need processing
  if (emailsToProcess.length === 0) {
    let fallbackEmail = null;
    if (fs.existsSync(path.join(__dirname, "credentials.json"))) {
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "credentials.json"), "utf8"));
        fallbackEmail = creds.email;
      } catch (e) {}
    }
    if (fallbackEmail) {
      emailsToProcess = [fallbackEmail];
    }
  }

  if (emailsToProcess.length === 0) {
    console.error("❌ Error: No accounts to process. Please specify --email or add accounts via the database/credentials.json.");
    process.exit(1);
  }

  for (let i = 0; i < emailsToProcess.length; i++) {
    const email = emailsToProcess[i];
    console.log(`\n┌─────────────────────────────────────────────────────────┐`);
    console.log(`│  [${i + 1}/${emailsToProcess.length}] Processing login for: ${email}`);
    console.log(`└─────────────────────────────────────────────────────────┘`);

    let passwordsToTry = [];
    let dbUser = null;
    if (config.password) {
      passwordsToTry.push(config.password);
    }

    if (db) {
      try {
        // Load all unique passwords from users table
        const allUsersRes = await db.pool.query('SELECT DISTINCT amazon_password FROM users WHERE amazon_password IS NOT NULL AND amazon_password != $1', ['']);
        const dbPasswords = allUsersRes.rows.map(r => r.amazon_password);

        dbUser = null;
        const parts = email.split('@');
        if (parts.length === 2) {
          const baseEmail = `${parts[0].split('+')[0]}@${parts[1]}`;
          dbUser = await db.getUserByEmail(baseEmail);
        }
        
        if (!dbUser || !dbUser.amazonPassword) {
          dbUser = await db.getUserByEmailOrAccountEmail(email);
        }
        
        if (!dbUser || !dbUser.amazonPassword) {
          dbUser = await db.getUser(currentUserId);
        }
        
        if (dbUser && dbUser.amazonPassword) {
          passwordsToTry.push(dbUser.amazonPassword);
          console.log(`🔒 Loaded primary Amazon password from database for user ID ${dbUser.id}.`);
        }

        // Add other passwords as fallbacks
        dbPasswords.forEach(p => {
          if (p && !passwordsToTry.includes(p)) {
            passwordsToTry.push(p);
          }
        });
      } catch (err) {
        console.warn("Could not query credentials from DB:", err.message);
      }
    }

    if (fs.existsSync(path.join(__dirname, "credentials.json"))) {
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "credentials.json"), "utf8"));
        if (creds.email === email && creds.password) {
          if (!passwordsToTry.includes(creds.password)) {
            passwordsToTry.push(creds.password);
            console.log("🔒 Loaded Amazon password from credentials.json.");
          }
        }
      } catch (e) {}
    }

    if (!passwordsToTry.includes("112233")) {
      passwordsToTry.push("112233");
      console.log("🔒 Added fallback password '112233' to try list.");
    }

    if (passwordsToTry.length === 0) {
      console.error(`❌ Error: Missing password for ${email}. Skipping.`);
      continue;
    }

    // Load IMAP config if exists
    let imapConfig = null;
    if (db) {
      try {
        let imapUser = null;
        const parts = email.split('@');
        if (parts.length === 2) {
          const baseEmail = `${parts[0].split('+')[0]}@${parts[1]}`;
          imapUser = await db.getUserByEmail(baseEmail);
        }
        if (!imapUser) {
          imapUser = await db.getUserByEmailOrAccountEmail(email);
        }
        if (!imapUser || !imapUser.imapConfig || !imapUser.imapConfig.host) {
          imapUser = await db.getUser(currentUserId);
        }
        if (imapUser && imapUser.imapConfig && imapUser.imapConfig.host) {
          imapConfig = imapUser.imapConfig;
          console.log(`📧 Loaded IMAP configuration from database for user ID ${imapUser.id}.`);
        }
      } catch (err) {
        console.warn("Could not query IMAP from DB:", err.message);
      }
    }

    if (!imapConfig && fs.existsSync(path.join(__dirname, "imap.json"))) {
      try {
        imapConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "imap.json"), "utf8"));
      } catch (e) {
        console.warn("Could not parse imap.json:", e.message);
      }
    }

    let passwordIndex = 0;
    const runLoginFlow = async (currentHeadless) => {
      const password = passwordsToTry[passwordIndex];
      console.log(`🚀 Launching browser for: ${email} (headless: ${currentHeadless}) using password ${passwordIndex + 1}/${passwordsToTry.length}`);
      const browser = await puppeteer.launch({
        headless: currentHeadless,
        defaultViewport: null,
        args: ["--start-maximized"]
      });

      let page = null;
      try {
        page = await browser.newPage();
        try {
          const client = await page.target().createCDPSession();
          await client.send('WebAuthn.enable');
          await client.send('WebAuthn.addVirtualAuthenticator', {
            config: {
              protocol: 'ctap2',
              transport: 'usb',
              hasResidentKey: true,
              hasUserVerification: true,
              isUserVerified: true
            }
          });
        } catch (_) {}
        await page.setUserAgent(USER_AGENT);

        // Inject existing cookies if present
        const existingCookies = await cookiesHelper.readCookies(email);
        if (existingCookies && existingCookies.length > 0) {
          await page.setCookie(...existingCookies);
          console.log(`    📦 Injected ${existingCookies.length} existing cookies.`);
        }

        const targetUrl = "https://www.amazon.in/a/addresses/add?ref=ya_address_book_add_button";
        console.log(`    🌐 Navigating to Amazon...`);
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await new Promise(r => setTimeout(r, 3000));

        await checkForCaptchaAndErrors(page, currentHeadless);

        console.log("    ⏳ Detecting page state...");
        let nextStep = await detectState(page);



        // Switch accounts flow
        if (nextStep && nextStep.type === "switch_accounts") {
          const profileClicked = await page.evaluate((targetEmail) => {
            const links = Array.from(document.querySelectorAll('a[data-name="switch_account_request"], .cvf-widget-btn-verify-account-switcher'));
            const targetLink = links.find(l => l.textContent.toLowerCase().includes(targetEmail.toLowerCase()));
            if (targetLink) { targetLink.click(); return true; }
            return false;
          }, email);
          if (profileClicked) {
            console.log(`    ➡️ Clicked profile switcher for: ${email}`);
          } else {
            const addClicked = await page.evaluate(() => {
              const addLink = document.querySelector('#cvf-account-switcher-add-accounts-link') ||
                              Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes("Add account"));
              if (addLink) { addLink.click(); return true; }
              return false;
            });
            if (addClicked) console.log("    ➡️ Clicked 'Add account' button.");
          }
          await new Promise(r => setTimeout(r, 4500));
          await checkForCaptchaAndErrors(page, currentHeadless);

          nextStep = await detectState(page, 10000);


        }

        // Email input
        if (nextStep && nextStep.type === "email") {
          console.log(`    ✉️ Entering email: ${email}`);
          await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) { el.value = ""; el.focus(); }
          }, nextStep.selector);
          await page.type(nextStep.selector, email, { delay: 80 });

          const continueSelector = await Promise.any([
            page.waitForSelector("#continue", { visible: true, timeout: 5000 }).then(() => "#continue"),
            page.waitForSelector("input[type='submit']", { visible: true, timeout: 5000 }).then(() => "input[type='submit']"),
            page.waitForSelector(".a-button-input", { visible: true, timeout: 5000 }).then(() => ".a-button-input")
          ]).catch(() => null);

          if (continueSelector) {
            await safeClick(page, continueSelector, "Clicked Continue.");
            try {
              await page.waitForFunction((sel) => {
                const emailField = document.querySelector(sel);
                return !emailField || emailField.offsetParent === null;
              }, { timeout: 8000 }, nextStep.selector);
            } catch (e) {
              console.log("    ⚠️ Continue click did not navigate. Retrying via form submission...");
              await page.evaluate((sel) => {
                const form = document.querySelector(sel)?.closest('form');
                if (form) {
                  if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit();
                  } else {
                    form.submit();
                  }
                }
              }, nextStep.selector);
              
              await page.waitForFunction((sel) => {
                const emailField = document.querySelector(sel);
                return !emailField || emailField.offsetParent === null;
              }, { timeout: 8000 }, nextStep.selector).catch(() => null);
            }
          }
          await checkForCaptchaAndErrors(page, currentHeadless);

          nextStep = await detectState(page, 10000);
        }



        // Password input
        if (nextStep && nextStep.type === "password") {
          let loginSuccess = false;
          for (let pIndex = passwordIndex; pIndex < passwordsToTry.length; pIndex++) {
            const currentPassword = passwordsToTry[pIndex];
            passwordIndex = pIndex; // Update the outer index in case we relaunch headed due to Captcha
            console.log(`    🔒 Entering password ${pIndex + 1}/${passwordsToTry.length}...`);
            
            await page.evaluate((sel) => {
              const el = document.querySelector(sel);
              if (el) { el.value = ""; el.focus(); el.click(); }
            }, nextStep.selector);
            await new Promise(r => setTimeout(r, 500));
            await page.type(nextStep.selector, currentPassword, { delay: 100 });

            const signInSelector = await Promise.any([
              page.waitForSelector("#signInSubmit", { visible: true, timeout: 5000 }).then(() => "#signInSubmit"),
              page.waitForSelector("#auth-signin-button", { visible: true, timeout: 5000 }).then(() => "#auth-signin-button"),
              page.waitForSelector("input[type='submit']", { visible: true, timeout: 5000 }).then(() => "input[type='submit']")
            ]).catch(() => null);

             if (signInSelector) {
               await safeClick(page, signInSelector, "Clicked Sign In.");
               try {
                 await page.waitForFunction((sel) => {
                   const pwdField = document.querySelector(sel);
                   return !pwdField || pwdField.offsetParent === null;
                 }, { timeout: 8000 }, nextStep.selector);
               } catch (e) {
                 console.log("    ⚠️ Sign In click did not navigate. Retrying via form submission...");
                 await page.evaluate((sel) => {
                   const form = document.querySelector(sel)?.closest('form');
                   if (form) {
                     if (typeof form.requestSubmit === 'function') {
                       form.requestSubmit();
                     } else {
                       form.submit();
                     }
                   }
                 }, nextStep.selector);
                 
                 await page.waitForFunction((sel) => {
                   const pwdField = document.querySelector(sel);
                   return !pwdField || pwdField.offsetParent === null;
                 }, { timeout: 8000 }, nextStep.selector).catch(() => null);
               }
             } else {
               await page.evaluate((sel) => {
                 const form = document.querySelector(sel)?.closest('form');
                 if (form) {
                   if (typeof form.requestSubmit === 'function') {
                     form.requestSubmit();
                   } else {
                     form.submit();
                   }
                 }
               }, nextStep.selector);
               
               await page.waitForFunction((sel) => {
                 const pwdField = document.querySelector(sel);
                 return !pwdField || pwdField.offsetParent === null;
               }, { timeout: 8000 }, nextStep.selector).catch(() => null);
             }

            let hasAuthError = false;
            let isPasswordVisible = false;
            try {
              isPasswordVisible = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el !== null && el.offsetParent !== null;
              }, nextStep.selector);
            } catch (e) {
              isPasswordVisible = false;
            }

            if (isPasswordVisible) {
              try {
                // Check for Captcha / reset, skip auth wrong password throwing
                await checkForCaptchaAndErrors(page, currentHeadless, true);

                // Check if we are still on the password page with a wrong password alert
                hasAuthError = await page.evaluate(() => {
                  const box = document.querySelector("#auth-error-message-box");
                  const alertBox = document.querySelector(".a-alert-error");
                  const text = (box && box.offsetParent !== null ? box.innerText : "") + 
                               (alertBox && alertBox.offsetParent !== null ? alertBox.innerText : "");
                  return text.toLowerCase().includes("password is incorrect") || 
                         text.toLowerCase().includes("incorrect password") || 
                         text.toLowerCase().includes("problem");
                });
              } catch (e) {
                hasAuthError = false;
              }
            }

            if (hasAuthError) {
              console.log(`    ⚠️ Password ${pIndex + 1} was incorrect.`);
              if (pIndex + 1 < passwordsToTry.length) {
                // Clear the selector to prepare for the next retry on the same page
                await new Promise(r => setTimeout(r, 1000));
                continue;
              } else {
                throw new Error("AMAZON_AUTH_ERROR: Your password is incorrect (Tried all passwords)");
              }
            } else {
              loginSuccess = true;
              break;
            }
          }

          // Check for captcha or security challenges immediately after password entry
          await checkForCaptchaAndErrors(page, currentHeadless);

          nextStep = await detectState(page, 12000);
        }



        // OTP Flow
        if (nextStep && nextStep.type === "otp") {
          const otpSuccess = await handleOtpInput(page, nextStep.selector, imapConfig, email);
          if (!otpSuccess && currentHeadless) {
            throw new Error("OTP_FAILED: OTP verification failed or timed out, and manual input is impossible in headless mode.");
          }
        }

        const loginTimeout = currentHeadless ? 45000 : 300000;
        console.log(`    ⏳ Waiting for login completion (${loginTimeout / 1000}s timeout)...`);
        await page.waitForSelector("#address-ui-widgets-enterAddressFullName", { visible: true, timeout: loginTimeout });

        console.log("    ✅ Login successful!");
        await new Promise(resolve => setTimeout(resolve, 2000));

        const cookies = await page.cookies();
        await cookiesHelper.saveCookies(email, cookies);
        console.log(`    🍪 Saved ${cookies.length} cookies for ${email}`);

      } catch (error) {
        if (error.message.includes("RELAUNCH_HEADED")) {
          console.log(`\n🔄 [${email}] CAPTCHA/Challenge detected in headless mode! Relaunching in non-headless (headed) mode for manual solving...`);
          try { await browser.close(); } catch (e) {}
          return runLoginFlow(false);
        }

        if (error.message.includes("PASSWORD_RESET_REQUIRED")) {
          console.log(`    🗑️ Password reset required detected for ${email}. Deleting account from database...`);
          await googleSheets.updateAccountStatus(email, 'PASSWORD_RESET', 'Amazon password reset required');
          if (db) {
            try {
              await db.removeAccount(currentUserId, email);
              console.log(`    ✅ Successfully deleted ${email} from database.`);
            } catch (e) {
              console.error(`    ❌ Failed to delete ${email} from database: ${e.message}`);
            }
          }
        }

        if (error.message.includes("password is incorrect") || error.message.includes("incorrect password") || error.message.includes("Your password is incorrect")) {
          passwordIndex++;
          if (passwordIndex < passwordsToTry.length) {
            console.log(`⚠️ Password failed. Retrying login with alternative password...`);
            try { await browser.close(); } catch (e) {}
            return runLoginFlow(currentHeadless);
          }
        }

        console.error(`❌ Login flow failed for ${email}: ${error.message}`);
        if (!error.message.includes("PASSWORD_RESET_REQUIRED")) {
          await googleSheets.updateAccountStatus(email, 'LOGIN_FAILED', error.message);
        }
        try {
          const debugDir = path.join(__dirname, "debug");
          if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true });
          }
          const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
          const screenshotPath = path.join(debugDir, `error_${safeEmail}.png`);
          const htmlPath = path.join(debugDir, `error_${safeEmail}.html`);
          await page.screenshot({ path: screenshotPath });
          const content = await page.content();
          fs.writeFileSync(htmlPath, content, "utf8");
          console.log(`📸 Saved debug screenshot: ${screenshotPath}`);
          console.log(`📄 Saved debug HTML: ${htmlPath}`);
          console.log(`🌐 Final URL was: ${page.url()}`);
        } catch (debugErr) {
          console.error("⚠️ Failed to save debug assets:", debugErr.message);
        }
        hasFailed = true;
      } finally {
        await browser.close();
        console.log("🔒 Browser closed.");
      }
    };

    await runLoginFlow(config.headless);
  }
  if (hasFailed) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { extractOtpFromEmail };
}
