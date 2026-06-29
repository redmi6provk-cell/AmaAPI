const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { ImapFlow } = require("imapflow");
const cookiesHelper = require("./cookies");

let db = null;
if (fs.existsSync(path.join(__dirname, "..", "config", "db_config.json"))) {
  try {
    db = require("./db");
  } catch (e) {}
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const OTP_INITIAL_WAIT_MS = 25000;
const CHANGED_FILE = path.join(__dirname, "..", "data", "changed_accounts.json");

// ==================== LOAD CHANGED ACCOUNTS ====================
function getChangedAccounts() {
  if (fs.existsSync(CHANGED_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(CHANGED_FILE, "utf8"));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveChangedAccount(email) {
  const changed = getChangedAccounts();
  changed[email] = true;
  fs.writeFileSync(CHANGED_FILE, JSON.stringify(changed, null, 2), "utf8");
}

// ==================== IMAP OTP FUNCTIONS ====================
function extractOtpFromEmail(rawEmail) {
  if (!rawEmail) return null;
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
          body = body.split(`--${boundary}`)[0].replace(/--\s*$/, "");
          if (part.toLowerCase().includes("content-transfer-encoding: base64")) {
            try { body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch (e) {}
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
  if (!decodedText.trim()) decodedText = rawEmail;

  let cleaned = decodedText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const patterns = [
    /your\s*verification\s*code\s*is:?\s*(\b\d{6}\b)/i,
    /one\s*time\s*password\s*\(otp\)\s*is:?\s*(\b\d{6}\b)/i,
    /otp:?\s*(\b\d{6}\b)/i,
    /verification\s*code:?\s*(\b\d{6}\b)/i,
    /(\b\d{6}\b)\s*is\s*your\s*amazon/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      const code = match[1];
      if (code !== "000000" && code !== "303333" && code !== "565959" && code !== "007185") return code;
    }
  }
  const allMatches = cleaned.match(/\b\d{6}\b/g) || [];
  for (const code of allMatches) {
    if (code !== "000000" && code !== "303333" && code !== "565959" && code !== "007185") return code;
  }
  return null;
}

function isEmailTargetedTo(msg, targetEmail) {
  if (!targetEmail) return true;
  const normalizedTarget = targetEmail.toLowerCase().trim();

  if (msg.source) {
    const rawEmailStr = msg.source.toString().toLowerCase();
    if (rawEmailStr.includes(normalizedTarget)) {
      return true;
    }
  }

  const envelopeTo = msg.envelope?.to || [];
  for (const addr of envelopeTo) {
    if (addr.address) {
      const emailPart = addr.address.toLowerCase().trim();
      if (emailPart === normalizedTarget || emailPart.includes(normalizedTarget)) {
        return true;
      }
    }
  }

  const envelopeCc = msg.envelope?.cc || [];
  for (const addr of envelopeCc) {
    if (addr.address) {
      const emailPart = addr.address.toLowerCase().trim();
      if (emailPart === normalizedTarget || emailPart.includes(normalizedTarget)) {
        return true;
      }
    }
  }

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
    auth: { user: imapConfig.user, pass: imapConfig.password },
    logger: false
  });
  await client.connect();
  let lock = await client.getMailboxLock("INBOX");
  try {
    if (client.mailbox.exists === 0) return null;
    const totalEmails = client.mailbox.exists;
    const startRange = Math.max(1, totalEmails - 15);
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
      
      const isAmazon = from.toLowerCase().includes("amazon") || subject.toLowerCase().includes("amazon");
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

      const isAmazon = from.toLowerCase().includes("amazon") || subject.toLowerCase().includes("amazon");
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
  console.log(`    ⏳ Waiting ${OTP_INITIAL_WAIT_MS / 1000}s for OTP email...`);
  await new Promise(r => setTimeout(r, OTP_INITIAL_WAIT_MS));
  while (Date.now() - startTime < timeoutMs) {
    try {
      const otp = await fetchAmazonOtp(imapConfig, targetEmail);
      if (otp) return otp;
    } catch (e) {
      console.warn(`    ⚠️ IMAP error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function handleOtpInput(page, selector, imapConfig, targetEmail) {
  console.log("    🔑 OTP prompt detected.");
  if (!imapConfig || !imapConfig.host) {
    console.log("    ⚠️ No IMAP config. Please enter OTP manually.");
    return false;
  }
  const otp = await pollForAmazonOtp(imapConfig, targetEmail);
  if (otp) {
    await page.type(selector, otp, { delay: 100 });
    await new Promise(r => setTimeout(r, 1000));
    await page.evaluate(() => {
      const btn = document.querySelector("input[type='submit'], button[type='submit']");
      if (btn) btn.click();
    });
    return true;
  }
  return false;
}

// ==================== CAPTCHA DETECTOR ====================
async function checkForCaptcha(page, startHeadless) {
  let captchaDetected = false;
  let retries = 5;
  while (retries > 0) {
    try {
      captchaDetected = await page.evaluate(() => {
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

        if (url.includes("captcha") || url.includes("puzzle")) return "captcha";
        if (url.includes("/cvf/")) {
          if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return "captcha";
          if (document.querySelector("iframe[title*='verification']")) return "captcha";
          const text = document.body ? (document.body.innerText || "") : "";
          if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return "captcha";
          return "captcha";
        }
        if (document.querySelector("input[placeholder='Type characters']")) return "captcha";
        if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return "captcha";
        if (document.querySelector("iframe[title*='verification']")) return "captcha";
        if (document.title && document.title.toLowerCase().includes("authentication required")) return "captcha";
        const text = document.body ? (document.body.innerText || "") : "";
        if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return "captcha";
        
        // Check for "Password reset required" or "New to Amazon" registration redirects
        if (
          text.includes("Password reset required") ||
          text.includes("Choose a new password") ||
          text.includes("Please set a new password") ||
          text.includes("It looks like you are new to Amazon") ||
          text.includes("create an account using your mobile number") ||
          text.includes("Proceed to create an account") ||
          url.includes("forgotpassword") ||
          url.includes("resetpassword") ||
          url.includes("reset-password")
        ) {
          return "reset_required";
        }
        
        return false;
      });
      break;
    } catch (err) {
      if (err.message.includes("Execution context was destroyed") || err.message.includes("navigation")) {
        console.log("    ⏳ Page is navigating or redirecting, waiting to retry captcha check...");
        await new Promise(r => setTimeout(r, 1500));
        retries--;
      } else {
        throw err;
      }
    }
  }

  if (captchaDetected === "reset_required") {
    throw new Error("PASSWORD_RESET_REQUIRED");
  }

  if (captchaDetected === "captcha") {
    if (startHeadless) {
      throw new Error("RELAUNCH_HEADED");
    }
    console.log("\n    ⚠️ [!] CAPTCHA/Puzzle Detected! Please solve it manually in the browser window...");
    while (true) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const stillCaptcha = await page.evaluate(() => {
          const url = window.location.href.toLowerCase();
          
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
        }).catch(() => true);
        if (!stillCaptcha) break;
      } catch (e) {
        break; // If evaluation fails, break loop
      }
    }
    console.log("    ✅ Captcha resolved. Continuing...");
  }
}

// ==================== DYNAMIC LOGIN FLOW HANDLER ====================
async function runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless) {
  let attempts = 0;
  let triedCurrentPassword = false;
  let loggedInWithNewPassword = false;
  while (attempts < 6) {
    attempts++;
    await checkForCaptcha(page, startHeadless);

    // Detect if we are on a sign-in or verification page
    const state = await page.evaluate(() => {
      const url = window.location.href.toLowerCase();
      
      // If we see an OTP input field, it is definitely OTP state
      const otpSelectors = [
        "#input-box-otp", "#auth-mfa-otpcode", "#cvf-widget-input-code", "#cvf-input-code",
        "input[name='otpCode']", "input[name='code']", "input#cvf-a-input", "#cvf-otp-input", ".cvf-widget-input-code"
      ];
      for (const sel of otpSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return "otp";
      }

      // Check if we are on sign-in
      if (url.includes("/ap/signin") || document.title.toLowerCase().includes("sign-in") || document.title.toLowerCase().includes("sign in")) {
        // Find if it's asking for email or password
        const emailField = document.querySelector("#ap_email, #ap_email_login, input[name='email']");
        const pwdField = document.querySelector("#ap_password, input[type='password'], input[name='password']");
        if (emailField && emailField.offsetParent !== null) return "signin_email";
        if (pwdField && pwdField.offsetParent !== null) return "signin_password";
        return "signin";
      }

      // Check for generic email or password inputs outside ap/signin that are visible
      const emailField = document.querySelector("#ap_email, #ap_email_login, input[name='email']");
      const pwdField = document.querySelector("#ap_password, input[type='password']");
      if (emailField && emailField.offsetParent !== null) return "signin_email";
      if (pwdField && pwdField.offsetParent !== null) {
        const newPwdField = document.querySelector("#ap_cnp_new_password, #ap_password_new, input[name='newPassword'], input[name='passwordNew']");
        if (!newPwdField) return "signin_password";
      }

      return "logged_in";
    });

    console.log(`    🔍 Page state detected: ${state} (Attempt ${attempts}/6, URL: ${page.url()})`);

    if (state === "logged_in") {
      return { alreadyChanged: loggedInWithNewPassword };
    }

    if (state === "signin" || state === "signin_email") {
      const emailSelector = await Promise.any([
        page.waitForSelector("#ap_email", { visible: true, timeout: 3000 }).then(() => "#ap_email"),
        page.waitForSelector("#ap_email_login", { visible: true, timeout: 3000 }).then(() => "#ap_email_login"),
        page.waitForSelector("input[name='email']", { visible: true, timeout: 3000 }).then(() => "input[name='email']")
      ]).catch(() => null);

      if (emailSelector) {
        console.log(`    ✉️ Entering email: ${email}`);
        await page.click(emailSelector, { clickCount: 3 });
        await page.keyboard.press("Backspace");
        await page.type(emailSelector, email, { delay: 100 });
        await new Promise(r => setTimeout(r, 500));
        
        await Promise.all([
          page.click("#continue").catch(() => page.click("input[type='submit']")).catch(() => {}),
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {})
        ]);
        continue;
      }
    }

    if (state === "signin_password") {
      const pwdSelector = await Promise.any([
        page.waitForSelector("#ap_password", { visible: true, timeout: 3000 }).then(() => "#ap_password"),
        page.waitForSelector("input[type='password']", { visible: true, timeout: 3000 }).then(() => "input[type='password']"),
        page.waitForSelector("input[name='password']", { visible: true, timeout: 3000 }).then(() => "input[name='password']")
      ]).catch(() => null);

      if (pwdSelector) {
        // Fallback retry with the new password "112233" if currentPassword fails
        const passToTry = triedCurrentPassword ? "112233" : currentPassword;
        console.log(`    🔑 Entering password (attempting: ${passToTry})...`);
        if (passToTry === "112233") {
          loggedInWithNewPassword = true;
        }
        await page.click(pwdSelector, { clickCount: 3 });
        await page.keyboard.press("Backspace");
        await page.type(pwdSelector, passToTry, { delay: 100 });
        await new Promise(r => setTimeout(r, 500));
        
        triedCurrentPassword = true;

        await Promise.all([
          page.click("#signInSubmit").catch(() => page.click("input[type='submit']")).catch(() => {}),
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {})
        ]);
        continue;
      }
    }

    if (state === "otp") {
      const otpSelector = await Promise.any([
        page.waitForSelector("#cvf-input-code", { visible: true, timeout: 3000 }).then(() => "#cvf-input-code"),
        page.waitForSelector("#input-box-otp", { visible: true, timeout: 3000 }).then(() => "#input-box-otp"),
        page.waitForSelector("#auth-mfa-otpcode", { visible: true, timeout: 3000 }).then(() => "#auth-mfa-otpcode"),
        page.waitForSelector("#cvf-widget-input-code", { visible: true, timeout: 3000 }).then(() => "#cvf-widget-input-code"),
        page.waitForSelector("input[name='otpCode']", { visible: true, timeout: 3000 }).then(() => "input[name='otpCode']"),
        page.waitForSelector("input[name='code']", { visible: true, timeout: 3000 }).then(() => "input[name='code']"),
        page.waitForSelector("input#cvf-a-input", { visible: true, timeout: 3000 }).then(() => "input#cvf-a-input"),
        page.waitForSelector("#cvf-otp-input", { visible: true, timeout: 3000 }).then(() => "#cvf-otp-input")
      ]).catch(() => null);

      if (otpSelector) {
        console.log(`    🔑 OTP Screen detected: ${otpSelector}`);
        const otpSuccess = await handleOtpInput(page, otpSelector, imapConfig, email);
        if (!otpSuccess && startHeadless) {
          throw new Error("RELAUNCH_HEADED");
        }
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
        continue;
      }
    }

    await new Promise(r => setTimeout(r, 1500));
  }
}

// ==================== PROCESS PASSWORD CHANGE ====================
async function changePasswordForAccount(email, currentPassword, newPassword, imapConfig, startHeadless = true) {
  console.log(`\n======================================================`);
  console.log(`🔒 Processing password change to ${newPassword} for: ${email} (headless: ${startHeadless})`);
  console.log(`======================================================`);

  const browser = await puppeteer.launch({
    headless: startHeadless,
    defaultViewport: null,
    args: ["--start-maximized"]
  });

  const page = await browser.newPage();
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

  try {
    const handleLoginFlowResult = async (result) => {
      if (result && result.alreadyChanged) {
        console.log(`    ℹ️ Account already has password set to ${newPassword}. Skipping change password step.`);
        const cookies = await page.cookies();
        await cookiesHelper.saveCookies(email, cookies);
        saveChangedAccount(email);
        return true;
      }
      return false;
    };

    const existingCookies = await cookiesHelper.readCookies(email);
    if (existingCookies && existingCookies.length > 0) {
      await page.setCookie(...existingCookies);
      console.log("    📦 Injected existing session cookies.");
    }

    // 1. Go to Your Account page first to start OpenID flow
    console.log("    🌐 Navigating to Your Account...");
    await page.goto("https://www.amazon.in/gp/css/homepage.html", { waitUntil: "networkidle2", timeout: 90000 });
    await new Promise(r => setTimeout(r, 3000));
    
    let flowRes = await runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless);
    if (await handleLoginFlowResult(flowRes)) return true;

    // Click Login & security link
    console.log("    ➡️ Clicking Login & Security...");
    let clickedLS = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const lsLink = links.find(l => l.textContent.toLowerCase().includes("login & security") || l.textContent.toLowerCase().includes("login and security"));
      if (lsLink) {
        lsLink.click();
        return true;
      }
      return false;
    });

    if (!clickedLS) {
      // If we are not on the Your Account page, we might have been redirected to homepage, let's navigate there
      console.log("    🌐 Re-navigating to Your Account page to find Login & Security link...");
      await page.goto("https://www.amazon.in/gp/css/homepage.html", { waitUntil: "networkidle2", timeout: 90000 });
      flowRes = await runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless);
      if (await handleLoginFlowResult(flowRes)) return true;
      
      clickedLS = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const lsLink = links.find(l => l.textContent.toLowerCase().includes("login & security") || l.textContent.toLowerCase().includes("login and security"));
        if (lsLink) {
          lsLink.click();
          return true;
        }
        return false;
      });
      if (!clickedLS) {
        throw new Error("Could not find Login & Security link on Your Account page.");
      }
    }

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    flowRes = await runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless);
    if (await handleLoginFlowResult(flowRes)) return true;

    // 4. We should now be on the Customer profile page (ap/cnep)
    console.log("    ⏳ Waiting for Login & Security page...");
    await page.waitForSelector("#auth-cnep-edit-password-button", { visible: true, timeout: 20000 });

    console.log("    ➡️ Clicking Edit Password button...");
    await page.click("#auth-cnep-edit-password-button");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    flowRes = await runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless);
    if (await handleLoginFlowResult(flowRes)) return true;

    // 5. We should now be on the Change Password (ap/cnp) page
    console.log("    ⏳ Waiting for Change Password page...");

    // Now we must be on the actual Change Password page. Let's wait for fields.
    const getCnpSelector = async (timeoutMs) => {
      return Promise.any([
        page.waitForSelector("#ap_cnp_new_password", { visible: true, timeout: timeoutMs }).then(() => "id"),
        page.waitForSelector("input[name='newPassword']", { visible: true, timeout: timeoutMs }).then(() => "name"),
        page.waitForSelector("#ap_password_new", { visible: true, timeout: timeoutMs }).then(() => "id_set2"),
        page.waitForSelector("input[name='passwordNew']", { visible: true, timeout: timeoutMs }).then(() => "name_set2")
      ]).catch(() => null);
    };

    let cnpSelector = await getCnpSelector(10000);

    if (!cnpSelector) {
      console.log("    ⚠️ Change Password fields not found. We might have been redirected to the homepage. Retrying navigation to Login & Security...");
      // Re-navigate to Your Account homepage
      await page.goto("https://www.amazon.in/gp/css/homepage.html", { waitUntil: "networkidle2", timeout: 90000 });
      await checkForCaptcha(page, startHeadless);

      // Click Login & security link
      console.log("    ➡️ Clicking Login & Security again...");
      const clickedLS2 = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const lsLink = links.find(l => l.textContent.toLowerCase().includes("login & security") || l.textContent.toLowerCase().includes("login and security"));
        if (lsLink) {
          lsLink.click();
          return true;
        }
        return false;
      });
      
      if (!clickedLS2) {
        throw new Error("Could not find Login & Security link on Your Account page.");
      }

      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
      flowRes = await runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless);
      if (await handleLoginFlowResult(flowRes)) return true;

      // We should now be on ap/cnep
      console.log("    ⏳ Waiting for Login & Security page...");
      await page.waitForSelector("#auth-cnep-edit-password-button", { visible: true, timeout: 20000 });

      console.log("    ➡️ Clicking Edit Password button again...");
      await page.click("#auth-cnep-edit-password-button");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
      flowRes = await runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless);
      if (await handleLoginFlowResult(flowRes)) return true;

      // Check for Change Password fields again
      cnpSelector = await getCnpSelector(20000);
    }

    if (!cnpSelector) {
      throw new Error("Could not reach Amazon Change Password page after retry. Current URL: " + page.url());
    }

    console.log("    📝 Filling in new password fields...");
    let curPwdSel, newPwdSel, confirmPwdSel, submitBtnSel;
    if (cnpSelector === "id") {
      curPwdSel = "#ap_cnp_current_password";
      newPwdSel = "#ap_cnp_new_password";
      confirmPwdSel = "#ap_cnp_new_password_check";
      submitBtnSel = "#cnp_submit_button";
    } else if (cnpSelector === "name") {
      curPwdSel = "input[name='password']";
      newPwdSel = "input[name='newPassword']";
      confirmPwdSel = "input[name='newPasswordCheck']";
      submitBtnSel = "input[type='submit']";
    } else if (cnpSelector === "id_set2") {
      curPwdSel = "#ap_password";
      newPwdSel = "#ap_password_new";
      confirmPwdSel = "#ap_password_new_check";
      submitBtnSel = "#cnep_1D_submit_button";
    } else if (cnpSelector === "name_set2") {
      curPwdSel = "input[name='password']";
      newPwdSel = "input[name='passwordNew']";
      confirmPwdSel = "input[name='passwordNewCheck']";
      submitBtnSel = "input[type='submit']";
    }

    await page.type(curPwdSel, currentPassword, { delay: 100 });
    await page.type(newPwdSel, newPassword, { delay: 100 });
    await page.type(confirmPwdSel, newPassword, { delay: 100 });
    await new Promise(r => setTimeout(r, 1500));

    console.log("    Submiting password change...");
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel) || document.querySelector("input[type='submit']");
      if (btn) btn.click();
    }, submitBtnSel);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    
    // Verify success
    const textContent = await page.evaluate(() => document.body ? document.body.innerText : "");
    const successMsg = textContent.includes("Success") || textContent.includes("password has been changed") || textContent.includes("Password changed") || page.url().includes("homepage");
    
    if (successMsg) {
      console.log(`    ✅ Password changed successfully on Amazon to ${newPassword}!`);
      const cookies = await page.cookies();
      await cookiesHelper.saveCookies(email, cookies);
      saveChangedAccount(email);
      return true;
    } else {
      throw new Error("Submit completed but success message not found. Current URL: " + page.url());
    }
  } catch (err) {
    if (err.message === "PASSWORD_RESET_REQUIRED") {
      console.log(`    ⚠️ Password reset required detected for ${email}. Returning reset indicator.`);
      return "RESET_REQUIRED";
    }

    if (err.message.includes("RELAUNCH_HEADED") && startHeadless) {
      console.log(`\n🔄 [${email}] CAPTCHA/Challenge detected in headless mode! Relaunching in non-headless (headed) mode for manual solving...`);
      try { await browser.close(); } catch (e) {}
      return changePasswordForAccount(email, currentPassword, newPassword, imapConfig, false);
    }

    // Save debug info
    try {
      const debugDir = path.join(__dirname, "..", "debug");
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
      const screenshotPath = path.join(debugDir, `pwd_error_${safeEmail}.png`);
      const htmlPath = path.join(debugDir, `pwd_error_${safeEmail}.html`);
      await page.screenshot({ path: screenshotPath });
      const content = await page.content();
      fs.writeFileSync(htmlPath, content, "utf8");
      console.log(`📸 Saved debug screenshot: ${screenshotPath}`);
      console.log(`📄 Saved debug HTML: ${htmlPath}`);
    } catch (debugErr) {
      console.warn(`⚠️ Could not save debug info: ${debugErr.message}`);
    }

    console.error(`    ❌ Failed: ${err.message}`);
    return false;
  } finally {
    await browser.close();
  }
}

// ==================== MAIN BATCH CONTROLLER ====================
async function main() {
  const args = process.argv.slice(2);
  
  // Parse user-id
  let currentUserId = 1;
  const userIdx = args.indexOf("--user-id");
  if (userIdx !== -1 && userIdx + 1 < args.length) {
    currentUserId = parseInt(args[userIdx + 1], 10);
  }

  let dbUser = null;
  let imapConfig = null;
  let currentPassword = "Aman@123";
  let newPassword = "112233";

  if (db) {
    let retries = 3;
    while (retries > 0) {
      try {
        dbUser = await db.getUser(currentUserId);
        if (dbUser) {
          currentPassword = dbUser.amazonPassword || "Aman@123";
          imapConfig = dbUser.imapConfig;
          console.log(`Loaded credentials for User ID ${currentUserId}. DB Password: "${currentPassword}"`);
        }
        break;
      } catch (e) {
        retries--;
        console.warn(`⚠️ Could not query DB for current user settings (attempts remaining: ${retries}): ${e.message}`);
        if (retries > 0) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // Parse current-password override
  const curPwdIdx = args.indexOf("--current-password");
  if (curPwdIdx !== -1 && curPwdIdx + 1 < args.length) {
    currentPassword = args[curPwdIdx + 1];
  } else if (currentPassword === newPassword) {
    // If the database password is already updated to newPassword, but we are running the update script,
    // it likely means the user is updating from the old password to newPassword.
    currentPassword = "Aman@123";
  }

  const newPwdIdx = args.indexOf("--new-password");
  if (newPwdIdx !== -1 && newPwdIdx + 1 < args.length) {
    newPassword = args[newPwdIdx + 1];
  }

  const isHeadless = args.includes("--headless");
  const startHeadless = isHeadless;

  console.log(`🔑 Using Current Password: "${currentPassword}"`);
  console.log(`🔒 Updating to New Password: "${newPassword}"`);
  console.log(`🌐 Headless: ${startHeadless}`);

  if (!imapConfig && fs.existsSync(path.join(__dirname, "..", "config", "imap.json"))) {
    try {
      imapConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "imap.json"), "utf8"));
    } catch (e) {}
  }

  // Load list of accounts from DB
  let accounts = [];
  const emailIdx = args.indexOf("--email");
  if (emailIdx !== -1 && emailIdx + 1 < args.length) {
    accounts = [args[emailIdx + 1]];
    console.log(`🎯 Targeting single account from arguments: ${accounts[0]}`);
  } else if (db) {
    let retries = 3;
    while (retries > 0) {
      try {
        const res = await db.pool.query(`
          SELECT email FROM accounts WHERE user_id = $1
          UNION
          SELECT email FROM success_accounts WHERE user_id = $1
          UNION
          SELECT email FROM no_cod_accounts WHERE user_id = $1
          UNION
          SELECT email FROM past_order WHERE user_id = $1
          UNION
          SELECT email FROM delivery_issue WHERE user_id = $1
          UNION
          SELECT email FROM purchase_limit WHERE user_id = $1
        `, [currentUserId]);
        accounts = res.rows.map(r => r.email);
        break;
      } catch (e) {
        retries--;
        console.error(`⚠️ Could not query accounts from database (attempts remaining: ${retries}):`, e.message);
        if (retries > 0) await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  if (accounts.length === 0) {
    console.error("No accounts found in database. Exiting.");
    process.exit(1);
  }

  const changed = getChangedAccounts();
  const pending = accounts.filter(email => !changed[email]);

  console.log(`Total Accounts in DB: ${accounts.length}`);
  console.log(`Already Changed: ${Object.keys(changed).length}`);
  console.log(`Pending: ${pending.length}`);

  if (pending.length === 0) {
    console.log("🎉 All accounts have already been updated! Exiting.");
    process.exit(0);
  }

  // Get next 10 accounts
  const batch = pending.slice(0, 10);
  console.log(`\n🚀 Processing next batch of ${batch.length} accounts...`);
  batch.forEach((email, idx) => console.log(`  [${idx+1}] ${email}`));

  let successCount = 0;
  for (const email of batch) {
    const success = await changePasswordForAccount(email, currentPassword, newPassword, imapConfig, startHeadless);
    if (success === true) {
      successCount++;
    } else if (success === "RESET_REQUIRED") {
      console.log(`    🗑️ Password reset required detected for ${email}. Deleting account from database...`);
      if (db) {
        try {
          await db.removeAccount(currentUserId, email);
          console.log(`    ✅ Successfully deleted ${email} from database.`);
        } catch (e) {
          console.error(`    ❌ Failed to delete ${email} from database: ${e.message}`);
        }
      }
    }
    // Sleep between accounts
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log(`\n======================================================`);
  console.log(`Batch complete. Changed ${successCount}/${batch.length} successfully.`);
  console.log(`Already Changed: ${Object.keys(getChangedAccounts()).length}/${accounts.length}`);
  console.log(`======================================================\n`);

  if (db) {
    try {
      await db.pool.end();
    } catch (e) {}
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}
