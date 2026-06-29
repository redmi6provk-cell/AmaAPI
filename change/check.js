/**
 * check.js
 * --------
 * cat.txt se emails padho, Amazon login page pe sirf email dalo,
 * Continue click karo aur check karo.
 *
 * ✔️  EXISTS → password page aya = email registered = unchanged.json mein save
 * 🆕 NEW    → "new to Amazon" aya = email registered nahi = skip
 * ❌ ERROR  → koi dikkat = error_emails.txt
 *
 * ✅ RESUME support: jahan se ruka wahan se shuru hoga
 * ✅ Browser crash recovery: auto reopen
 * ✅ IP rotation: ADB airplane mode toggle (settings.json → rotateEvery)
 *
 * Usage:  node check.js          ← resume karo (ya fresh start)
 *         node check.js --fresh  ← poora fresh start (progress delete)
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');

// ─── ADB IP Rotation (same as main project) ───────────────────────────────
let adb = null;
try {
  adb = require('../src/adb_helper');
} catch (e) {
  console.warn('⚠️  adb_helper load nahi hua — IP rotation disabled:', e.message);
}

// settings.json se rotateEvery load karo
let ROTATE_EVERY = 10; // default: har 10 emails
try {
  const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/settings.json'), 'utf8'));
  if (settings.ipRotation?.enabled && settings.ipRotation?.rotateEvery) {
    ROTATE_EVERY = settings.ipRotation.rotateEvery;
  }
} catch (e) {}

// ─── Config ────────────────────────────────────────────────────────────────
const INPUT_FILE     = path.join(__dirname, 'cat.txt');
const UNCHANGED_FILE = path.join(__dirname, 'unchanged.json');   // EXISTS emails
const ERROR_FILE     = path.join(__dirname, 'error_emails.txt');
const PROGRESS_FILE  = path.join(__dirname, 'progress.json');    // resume ke liye
const DEBUG_DIR      = path.join(__dirname, 'debug_ss');

const AMAZON_LOGIN = 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0';

const DELAY_BETWEEN_MS = 500;
const PAGE_TIMEOUT_MS  = 20000;
// ────────────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function appendLine(filePath, line) {
  fs.appendFileSync(filePath, line + '\n', 'utf8');
}

function loadEmails(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(e => e.trim())
    .filter(e => e.length > 0 && e.includes('@'));
}

// ─── Progress helpers ──────────────────────────────────────────────────────
function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (e) {}
  }
  return { lastIndex: -1 }; // -1 = fresh start
}

function saveProgress(index) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastIndex: index }, null, 2), 'utf8');
}

function clearProgress() {
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
}

// ─── Browser / Page helper ─────────────────────────────────────────────────
async function makeBrowser() {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
    defaultViewport: null,
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
  );
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, page };
}

// ─── detectEmailState ──────────────────────────────────────────────────────
async function detectEmailState(page, timeoutMs = 6000) {
  return Promise.any([
    page.waitForSelector('#ap_email',            { visible: true, timeout: timeoutMs }).then(() => ({ type: 'email', selector: '#ap_email' })),
    page.waitForSelector('#ap_email_login',      { visible: true, timeout: timeoutMs }).then(() => ({ type: 'email', selector: '#ap_email_login' })),
    page.waitForSelector("input[name='email']",  { visible: true, timeout: timeoutMs }).then(() => ({ type: 'email', selector: "input[name='email']" })),
    page.waitForSelector('#ap_password',         { visible: true, timeout: timeoutMs }).then(() => ({ type: 'password' })),
    page.waitForSelector("input[name='password']",{ visible: true, timeout: timeoutMs }).then(() => ({ type: 'password' })),
  ]).catch(() => null);
}

// ─── safeClick ─────────────────────────────────────────────────────────────
async function safeClick(page, selector) {
  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'not_found';
    el.scrollIntoView({ block: 'center' });
    try {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }));
    } catch (e) {}
    try { el.click(); } catch (e) {}
    return 'clicked';
  }, selector);
  if (result === 'not_found') {
    try { await page.click(selector); } catch (e) {}
  }
}

// ─── checkEmail ────────────────────────────────────────────────────────────
async function checkEmail(page, email) {
  try {
    await page.goto(AMAZON_LOGIN, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await sleep(300);

    const state = await detectEmailState(page, 6000);

    if (!state) {
      if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
      await page.screenshot({ path: path.join(DEBUG_DIR, `err_${Date.now()}.png`), fullPage: true });
      const txt = await page.evaluate(() => document.body.innerText.substring(0, 300));
      return { status: 'ERROR', error: `Field nahi mila. Page: "${txt.replace(/\n/g,' ')}"` };
    }

    if (state.type === 'password') return { status: 'EXISTS', error: null };

    // Email type karo
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.value = ''; el.focus(); }
    }, state.selector);
    await page.type(state.selector, email, { delay: 30 });

    // Continue click
    const continueSelector = await Promise.any([
      page.waitForSelector('#continue',           { visible: true, timeout: 5000 }).then(() => '#continue'),
      page.waitForSelector("input[type='submit']",{ visible: true, timeout: 5000 }).then(() => "input[type='submit']"),
    ]).catch(() => null);

    if (!continueSelector) return { status: 'ERROR', error: 'Continue button nahi mila' };
    await safeClick(page, continueSelector);

    // Email field disappear hone ka wait
    try {
      await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        return !el || el.offsetParent === null;
      }, { timeout: 8000 }, state.selector);
    } catch (e) {
      await page.evaluate((sel) => {
        const form = document.querySelector(sel)?.closest('form');
        if (form) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
        }
      }, state.selector);
      await sleep(3000);
    }

    await sleep(800);
    const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());

    const isNew = bodyText.includes('new to amazon') ||
                  bodyText.includes("let's create an account") ||
                  bodyText.includes('create account') ||
                  bodyText.includes('mobile number');

    return { status: isNew ? 'NEW' : 'EXISTS', error: null };

  } catch (err) {
    return { status: 'ERROR', error: err.message.substring(0, 200) };
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const isFresh = process.argv.includes('--fresh');

  console.log('📂 Emails load kar raha hoon:', INPUT_FILE);
  const emails = loadEmails(INPUT_FILE);
  console.log(`✅ Total emails: ${emails.length}`);

  // ── Resume check ──
  let startIndex = 0;
  if (isFresh) {
    // Fresh start — sab reset karo
    fs.writeFileSync(UNCHANGED_FILE, JSON.stringify([], null, 2), 'utf8');
    fs.writeFileSync(ERROR_FILE, '', 'utf8');
    clearProgress();
    console.log('🔄 Fresh start — sab reset kiya');
  } else {
    const prog = loadProgress();
    startIndex = prog.lastIndex + 1; // pichli baar kahan ruka
    if (startIndex > 0) {
      console.log(`⏩ RESUME: ${startIndex} emails already done — ${emails[startIndex] || '?'} se shuru hoga`);
    } else {
      // Pehli baar — files init karo
      if (!fs.existsSync(UNCHANGED_FILE)) fs.writeFileSync(UNCHANGED_FILE, JSON.stringify([], null, 2), 'utf8');
      if (!fs.existsSync(ERROR_FILE))     fs.writeFileSync(ERROR_FILE, '', 'utf8');
    }
  }

  console.log('─'.repeat(60));

  // ── Counts pichle run se load karo ──
  let existCount = 0, newCount = 0, errorCount = 0;
  try {
    const arr = JSON.parse(fs.readFileSync(UNCHANGED_FILE, 'utf8'));
    existCount = arr.length;
  } catch (e) {}

  // ── ADB IP rotation status check ──
  if (adb) {
    const status = await adb.checkAdbStatus().catch(() => ({ adbFound: false }));
    if (status.adbFound && status.deviceConnected) {
      console.log(`📱 ADB device connected — IP rotation har ${ROTATE_EVERY} emails pe hogi`);
    } else {
      if (status.state === 'unauthorized') {
        console.warn(`⚠️  ADB device connected but UNAUTHORIZED! Please allow USB debugging on your phone.`);
      } else if (status.state === 'offline') {
        console.warn(`⚠️  ADB device is OFFLINE! Try reconnecting the USB cable.`);
      } else {
        console.log('⚠️  ADB device nahi mila — IP rotation disabled (script chalti rahegi)');
      }
      adb = null; // disable rotation
    }
  } else {
    console.log(`⚠️  IP rotation disabled`);
  }

  // ── Browser launch ──
  let { browser, page } = await makeBrowser();

  let processedSinceRotation = 0;
  for (let i = startIndex; i < emails.length; i++) {
    const email = emails[i];
    const idx   = String(i + 1).padStart(3, '0');

    // Browser crash recovery
    let result;
    try {
      result = await checkEmail(page, email);

      // Agar page crash ho gaya toh browser restart karo
      if (result.status === 'ERROR' &&
          (result.error.includes('Target closed') ||
           result.error.includes('detached Frame') ||
           result.error.includes('Session closed'))) {
        console.log('  🔁 Browser crash detect hua — restart kar raha hoon...');
        try { await browser.close(); } catch (e) {}
        await sleep(2000);
        ({ browser, page } = await makeBrowser());
        // Retry same email
        result = await checkEmail(page, email);
      }
    } catch (fatalErr) {
      result = { status: 'ERROR', error: fatalErr.message.substring(0, 200) };
    }

    // ── Result save karo ──
    if (result.status === 'NEW') {
      newCount++;
      console.log(`[${idx}/${emails.length}] 🆕 NEW (skip) → ${email}`);
    } else if (result.status === 'EXISTS') {
      const arr = JSON.parse(fs.readFileSync(UNCHANGED_FILE, 'utf8'));
      arr.push(email);
      fs.writeFileSync(UNCHANGED_FILE, JSON.stringify(arr, null, 2), 'utf8');
      existCount++;
      console.log(`[${idx}/${emails.length}] ✔️  EXISTS  → ${email}  ✅ saved`);
    } else {
      appendLine(ERROR_FILE, `${email} | ${result.error}`);
      errorCount++;
      console.log(`[${idx}/${emails.length}] ❌ ERROR   → ${email}`);
      console.log(`              ${result.error}`);
    }

    // Progress save karo (har email ke baad)
    saveProgress(i);

    // ── IP Rotation ──
    // Har ROTATE_EVERY emails ke baad airplane mode toggle karo
    processedSinceRotation++;
    if (adb && processedSinceRotation >= ROTATE_EVERY && i < emails.length - 1) {
      console.log(`\n  ✈️  [IP Rotation] Reached limit of ${ROTATE_EVERY} emails — IP change kar raha hoon...`);
      try {
        await adb.enableAirplaneMode();
        await sleep(4000); // phone airplane mode ON ho jaye
        await adb.disableAirplaneMode(8000); // OFF karo + reconnect wait
        // Naya IP dikhao
        try {
          const newIp = await adb.getPhoneCellularIp();
          if (newIp) console.log(`  🌐 Naya IP: ${newIp}`);
        } catch (e) {}
        console.log(`  ✅ IP rotation complete — continue...\n`);
        processedSinceRotation = 0; // Reset counter
      } catch (rotErr) {
        console.log(`  ⚠️  IP rotation fail hua: ${rotErr.message} — continue kar raha hoon`);
      }
    }

    if (i < emails.length - 1) await sleep(DELAY_BETWEEN_MS);
  }

  await browser.close();
  clearProgress(); // done — progress file hata do

  console.log('\n' + '═'.repeat(60));
  console.log('📊 SUMMARY');
  console.log('═'.repeat(60));
  console.log(`✔️  Registered → unchanged.json  : ${existCount}`);
  console.log(`🆕 New to Amazon (skipped)       : ${newCount}`);
  console.log(`❌ Errors → error_emails.txt      : ${errorCount}`);
  console.log('═'.repeat(60));
  console.log('✅ Done!');
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
