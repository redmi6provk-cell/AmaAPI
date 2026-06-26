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

let adb = null;
try {
  adb = require("./adb_helper");
} catch (e) {
  console.warn("⚠️ adb_helper failed to load:", e.message);
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const OTP_INITIAL_WAIT_MS = 25000;
const STATUS_FILE = path.join(__dirname, "..", "data", "email_changed_status.json");

// Load changed status to resume progress
function getChangedStatus() {
  if (fs.existsSync(STATUS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveChangedStatus(gmail, kanuvk) {
  const status = getChangedStatus();
  status[gmail.toLowerCase()] = kanuvk.toLowerCase();
  
  const dir = path.dirname(STATUS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2), "utf8");
}

// Helper to decode Quoted-Printable format
function decodeQuotedPrintable(text) {
  if (!text) return "";
  // Remove soft line breaks: equals sign at the end of a line
  let result = text.replace(/=\r?\n/g, "");
  
  // Replace hex encoded characters (like =3D for = or =2F for /)
  result = result.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  
  return result;
}

// ==================== OTP & APPROVAL LINK POLLING ====================
function extractOtpFromEmail(rawEmail) {
  if (!rawEmail) return null;
  
  let decodedText = "";
  const boundaryMatch = rawEmail.match(/boundary=\"?([^\"\\s;]+)\"?/i) || rawEmail.match(/boundary=([^;\\s\\r\\n]+)/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = rawEmail.split(`--${boundary}`);
    for (const part of parts) {
      if (part.toLowerCase().includes("content-transfer-encoding: base64")) {
        const bodyStart = part.indexOf("\r\n\r\n");
        if (bodyStart !== -1) {
          const base64Content = part.substring(bodyStart).replace(/\s/g, "");
          try {
            decodedText += Buffer.from(base64Content, "base64").toString("utf8");
          } catch (_) {}
        }
      } else if (part.toLowerCase().includes("content-transfer-encoding: quoted-printable")) {
        const bodyStart = part.indexOf("\r\n\r\n");
        if (bodyStart !== -1) {
          decodedText += decodeQuotedPrintable(part.substring(bodyStart));
        }
      } else {
        const bodyStart = part.indexOf("\r\n\r\n");
        if (bodyStart !== -1) {
          decodedText += part.substring(bodyStart);
        }
      }
    }
  }
  
  if (!decodedText.trim()) decodedText = decodeQuotedPrintable(rawEmail);

  // Regular expression to look for a 6-digit OTP from Amazon
  const match = decodedText.match(/(\d{6})\s*is\s*your\s*Amazon\s*(?:One-Time\s*Password|OTP)/i) || 
                decodedText.match(/your\s*Amazon\s*(?:One-Time\s*Password|OTP)\s*(?:is:?\s*)?(\d{6})/i) ||
                decodedText.match(/(\d{6})\s*is\s*your\s*verification\s*code/i) ||
                decodedText.match(/verification\s*code\s*(?:is:?\s*)?(\d{6})/i) ||
                decodedText.match(/(\d{6})/); // Fallback to any 6 digits

  return match ? match[1] : null;
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

  // Check envelope TO
  const envelopeTo = msg.envelope?.to || [];
  for (const addr of envelopeTo) {
    if (addr.address) {
      const emailPart = addr.address.toLowerCase().trim();
      if (emailPart === normalizedTarget || emailPart.includes(normalizedTarget)) {
        return true;
      }
    }
  }

  // Check envelope CC
  const envelopeCc = msg.envelope?.cc || [];
  for (const addr of envelopeCc) {
    if (addr.address) {
      const emailPart = addr.address.toLowerCase().trim();
      if (emailPart === normalizedTarget || emailPart.includes(normalizedTarget)) {
        return true;
      }
    }
  }

  // Check parsed headers
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

  return false;
}

async function fetchAmazonOtp(imapConfig, targetEmail) {
  const client = new ImapFlow({
    host: imapConfig.host || "imap.gmail.com",
    port: imapConfig.port || 993,
    secure: imapConfig.secure !== undefined ? imapConfig.secure : true,
    auth: {
      user: imapConfig.user,
      pass: imapConfig.password,
    },
    logger: false,
  });
  client.on("error", (err) => {
    // Silently log or ignore to prevent process crash on network reset
    console.error("    ⚠️ IMAP client error event:", err.message);
  });

  try {
    try {
      await client.connect();
    } catch (connErr) {
      console.error("    ❌ IMAP Connection error:", connErr.message);
      return null;
    }
    const lock = await client.getMailboxLock("INBOX");
    try {
      const totalEmails = client.mailbox.exists;
      if (totalEmails === 0) return null;
      
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
    }
    await client.logout();
  } catch (err) {
    console.error("    ❌ IMAP error:", err.message);
  }
  return null;
}

async function pollForAmazonOtp(imapConfig, targetEmail, timeoutMs = 120000, intervalMs = 4000) {
  console.log(`    ⏳ Checking IMAP inbox for Amazon OTP sent to ${targetEmail}...`);
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const otp = await fetchAmazonOtp(imapConfig, targetEmail);
    if (otp) return otp;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

async function handleOtpInput(page, selector, imapConfig, targetEmail) {
  console.log(`    🔑 OTP prompt detected for ${targetEmail}.`);
  let autoFetched = false;

  if (imapConfig && imapConfig.user) {
    const otp = await pollForAmazonOtp(imapConfig, targetEmail);
    if (otp) {
      console.log(`    ✅ Auto-fetched OTP: ${otp}. Entering...`);
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.value = "";
      }, selector);
      await page.type(selector, otp, { delay: 100 });
      await new Promise(r => setTimeout(r, 1000));
      await page.evaluate(() => {
        const btn = document.querySelector("input[type='submit'], button[type='submit'], #cvf-submit-otp-button");
        if (btn) btn.click();
      });
      autoFetched = true;
    }
  }

  if (autoFetched) {
    try {
      // Wait to see if field disappears
      await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        return !el || el.offsetParent === null;
      }, { timeout: 8000 }, selector);
      return true;
    } catch (e) {
      console.log("    ⚠️ OTP auto-submitted but field is still visible. Proceeding to manual wait...");
    }
  }

  // Fallback for manual entry
  console.log("    👉 [Manual Intervention] Please enter the OTP manually in the browser window...");
  try {
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return !el || el.offsetParent === null;
    }, { timeout: 60000 }, selector);
    console.log("    ✅ OTP field disappeared (OTP accepted).");
    return true;
  } catch (e) {
    console.warn("    ❌ Timeout waiting for manual OTP submission.");
    return false;
  }
}

// Fetch approval links (e.g. for transaction approval)
async function fetchAmazonApprovalLink(imapConfig, targetEmail) {
  const client = new ImapFlow({
    host: imapConfig.host || "imap.gmail.com",
    port: imapConfig.port || 993,
    secure: imapConfig.secure !== undefined ? imapConfig.secure : true,
    auth: {
      user: imapConfig.user,
      pass: imapConfig.password,
    },
    logger: false,
  });
  client.on("error", (err) => {
    // Silently log or ignore to prevent process crash on network reset
    console.error("    ⚠️ IMAP client error event:", err.message);
  });

  try {
    try {
      await client.connect();
    } catch (connErr) {
      console.error("    ❌ IMAP Connection error:", connErr.message);
      return null;
    }
    const lock = await client.getMailboxLock("INBOX");
    try {
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

        const rawEmail = msg.source ? decodeQuotedPrintable(msg.source.toString()) : "";
        
        // Search for approval URL in body
        const match = rawEmail.match(/https:\/\/(?:www\.)?amazon\.(?:in|com)\/(?:ap\/cvf\/approval|co\/inline-approval|a\/c\/r)[^\s"'>\)]+/i);
        if (match) {
          const approvalLink = match[0].replace(/&amp;/g, '&');
          console.log(`    📧 Found Amazon approval link in UNSEEN email: "${subject}" -> Link: ${approvalLink}`);
          try {
            await client.messageFlagsAdd(msg.seq, ["\\Seen"]);
          } catch (e) {}
          return approvalLink;
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

        const rawEmail = msg.source ? decodeQuotedPrintable(msg.source.toString()) : "";
        
        // Search for approval URL in body
        const match = rawEmail.match(/https:\/\/(?:www\.)?amazon\.(?:in|com)\/(?:ap\/cvf\/approval|co\/inline-approval|a\/c\/r)[^\s"'>\)]+/i);
        if (match) {
          const approvalLink = match[0].replace(/&amp;/g, '&');
          console.log(`    📧 Found Amazon approval link in recent seen email: "${subject}" -> Link: ${approvalLink}`);
          return approvalLink;
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error("    ❌ IMAP error:", err.message);
  }
  return null;
}

async function pollForAmazonApprovalLink(imapConfig, targetEmail, timeoutMs = 120000, intervalMs = 5000) {
  console.log(`    ⏳ Waiting ${OTP_INITIAL_WAIT_MS / 1000}s for approval email...`);
  await new Promise(r => setTimeout(r, OTP_INITIAL_WAIT_MS));
  
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const link = await fetchAmazonApprovalLink(imapConfig, targetEmail);
    if (link) return link;
    console.log(`    ...checking again in ${intervalMs / 1000}s...`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ==================== CAPTCHA DETECTOR ====================
async function checkForCaptcha(page, startHeadless) {
  const captchaDetected = await page.evaluate(() => {
    const url = window.location.href.toLowerCase();
    
    // If there is an active OTP input field visible, it's not a captcha challenge
    const otpSelectors = [
      "#input-box-otp", "#auth-mfa-otpcode", "#cvf-widget-input-code", "#cvf-input-code",
      "input[name='otpCode']", "input[name='code']", "input#cvf-a-input", "#cvf-otp-input", ".cvf-widget-input-code"
    ];
    for (const sel of otpSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return false;
      }
    }

    if (url.includes("captcha") || url.includes("puzzle")) return "captcha";
    if (url.includes("/cvf/")) {
      if (document.querySelector("#cvf-aamation-challenge-iframe") || 
          document.querySelector(".cvf-aamation-iframe") || 
          document.querySelector("#cvf-aamation-container iframe") ||
          document.querySelector("script[src*='awswaf.com']") ||
          document.querySelector("iframe[src*='awswaf.com']")) {
        return "captcha";
      }
    }
    // General WAF Captcha checks
    if (document.querySelector("script[src*='awswaf.com']") || 
        document.querySelector("iframe[src*='captcha']") || 
        document.getElementById("cvf-aamation-container")) {
      // Confirm it actually loaded captcha content and not just empty div
      const container = document.getElementById("cvf-aamation-container");
      if (container && container.innerHTML.trim().length > 0) {
        return "captcha";
      }
    }
    return false;
  });

  if (captchaDetected) {
    console.log("\n⚠️ CAPTCHA/Puzzle detected!");
    if (startHeadless) {
      console.log("❌ Headless mode captcha is blocking. Throwing RELAUNCH_HEADED to rerun with browser window visible.");
      throw new Error("RELAUNCH_HEADED");
    } else {
      console.log("👉 Please solve the Captcha/Puzzle manually in the browser window...");
      // Wait for captcha page to go away
      while (true) {
        const url = page.url();
        const stillCaptcha = await page.evaluate(() => {
          const url = window.location.href.toLowerCase();
          if (url.includes("captcha") || url.includes("puzzle")) return true;
          if (url.includes("/cvf/")) {
            if (document.querySelector("#cvf-aamation-challenge-iframe") || 
                document.querySelector(".cvf-aamation-iframe") || 
                document.querySelector("#cvf-aamation-container iframe") ||
                document.querySelector("script[src*='awswaf.com']") ||
                document.querySelector("iframe[src*='awswaf.com']")) {
              return true;
            }
          }
          if (document.querySelector("script[src*='awswaf.com']") || 
              document.querySelector("iframe[src*='captcha']") || 
              document.getElementById("cvf-aamation-container")) {
            const container = document.getElementById("cvf-aamation-container");
            if (container && container.innerHTML.trim().length > 0) {
              return true;
            }
          }
          return false;
        });
        if (!stillCaptcha) {
          console.log("✅ Captcha cleared. Resuming automation...");
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
}

async function detectState(page, timeoutMs = 5000) {
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
    // CVF request check (ensuring no visible OTP input is present)
    page.waitForFunction(() => {
      const sendBtn = document.querySelector("input[name='sendApprovalPath'], #cvf-submit-otp-button, input[name='cvf_action']");
      if (!sendBtn) return false;
      const otpSelectors = [
        "#input-box-otp", "#auth-mfa-otpcode", "#cvf-widget-input-code", "#cvf-input-code",
        "input[name='otpCode']", "input[name='code']", "input#cvf-a-input", "#cvf-otp-input", ".cvf-widget-input-code"
      ];
      for (const sel of otpSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return false;
      }
      return true;
    }, { timeout: timeoutMs }).then(() => ({ type: "cvf_request" })),
    // Approval needed check
    page.waitForFunction(() => {
      const url = window.location.href.toLowerCase();
      
      // If there's an active OTP input box, it's OTP screen, NOT approval page
      const otpSelectors = [
        "#input-box-otp", "#auth-mfa-otpcode", "#cvf-widget-input-code", "#cvf-input-code",
        "input[name='otpCode']", "input[name='code']", "input#cvf-a-input", "#cvf-otp-input", ".cvf-widget-input-code"
      ];
      for (const sel of otpSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return false;
      }
      
      return url.includes("transactionapproval") || 
             (url.includes("approval") && !url.includes("/cvf/")) || 
             document.body.textContent.toLowerCase().includes("approve this sign-in");
    }, { timeout: timeoutMs }).then(() => ({ type: "approval_needed" }))
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

// ==================== LOGIN FLOW ====================
async function runLoginFlowIfNeeded(page, email, currentPassword, imapConfig, startHeadless) {
  let attempts = 0;
  let triedPasswords = [currentPassword, "112233"];
  let passwordIdx = 0;
  let lastApprovedLink = "";

  while (attempts < 8) {
    attempts++;
    await checkForCaptcha(page, startHeadless);
    
    // Check if we are already logged in
    const loggedIn = await page.evaluate(() => {
      try {
        const url = window.location.href.toLowerCase();
        // If we are on account page, address book, or cnep and not signin/auth
        if (url.includes("/gp/css/homepage.html") || url.includes("/your-account") || (url.includes("/ap/cnep") && !url.includes("signin"))) {
          return true;
        }
        const navLine1 = document.querySelector("#nav-link-accountList-nav-line-1");
        if (navLine1 && !navLine1.textContent.toLowerCase().includes("sign in")) {
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    }).catch(() => false);

    if (loggedIn) {
      console.log("    ✅ Already logged in / success state reached!");
      return { success: true };
    }

    // If we are on the Change E-mail or Change your email address page, exit login flow to proceed with change
    const isEmailChangePage = await page.evaluate(() => {
      try {
        const url = window.location.href.toLowerCase();
        const hasNewEmailInput = document.querySelector("input[name='newEmail'], #ap_cnp_email, #cvfEmail, input[name='cvf_email'], #cvf-a-input") !== null;
        const isCnf = url.includes("/cvf/") || url.includes("/cnep");
        const bodyText = document.body ? document.body.textContent.toLowerCase() : "";
        const hasChangeHeader = bodyText.includes("change your email address") || bodyText.includes("change e-mail");
        return hasNewEmailInput && isCnf && hasChangeHeader;
      } catch (e) {
        return false;
      }
    }).catch(() => false);

    if (isEmailChangePage) {
      console.log("    ℹ️ Detected Email Change form. Exiting login flow to proceed with change...");
      return { success: true };
    }

    const nextStep = await detectState(page, 5000);
    if (!nextStep) {
      const onAuth = await page.evaluate(() => {
        const url = window.location.href.toLowerCase();
        return url.includes("/ap/") || url.includes("/signin") || url.includes("/cvf/");
      });
      if (!onAuth) {
        console.log("    ✅ Not on auth page. Assuming logged in successfully.");
        return { success: true };
      }
      console.log(`    🔍 No auth state detected (Attempt ${attempts}/8, URL: ${page.url()}). Waiting...`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    console.log(`    🔍 State detected: ${nextStep.type} (Attempt ${attempts}/8, URL: ${page.url()})`);

    // 1. Switch Accounts profile
    if (nextStep.type === "switch_accounts") {
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
      await new Promise(r => setTimeout(r, 3000));
      continue;
    }

    // 2. Email field
    if (nextStep.type === "email") {
      console.log(`    ✉️ Entering email: ${email}`);
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.value = ""; el.focus(); }
      }, nextStep.selector);
      await page.type(nextStep.selector, email, { delay: 100 });
      
      const continueSelector = await Promise.any([
        page.waitForSelector("#continue", { visible: true, timeout: 5000 }).then(() => "#continue"),
        page.waitForSelector("input[type='submit']", { visible: true, timeout: 5000 }).then(() => "input[type='submit']")
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
      continue;
    }

    // 3. Password field
    if (nextStep.type === "password") {
      const pass = triedPasswords[passwordIdx];
      console.log(`    🔑 Entering password (trying: ${pass})...`);
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.value = ""; el.focus(); }
      }, nextStep.selector);
      await page.type(nextStep.selector, pass, { delay: 100 });

      const signInSelector = await Promise.any([
        page.waitForSelector("#signInSubmit", { visible: true, timeout: 5000 }).then(() => "#signInSubmit"),
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

      const stillOnPwd = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el !== null && el.offsetParent !== null;
      }, nextStep.selector);

      if (stillOnPwd) {
        console.warn("    ⚠️ Password rejected or page failed to navigate.");
        if (passwordIdx + 1 < triedPasswords.length) {
          passwordIdx++;
          console.log("    🔄 Switching to alternative fallback password...");
        }
      }
      continue;
    }

    // 4. OTP code verification
    if (nextStep.type === "otp") {
      const otpSuccess = await handleOtpInput(page, nextStep.selector, imapConfig, email);
      if (!otpSuccess && startHeadless) {
        throw new Error("RELAUNCH_HEADED");
      }
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    // 5. CVF Request page
    if (nextStep.type === "cvf_request") {
      // FIRST: check if we are already on the email change form (has email input) — if so, exit the loop
      const onEmailChangeForm = await page.evaluate(() => {
        const hasEmailInput = document.querySelector("input[type='email'], input[name='cvf_email'], #cvfEmail, #ap_cnp_email, #cvf-a-input") !== null;
        const hasChangeHeader = document.body.textContent.toLowerCase().includes("change your email address");
        return hasEmailInput && hasChangeHeader;
      });

      if (onEmailChangeForm) {
        console.log("    ℹ️ Already on Change Email form. Exiting login flow to proceed with email input...");
        return { success: true };
      }

      console.log("    🔑 CVF Request screen: selecting OTP delivery channel...");
      await page.evaluate(() => {
        const radios = Array.from(document.querySelectorAll("input[type='radio']"));
        const emailRadio = radios.find(r => r.value.toLowerCase().includes("email") || r.id.toLowerCase().includes("email") || r.name.toLowerCase().includes("email"));
        if (emailRadio && !emailRadio.checked) {
          emailRadio.click();
        } else if (radios.length > 0 && !radios.some(r => r.checked)) {
          radios[0].click();
        }
      });
      await new Promise(r => setTimeout(r, 1000));

      const submitBtn = await Promise.any([
        page.waitForSelector("#cvf-submit-otp-button", { visible: true, timeout: 4000 }).then(() => "#cvf-submit-otp-button"),
        page.waitForSelector("input[type='submit']", { visible: true, timeout: 4000 }).then(() => "input[type='submit']")
      ]).catch(() => null);

      if (submitBtn) {
        await safeClick(page, submitBtn, "Clicked Send OTP option");
      }
      await new Promise(r => setTimeout(r, 3000));

      // After clicking, check again if we landed on the Change Email form
      const nowOnEmailChangeForm = await page.evaluate(() => {
        const hasEmailInput = document.querySelector("input[type='email'], input[name='cvf_email'], #cvfEmail, #ap_cnp_email, #cvf-a-input") !== null;
        const hasChangeHeader = document.body.textContent.toLowerCase().includes("change your email address");
        return hasEmailInput && hasChangeHeader;
      });

      if (nowOnEmailChangeForm) {
        console.log("    ℹ️ Navigated to Change Email form after Send OTP. Exiting login flow...");
        return { success: true };
      }

      continue;
    }

    // 6. Approval link approval
    if (nextStep.type === "approval_needed") {
      console.log("\n⚠️ [!] Sign-in Approval Required!");
      console.log("👉 Kripya apne mobile app par ya email inbox me jaakar is sign-in attempt ko MANUALLY APPROVE (Yes, it's me) kijiye.");
      console.log("⏳ Script wait kar rahi hai aapke approval ka...");

      const approvalTimeout = 90000; // 90 seconds wait
      const checkInterval = 3000;
      const startTime = Date.now();
      let approvedState = false;

      while (Date.now() - startTime < approvalTimeout) {
        await new Promise(r => setTimeout(r, checkInterval));
        
        // Check if we navigated away from approval page (or if OTP box became visible)
        const stillApproval = await page.evaluate(() => {
          const url = window.location.href.toLowerCase();
          
          // If OTP box is visible, we are no longer on the approval page (it is OTP page now)
          const otpSelectors = [
            "#input-box-otp", "#auth-mfa-otpcode", "#cvf-widget-input-code", "#cvf-input-code",
            "input[name='otpCode']", "input[name='code']", "input#cvf-a-input", "#cvf-otp-input", ".cvf-widget-input-code"
          ];
          for (const sel of otpSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) return false;
          }
          
          return url.includes("transactionapproval") || 
                 (url.includes("approval") && !url.includes("/cvf/")) || 
                 document.body.textContent.toLowerCase().includes("approve this sign-in");
        });

        if (!stillApproval) {
          console.log("✅ Approval detected! Resuming automation...");
          approvedState = true;
          break;
        }
        
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`    ⏳ Waiting for manual approval... (${elapsed}s elapsed)`);
      }

      if (!approvedState) {
        console.warn("    ❌ Approval timeout. Restarting login check...");
      }
      continue;
    }
  }

  return { success: false };
}

// ==================== PROCESS ACCOUNT EMAIL CHANGE ====================
async function processEmailChange(email, targetEmail, amazonPassword, loginImapConfig, newEmailImapConfig, startHeadless = true) {
  console.log(`\n======================================================`);
  console.log(`🔒 Changing email: ${email} ➡️ ${targetEmail}`);
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
    // 1. Inject existing cookies if any
    const existingCookies = await cookiesHelper.readCookies(email);
    if (existingCookies && existingCookies.length > 0) {
      await page.setCookie(...existingCookies);
      console.log("    📦 Injected existing session cookies.");
    }

    // 2. Go to homepage
    console.log("    🌐 Navigating to Amazon.in...");
    await page.goto("https://www.amazon.in", { waitUntil: "networkidle2", timeout: 90000 });
    await checkForCaptcha(page, startHeadless);

    // 3. Click sign-in if not logged in
    const isLoggedIn = await page.evaluate(() => {
      const accountText = document.querySelector("#nav-link-accountList-nav-line-1");
      return accountText && !accountText.textContent.toLowerCase().includes("sign in");
    });

    if (!isLoggedIn) {
      console.log("    ➡️ Clicking Sign In button...");
      await page.click("#nav-link-accountList").catch(() => {});
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
      await runLoginFlowIfNeeded(page, email, amazonPassword, loginImapConfig, startHeadless);
    }

    // 4. Navigate to Your Account page to dynamically find the Login & Security link
    console.log("    🌐 Navigating to Your Account homepage...");
    await page.goto("https://www.amazon.in/gp/css/homepage.html", { waitUntil: "networkidle2", timeout: 90000 });
    await runLoginFlowIfNeeded(page, email, amazonPassword, loginImapConfig, startHeadless);

    console.log("    🔍 Searching for Login & Security link...");
    const loginSecurityHref = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a"));
      // Try by text first
      let anchor = anchors.find(a => {
        const text = a.textContent.toLowerCase();
        return text.includes("login & security") || text.includes("login and security") || text.includes("security settings");
      });
      // Try by href keywords if text not found
      if (!anchor) {
        anchor = anchors.find(a => {
          const href = (a.getAttribute("href") || "").toLowerCase();
          return href.includes("login-security") || href.includes("cnep") || href.includes("identity");
        });
      }
      return anchor ? anchor.getAttribute("href") : null;
    });

    let targetSecurityUrl = "https://www.amazon.in/ap/cnep";
    if (loginSecurityHref) {
      targetSecurityUrl = loginSecurityHref.startsWith("http") ? loginSecurityHref : "https://www.amazon.in" + loginSecurityHref;
      console.log(`    📌 Found Login & Security URL: ${targetSecurityUrl}`);
    } else {
      console.log("    ⚠️ Login & Security link not found on Your Account page. Falling back to default /ap/cnep");
    }

    console.log(`    🌐 Navigating to Login & Security page...`);
    await page.goto(targetSecurityUrl, { waitUntil: "networkidle2", timeout: 90000 });
    await runLoginFlowIfNeeded(page, email, amazonPassword, loginImapConfig, startHeadless);

    // 5. Wait for and click Edit Email button
    console.log("    ⏳ Waiting for Edit Email button...");
    try {
      await page.waitForSelector("#auth-cnep-edit-email-button", { visible: true, timeout: 20000 });
    } catch (selectorErr) {
      console.warn("    ⚠️ Failed to find Edit Email button. Dumping page info for debugging...");
      const artifactDir = "C:/Users/vinod/.gemini/antigravity/brain/7f101878-0f06-4134-9390-ae2140b6fc7e";
      const screenshotPath = path.join(artifactDir, "cnep_error_screenshot.png");
      const htmlPath = path.join(artifactDir, "cnep_error_source.html");
      
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        const html = await page.evaluate(() => document.body.innerHTML);
        fs.writeFileSync(htmlPath, html, "utf8");
        console.log(`    📸 Debug screenshot saved to ${screenshotPath}`);
        console.log(`    📄 Debug HTML saved to ${htmlPath}`);
      } catch (dumpErr) {
        console.error("    ❌ Failed to save debug info:", dumpErr.message);
      }
      throw selectorErr;
    }
    console.log("    ➡️ Clicking Edit Email button...");
    await page.click("#auth-cnep-edit-email-button");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
    await runLoginFlowIfNeeded(page, email, amazonPassword, loginImapConfig, startHeadless);

    // 6. Enter new email
    const emailInputSelector = await Promise.any([
      page.waitForSelector("#ap_email", { visible: true, timeout: 10000 }).then(() => "#ap_email"),
      page.waitForSelector("input[name='newEmail']", { visible: true, timeout: 10000 }).then(() => "input[name='newEmail']"),
      page.waitForSelector("#ap_cnp_email", { visible: true, timeout: 10000 }).then(() => "#ap_cnp_email"),
      page.waitForSelector("#cvfEmail", { visible: true, timeout: 10000 }).then(() => "#cvfEmail"),
      page.waitForSelector("input[name='cvf_email']", { visible: true, timeout: 10000 }).then(() => "input[name='cvf_email']"),
      page.waitForSelector("input[type='email']", { visible: true, timeout: 10000 }).then(() => "input[type='email']"),
      page.waitForSelector("#cvf-a-input", { visible: true, timeout: 10000 }).then(() => "#cvf-a-input")
    ]);

    let inputAttempts = 0;
    let inputSuccess = false;
    
    while (inputAttempts < 3 && !inputSuccess) {
      inputAttempts++;
      console.log(`    📝 Entering new email (Attempt ${inputAttempts}/3)...`);
      
      // Focus, select all, and delete using keyboard natively to ensure clean state
      try {
        await page.focus(emailInputSelector);
        // Select all text using keyboard commands
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 200));
        
        // Clear value using evaluate just to be absolutely sure
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.value = "";
        }, emailInputSelector);
        
        // Type the email natively
        await page.type(emailInputSelector, targetEmail, { delay: 50 });
      } catch (e) {
        console.warn("    ⚠️ Native typing issue:", e.message);
      }
      
      // Verify value was correctly set
      const currentValue = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.value : "";
      }, emailInputSelector);
      
      if (currentValue.toLowerCase().trim() === targetEmail.toLowerCase().trim()) {
        console.log("    ✅ Target email populated in input element matches target.");
        inputSuccess = true;
      } else {
        console.warn(`    ⚠️ Input text mismatch. Got: "${currentValue}", Expected: "${targetEmail}". Retrying...`);
      }
    }
    
    // Click submit
    console.log("    ➡️ Clicking Continue...");
    const continueBtnSelector = await Promise.any([
      page.waitForSelector("#cnp_submit_button", { visible: true, timeout: 5000 }).then(() => "#cnp_submit_button"),
      page.waitForSelector("input[type='submit']", { visible: true, timeout: 5000 }).then(() => "input[type='submit']"),
      page.waitForSelector("#ap_cnp_email_submit_button", { visible: true, timeout: 5000 }).then(() => "#ap_cnp_email_submit_button"),
      page.waitForSelector("input[name='cvf_action']", { visible: true, timeout: 5000 }).then(() => "input[name='cvf_action']"),
      page.waitForSelector("#cvf-submit-otp-button", { visible: true, timeout: 5000 }).then(() => "#cvf-submit-otp-button")
    ]);
    await safeClick(page, continueBtnSelector, "Clicked continue email change");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});

    // 7. Input email change OTP (sent to new email targetEmail)
    console.log("    ⏳ Waiting for OTP screen for new email...");
    const emailOtpSelector = await Promise.any([
      page.waitForSelector("#cvf-input-code", { visible: true, timeout: 15000 }).then(() => "#cvf-input-code"),
      page.waitForSelector("input[name='code']", { visible: true, timeout: 15000 }).then(() => "input[name='code']"),
      page.waitForSelector("#cvf-widget-input-code", { visible: true, timeout: 15000 }).then(() => "#cvf-widget-input-code"),
      page.waitForSelector("#ap_email_otp", { visible: true, timeout: 15000 }).then(() => "#ap_email_otp"),
      page.waitForSelector("#input-box-otp", { visible: true, timeout: 15000 }).then(() => "#input-box-otp")
    ]);

    console.log(`    🔑 Polling OTP for new email: ${targetEmail}`);
    const changeOtp = await pollForAmazonOtp(newEmailImapConfig, targetEmail);
    if (!changeOtp) {
      throw new Error(`Failed to retrieve email verification OTP for ${targetEmail}`);
    }

    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.value = "";
    }, emailOtpSelector);
    await page.type(emailOtpSelector, changeOtp, { delay: 100 });
    await new Promise(r => setTimeout(r, 1000));
    
    // Try multiple ways to click/submit the verify OTP button
    console.log("    ➡️ Clicking Verify email address button...");
    const clicked = await page.evaluate(() => {
      const selectors = [
        "input[name='cvf_action']",
        "#cvf-submit-otp-button-announce",
        "#cvf-submit-otp-button",
        "span.a-button-inner input[type='submit']",
        ".a-button-input",
        "input[type='submit']"
      ];
      
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollIntoView({ block: "center" });
          // Click the element itself
          el.click();
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          
          // Also click the parent container if it's a styled button
          const parent = el.closest(".a-button-inner") || el.closest(".a-button");
          if (parent) {
            parent.click();
            parent.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
          return true;
        }
      }
      return false;
    });

    if (clicked) {
      console.log("    ✅ Triggered click on verification button via JS evaluation.");
    } else {
      console.log("    ⚠️ Could not find verification button via JS evaluation selectors. Attempting Puppeteer native click...");
    }

    // Also attempt native Puppeteer click on the text span or the button inner wrapper
    try {
      await page.click("#cvf-submit-otp-button-announce").catch(() => {});
      await page.click("input[name='cvf_action']").catch(() => {});
    } catch (err) {
      console.log("    ⚠️ Native click error:", err.message);
    }
    
    // Wait for page to settle after clicking verify
    await new Promise(r => setTimeout(r, 2000));
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    
    const afterVerifyUrl = page.url();
    console.log(`    📍 URL after verify click: ${afterVerifyUrl}`);

    // 8. Confirm Password to finalize
    console.log("    ⏳ Checking if password confirmation is required...");
    const pwdConfirmSelector = await Promise.any([
      page.waitForSelector("#ap_password", { visible: true, timeout: 15000 }).then(() => "#ap_password"),
      page.waitForSelector("input[type='password']", { visible: true, timeout: 15000 }).then(() => "input[type='password']"),
      page.waitForSelector("input[name='password']", { visible: true, timeout: 15000 }).then(() => "input[name='password']")
    ]).catch(() => null);

    if (!pwdConfirmSelector) {
      console.log(`    ⚠️ No password page found. Current URL: ${page.url()}`);
      console.log(`    ⚠️ Page text preview: ${(await page.evaluate(() => document.body ? document.body.innerText.substring(0, 300) : "").catch(() => ""))}`);
    }

    if (pwdConfirmSelector) {
      let isFinalized = false;
      const passwords = [amazonPassword, "112233"];
      
      for (const pass of passwords) {
        console.log(`    🔑 Entering password to save changes (trying: ${pass})...`);
        
        // Clear and type password
        await page.focus(pwdConfirmSelector);
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 300));
        await page.type(pwdConfirmSelector, pass, { delay: 80 });
        await new Promise(r => setTimeout(r, 1000));
        
        // Debug: log all buttons/inputs found on page
        const pageButtons = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll("input[type='submit'], button[type='submit'], button"));
          return btns.map(b => ({ tag: b.tagName, id: b.id, name: b.name, value: b.value, text: b.textContent.trim().substring(0, 50) }));
        });
        console.log(`    🔍 Buttons found on page:`, JSON.stringify(pageButtons));
        
        // Try form.submit() — most reliable way
        const submitted = await page.evaluate((sel) => {
          const pwdEl = document.querySelector(sel);
          const form = pwdEl ? pwdEl.closest('form') : null;
          if (form) {
            // Try requestSubmit first (triggers validation)
            if (typeof form.requestSubmit === 'function') {
              form.requestSubmit();
              return "requestSubmit";
            } else {
              form.submit();
              return "submit";
            }
          }
          return "no_form";
        }, pwdConfirmSelector);
        console.log(`    ➡️ Form submit result: ${submitted}`);
        
        // Also click the button directly as fallback
        try {
          await page.click("#cnep_1D_submit_button").catch(() => {});
        } catch(e) {}
        try {
          await page.click("input[type='submit']").catch(() => {});
        } catch(e) {}
        try {
          await page.click("#a-autoid-0-announce").catch(() => {});
        } catch(e) {}
        
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
        console.log(`    📍 URL after Save Changes: ${page.url()}`);
        
        const stillOnConfirm = await page.evaluate(() => {
          return document.querySelector("#ap_password, input[type='password']") !== null;
        }).catch(() => false);
        
        if (!stillOnConfirm) {
          isFinalized = true;
          break;
        }
        console.warn("    ⚠️ Password confirmation failed. Trying next password...");
      }

      if (!isFinalized) {
        throw new Error("Password confirmation failed for all passwords.");
      }
    }

    // 9. Verify success
    console.log("    🔍 Verifying email change success...");
    const currentUrl = page.url();
    console.log(`    📍 Current URL after save: ${currentUrl}`);
    
    const isSuccess = await page.evaluate((target) => {
      try {
        const url = window.location.href.toLowerCase();
        // If still on a password page, not done yet
        const stillHasPassword = document.querySelector("#ap_password, input[type='password']") !== null;
        if (stillHasPassword) return false;

        // If on signin/register = FAIL
        if (url.includes("/signin") || url.includes("create_account") || url.includes("register")) return false;

        const bodyText = document.body ? document.body.textContent.toLowerCase() : "";
        
        // ONLY real success: back on cnep page with new email visible
        const isCnepSuccess = url.includes("/ap/cnep") && bodyText.includes(target.toLowerCase());
        
        return isCnepSuccess;
      } catch (e) {
        return false;
      }
    }, targetEmail);

    if (isSuccess) {
      console.log(`    ✅ Success! Email changed to: ${targetEmail}`);
      const cookies = await page.cookies();
      
      // Save cookies under new email address
      await cookiesHelper.saveCookies(targetEmail, cookies);
      
      // Save progress status
      saveChangedStatus(email, targetEmail);
      
      // Clean up old cookies from local cookie storage if exists
      try {
        const COOKIES_FILE = path.join(__dirname, "..", "data", "a.json");
        if (fs.existsSync(COOKIES_FILE)) {
          const all = JSON.parse(fs.readFileSync(COOKIES_FILE, "utf8"));
          if (all[email]) {
            delete all[email];
            fs.writeFileSync(COOKIES_FILE, JSON.stringify(all, null, 2), "utf8");
          }
        }
      } catch (_) {}
      
      await browser.close();
      return true;
    } else {
      throw new Error("Could not verify email change success. Page content check failed.");
    }

  } catch (err) {
    await browser.close();
    if (err.message === "RELAUNCH_HEADED") {
      throw err;
    }
    console.error(`    ❌ Failed:`, err.message);
    return false;
  }
}

// ==================== MAIN RUNNER ====================
async function main() {
  const catTxtPath = path.join(__dirname, "..", "change", "cat.txt");
  
  if (!fs.existsSync(catTxtPath)) {
    console.error(`❌ Error: ${catTxtPath} does not exist.`);
    process.exit(1);
  }

  // Parse CLI args to get --user-id
  const argsTemp = process.argv.slice(2);
  const userIdxTemp = argsTemp.indexOf("--user-id");
  const targetUserId = userIdxTemp !== -1 && userIdxTemp + 1 < argsTemp.length ? parseInt(argsTemp[userIdxTemp + 1], 10) : 1;

  console.log(`ℹ️ Target User ID: ${targetUserId}`);

  // Load Target User IMAP Config (for login approvals)
  let loginImapConfig = null;
  let user1AmazonPassword = null;

  // Try to load from Database first if db helper is configured
  if (db) {
    try {
      const u1 = await db.getUser(targetUserId);
      if (u1) {
        loginImapConfig = u1.imapConfig;
        user1AmazonPassword = u1.amazonPassword;
        console.log(`ℹ️ Successfully loaded User ${targetUserId} IMAP configuration from Database (VPS/Local).`);
      }
    } catch (dbErr) {
      console.warn(`⚠️ Failed to load User ${targetUserId} from database:`, dbErr.message);
    }
  }

  // Fallback: Try to load from db_export/users.json if database fetch failed or was not configured
  if (!loginImapConfig || !user1AmazonPassword) {
    const usersJsonPath = path.join(__dirname, "..", "db_export", "users.json");
    if (fs.existsSync(usersJsonPath)) {
      try {
        const users = JSON.parse(fs.readFileSync(usersJsonPath, "utf8"));
        const u1 = users.find(u => u.id === targetUserId);
        if (u1) {
          loginImapConfig = {
            host: u1.imap_host,
            port: u1.imap_port,
            secure: u1.imap_secure,
            user: u1.imap_user,
            password: u1.imap_password
          };
          user1AmazonPassword = u1.amazon_password;
          console.log(`ℹ️ Loaded User ${targetUserId} IMAP configuration from local users.json fallback.`);
        }
      } catch (e) {
        console.error("Error reading users.json:", e.message);
      }
    }
  }

  if (!loginImapConfig || !loginImapConfig.user || !loginImapConfig.password) {
    console.error(`❌ Error: Could not load User ${targetUserId} IMAP configuration from database or users.json`);
    process.exit(1);
  }

  // Load new email OTP IMAP config — vkkykh@kanuvk.com inbox
  // This account receives the "Verify your new Amazon account" emails
  // because all @kanuvk.com addresses (including +alias ones) go to this mailbox
  let newEmailImapConfig = {
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    user: "vkkykh@kanuvk.com",
    password: "lwea zcdi nohp dhho"
  };
  console.log(`ℹ️ Using vkkykh@kanuvk.com IMAP for 2nd OTP (email verification emails).`);

  if (!user1AmazonPassword) {
    console.error(`❌ Error: Could not load User ${targetUserId} Amazon Password from database or users.json`);
    process.exit(1);
  }

  const content = fs.readFileSync(catTxtPath, "utf8");
  const lines = content.split(/\r?\n/);
  const accounts = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.includes("@")) {
      const gmail = trimmed;
      const kanuvk = trimmed.replace(/\+/, "").replace(/@gmail\.com$/i, "@kanuvk.com");
      accounts.push({ gmail, kanuvk });
    }
  }

  console.log(`📋 Loaded ${accounts.length} accounts to convert.`);
  
  const status = getChangedStatus();
  const pendingAccounts = accounts.filter(acc => !status[acc.gmail.toLowerCase()]);
  
  console.log(`🔄 Already processed : ${accounts.length - pendingAccounts.length}`);
  console.log(`🔄 Pending conversion : ${pendingAccounts.length}\n`);

  if (pendingAccounts.length === 0) {
    console.log("🎉 All accounts have already been successfully processed!");
    process.exit(0);
  }

  // CLI Options
  const args = process.argv.slice(2);
  const startHeadless = args.includes("--headless") || !args.includes("--browser");

  // CLI Option for range: e.g. --range 1-20
  const rangeIdx = args.indexOf("--range");
  let rangeStart = 1;
  let rangeEnd = pendingAccounts.length;
  if (rangeIdx !== -1 && rangeIdx + 1 < args.length) {
    const rangeMatch = args[rangeIdx + 1].match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      rangeStart = parseInt(rangeMatch[1], 10);
      rangeEnd = parseInt(rangeMatch[2], 10);
    }
  }

  const startIdx = Math.max(0, rangeStart - 1);
  const endIdx = Math.min(pendingAccounts.length, rangeEnd);
  const slicedAccounts = pendingAccounts.slice(startIdx, endIdx);

  console.log(`🎯 Applying range: ${rangeStart}-${rangeEnd}. Selected ${slicedAccounts.length} pending accounts to process.`);

  if (slicedAccounts.length === 0) {
    console.log("🎉 No pending accounts found in the specified range!");
    process.exit(0);
  }

  // CLI Options for IP rotation
  const rotateIdx = args.indexOf("--rotate-every");
  const rotateEvery = rotateIdx !== -1 && rotateIdx + 1 < args.length ? parseInt(args[rotateIdx + 1], 10) : 0;
  
  const waitOnIdx = args.indexOf("--wait-on");
  const waitOn = waitOnIdx !== -1 && waitOnIdx + 1 < args.length ? parseInt(args[waitOnIdx + 1], 10) : 4;
  
  const waitReconnectIdx = args.indexOf("--wait-reconnect");
  const waitReconnect = waitReconnectIdx !== -1 && waitReconnectIdx + 1 < args.length ? parseInt(args[waitReconnectIdx + 1], 10) : 30;

  let currentIp = "";
  if (rotateEvery > 0 && adb) {
    try {
      console.log("...Initializing IP rotator...");
      await adb.checkAdbStatus();
      currentIp = await adb.getPublicIp();
      console.log(`📱 Current Mobile IP: ${currentIp}`);
      
      // Perform initial IP rotation before starting processing
      console.log("🔄 Performing initial IP rotation before starting first account...");
      const newIp = await adb.rotateIp(currentIp, {
        waitOnSec: waitOn,
        waitReconnectSec: waitReconnect
      });
      currentIp = newIp;
    } catch (err) {
      console.warn("⚠️ ADB/IP check/rotation warning:", err.message);
    }
  }

  let processedSinceRotation = 0;

  for (let i = 0; i < slicedAccounts.length; i++) {
    const acc = slicedAccounts[i];
    console.log(`\n💼 Account [${i + 1}/${slicedAccounts.length}] (Overall Pending index: ${startIdx + i + 1})`);
    
    let success = false;
    try {
      success = await processEmailChange(acc.gmail, acc.kanuvk, user1AmazonPassword, loginImapConfig, newEmailImapConfig, startHeadless);
    } catch (err) {
      if (err.message === "RELAUNCH_HEADED") {
        console.log("🔄 Relaunching in HEADED mode (browser visible) to resolve Captcha/Challenge...");
        try {
          success = await processEmailChange(acc.gmail, acc.kanuvk, user1AmazonPassword, loginImapConfig, newEmailImapConfig, false);
        } catch (retryErr) {
          console.error("    ❌ Retry failed:", retryErr.message);
        }
      }
    }

    if (success) {
      console.log(`  🟢 Successfully changed ${acc.gmail} to ${acc.kanuvk}`);
    } else {
      console.log(`  🔴 Failed for ${acc.gmail}. Skipping to next...`);
    }

    // IP Rotation check
    if (success) {
      processedSinceRotation++;
      if (rotateEvery > 0 && processedSinceRotation >= rotateEvery && adb) {
        console.log(`🔄 Reached rotate limit (${rotateEvery} accounts). Rotating IP...`);
        try {
          const newIp = await adb.rotateIp(currentIp, {
            waitOnSec: waitOn,
            waitReconnectSec: waitReconnect
          });
          currentIp = newIp;
          processedSinceRotation = 0;
        } catch (err) {
          console.error("⚠️ Failed to rotate IP:", err.message);
        }
      }
    }
    
    // Cool down between accounts
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log("\n🏁 Finished processing all pending accounts.");
}

main().catch(console.error);
