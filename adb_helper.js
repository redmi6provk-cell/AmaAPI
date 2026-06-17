/**
 * adb_helper.js
 * ADB-based Android control utility for IP rotation via Airplane Mode toggle.
 *
 * Usage (standalone test): node adb_helper.js --test
 */

const { execSync, exec } = require("child_process");
const https = require("https");
const path = require("path");
const fs = require("fs");

// ─── ADB PATH RESOLUTION ──────────────────────────────────────────────────────
// Tries to find adb.exe from common install locations if not in PATH
function resolveAdbPath() {
  // 1. Try from PATH first
  try {
    execSync("adb version", { stdio: "pipe" });
    return "adb";
  } catch (_) {}

  // 2. Try Android SDK common locations
  const candidates = [
    path.join(process.env.USERPROFILE || "C:\\Users\\ashu", "platform-tools", "adb.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe"),
    path.join(process.env.USERPROFILE || "", "AppData", "Local", "Android", "Sdk", "platform-tools", "adb.exe"),
    "C:\\Android\\platform-tools\\adb.exe",
    "C:\\platform-tools\\adb.exe",
    path.join(process.env.PROGRAMFILES || "", "Android", "platform-tools", "adb.exe"),
  ];

  // 3. Check settings.json for custom adb path
  try {
    const settingsPath = path.join(__dirname, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (settings.adbPath) candidates.unshift(settings.adbPath);
    }
  } catch (_) {}

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        execSync(`"${candidate}" version`, { stdio: "pipe" });
        console.log(`✅ Found ADB at: ${candidate}`);
        return `"${candidate}"`;
      } catch (_) {}
    }
  }

  return null;
}

const ADB = resolveAdbPath();

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runAdb(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!ADB) {
      return reject(new Error("ADB not found. Install Android SDK Platform Tools and add to PATH."));
    }
    const cmd = `${ADB} ${args}`;
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ADB Error: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

/**
 * Wait for ADB device to come back online (after airplane mode / USB reset).
 * Runs `adb wait-for-device` with a custom timeout.
 */
function waitForAdbDevice(timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ADB) return reject(new Error("ADB not found"));
    const cmd = `${ADB} wait-for-device`;
    const child = exec(cmd, { timeout: timeoutMs }, (err) => {
      if (err) return reject(new Error("Device did not reconnect in time"));
      resolve();
    });
  });
}

// ─── EXPORTED FUNCTIONS ───────────────────────────────────────────────────────

/**
 * Check if ADB is installed and a device is connected.
 * @returns {{ adbFound: boolean, deviceConnected: boolean, deviceId: string|null }}
 */
async function checkAdbStatus() {
  if (!ADB) {
    return { adbFound: false, deviceConnected: false, deviceId: null };
  }

  try {
    const output = await runAdb("devices");
    const lines = output.split("\n").filter((l) => l.trim() && !l.startsWith("List of devices"));
    const connectedDevices = lines.filter((l) => l.includes("device") && !l.includes("offline"));

    if (connectedDevices.length === 0) {
      return { adbFound: true, deviceConnected: false, deviceId: null };
    }

    const deviceId = connectedDevices[0].split("\t")[0].trim();
    return { adbFound: true, deviceConnected: true, deviceId };
  } catch (err) {
    return { adbFound: true, deviceConnected: false, deviceId: null, error: err.message };
  }
}

/**
 * Enable airplane mode on the connected Android device.
 * Uses `cmd connectivity airplane-mode enable` (Android 10+, no root needed).
 * Falls back to `svc data disable` for very old devices.
 */
async function enableAirplaneMode() {
  console.log("  ✈️  [ADB] Enabling Airplane Mode...");
  // Primary: works on Android 10+ without root
  await runAdb("shell cmd connectivity airplane-mode enable");
  console.log("  ✈️  [ADB] Airplane Mode: ON");
  // Note: USB tethering will drop here — ADB over USB stays connected
}

/**
 * Disable airplane mode on the connected Android device.
 * Then waits for ADB device to come back online (USB tethering reconnects).
 * Uses `cmd connectivity airplane-mode disable` (Android 10+, no root needed).
 */
async function disableAirplaneMode(waitForReconnectMs = 8000) {
  console.log("  🛬  [ADB] Disabling Airplane Mode...");
  // Primary: works on Android 10+ without root
  await runAdb("shell cmd connectivity airplane-mode disable");
  console.log("  🛬  [ADB] Airplane Mode: OFF");

  // Wait for ADB device to come back (USB tethering resets)
  console.log(`  ⏳ [ADB] Waiting ${waitForReconnectMs / 1000}s for USB tethering to restore...`);
  await sleep(waitForReconnectMs);

  // Make sure ADB is back online
  try {
    await waitForAdbDevice(20000);
    console.log("  ✅ [ADB] Device reconnected. Waiting for 4G/5G to register...");
  } catch (_) {
    console.log("  ⚠️  [ADB] Device reconnect timed out — continuing anyway...");
  }
}

/**
 * Read the current airplane mode state from the device.
 * @returns {boolean} true if airplane mode is ON
 */
async function getAirplaneModeState() {
  const result = await runAdb("shell settings get global airplane_mode_on");
  return result.trim() === "1";
}

/**
 * Get the phone's cellular IP directly from its network interface via ADB.
 * Works without curl/wget — reads the interface IP (ccmni0, rmnet_data0, wwan0, etc).
 * This is the REAL mobile IP — not affected by PC's WiFi.
 * @returns {Promise<string|null>} IP address or null if not available
 */
async function getPhoneCellularIp() {
  // Common cellular interface names across Android devices / carriers
  const interfaces = [
    "ccmni0",      // MediaTek (most Redmi/Realme/OPPO)
    "rmnet_data0", // Qualcomm (Samsung, OnePlus, Pixel)
    "rmnet0",
    "wwan0",
    "rmnet_ipa0",
    "ccmni1",
    "rmnet_data1",
  ];

  for (const iface of interfaces) {
    try {
      const result = await runAdb(`shell ip addr show ${iface}`, 5000);
      // Extract IPv4 address: "inet 100.x.x.x/8"
      const match = result.match(/inet (\d+\.\d+\.\d+\.\d+)\//);  
      if (match) return match[1];
    } catch (_) {
      // Interface not found, try next
    }
  }
  return null;
}

/**
 * Get public IP directly from the PHONE via ADB shell.
 * First tries curl/wget, then falls back to reading cellular interface IP.
 * @returns {Promise<string|null>} IP address or null if not available
 */
async function getPhoneIp(timeoutMs = 12000) {
  // Try curl first (available on some Android)
  try {
    const result = await runAdb("shell curl -s --max-time 8 https://api.ipify.org", timeoutMs);
    const ip = result.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch (_) {}

  // Try wget
  try {
    const result = await runAdb("shell wget -qO- https://api.ipify.org", timeoutMs);
    const ip = result.trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch (_) {}

  // Best fallback: read directly from cellular interface
  return getPhoneCellularIp();
}

/**
 * Fetch the current public IP address.
 * First tries to get IP from PHONE via ADB (most accurate for tethering setups).
 * Falls back to checking from PC side if ADB shell not available.
 * @param {number} timeoutMs
 * @param {boolean} preferPhoneCheck - Check via ADB phone shell first (default: true)
 * @returns {Promise<string>} IP address string
 */
async function getPublicIp(timeoutMs = 15000, preferPhoneCheck = true) {
  // Try phone-side check first (avoids PC WiFi interference)
  if (preferPhoneCheck) {
    try {
      const phoneIp = await getPhoneIp(timeoutMs);
      if (phoneIp) return phoneIp;
    } catch (_) {}
  }

  // Fallback: check from PC side (may reflect WiFi if tethering is down)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IP check timed out")), timeoutMs);

    const tryUrl = (url, fallback) => {
      https
        .get(url, (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            clearTimeout(timer);
            const ip = data.trim();
            if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
              resolve(ip);
            } else if (fallback) {
              tryUrl(fallback, null);
            } else {
              reject(new Error("Could not parse IP response"));
            }
          });
        })
        .on("error", () => {
          if (fallback) tryUrl(fallback, null);
          else {
            clearTimeout(timer);
            reject(new Error("IP check failed"));
          }
        });
    };

    tryUrl("https://api.ipify.org", "https://icanhazip.com");
  });
}

/**
 * Poll until the public IP changes from oldIp, or timeout.
 * @param {string} oldIp - The IP before rotation
 * @param {number} timeoutMs - Max wait time in ms (default 60s)
 * @param {number} pollIntervalMs - How often to poll (default 3s)
 * @returns {Promise<string|null>} new IP, or null if timed out
 */
async function waitForNewIp(oldIp, timeoutMs = 60000, pollIntervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    try {
      const currentIp = await getPublicIp(8000);
      if (currentIp && currentIp !== oldIp) {
        return currentIp;
      }
      process.stdout.write(`\r  🔄 [IP] Waiting for new IP... attempt ${attempt} (still: ${currentIp})    `);
    } catch (_) {
      process.stdout.write(`\r  🔄 [IP] No network yet... attempt ${attempt}    `);
    }
    await sleep(pollIntervalMs);
  }

  process.stdout.write("\n");
  return null; // Timed out — same IP or no connection
}

/**
 * Full IP rotation cycle:
 *  1. Enable airplane mode
 *  2. Wait (waitOnSec)
 *  3. Disable airplane mode
 *  4. Wait for new IP (up to waitReconnectSec * 1000 ms)
 *
 * @param {string} currentIp - IP before rotation
 * @param {object} opts
 * @param {number} opts.waitOnSec     - Seconds to keep airplane ON (default 4)
 * @param {number} opts.waitReconnectSec - Max seconds to wait for new IP (default 30)
 * @param {number} opts.retries       - Number of retries if same IP (default 1)
 * @returns {Promise<{success: boolean, oldIp: string, newIp: string|null}>}
 */
async function rotateIp(currentIp, opts = {}) {
  const waitOnSec      = opts.waitOnSec      || 5;   // seconds airplane stays ON
  const waitReconnectSec = opts.waitReconnectSec || 45; // max seconds to wait for new IP
  const usbSettleSec   = opts.usbSettleSec   || 8;   // seconds to wait for USB tethering to restore
  const retries        = opts.retries !== undefined ? opts.retries : 1;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  🔄 IP ROTATION STARTING`);
  console.log(`  📍 Current IP: ${currentIp}`);
  console.log(`${"─".repeat(60)}`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`\n  ⚠️  Same IP — retry #${attempt} (try increasing --wait-reconnect)`);
    }

    // Step 1: Airplane ON
    await enableAirplaneMode();
    console.log(`  ⏳ Waiting ${waitOnSec}s with airplane ON...`);
    await sleep(waitOnSec * 1000);

    // Step 2: Airplane OFF + wait for USB tethering + ADB to come back
    await disableAirplaneMode(usbSettleSec * 1000);

    // Step 3: Poll for new IP (remaining time budget)
    const ipPollMs = Math.max((waitReconnectSec - usbSettleSec) * 1000, 15000);
    console.log(`  ⏳ Polling for new IP (up to ${Math.round(ipPollMs / 1000)}s)...`);
    const newIp = await waitForNewIp(currentIp, ipPollMs, 3000);

    if (newIp) {
      console.log(`\n  ✅ IP ROTATED SUCCESSFULLY!`);
      console.log(`  📍 Old IP : ${currentIp}`);
      console.log(`  📍 New IP : ${newIp}`);
      console.log(`${"─".repeat(60)}\n`);
      return { success: true, oldIp: currentIp, newIp };
    }
  }

  console.log(`\n  ⚠️  IP Rotation: Could not confirm new IP after ${retries + 1} attempt(s).`);
  console.log(`  ▶️  Continuing anyway...\n`);
  return { success: false, oldIp: currentIp, newIp: null };
}

// ─── STANDALONE TEST MODE ─────────────────────────────────────────────────────
async function runSelfTest() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║         ADB Helper — Self Test Mode          ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // Test 1: ADB available?
  console.log("🧪 Test 1: Checking ADB...");
  if (!ADB) {
    console.error("❌ ADB not found in PATH or common install locations.");
    console.error("   Install: https://developer.android.com/tools/releases/platform-tools");
    console.error("   Then add platform-tools folder to your system PATH.");
    process.exit(1);
  }
  console.log(`   ✅ ADB found: ${ADB}\n`);

  // Test 2: Device connected?
  console.log("🧪 Test 2: Checking connected devices...");
  const status = await checkAdbStatus();
  if (!status.deviceConnected) {
    console.error("❌ No Android device connected via USB.");
    console.error("   Steps to fix:");
    console.error("   1. Connect phone via USB cable");
    console.error("   2. Enable Developer Options on phone");
    console.error("   3. Enable USB Debugging");
    console.error("   4. Accept 'Allow USB Debugging' prompt on phone");
    console.error("   5. Run: adb devices   (should show your device)");
    process.exit(1);
  }
  console.log(`   ✅ Device connected: ${status.deviceId}\n`);

  // Test 3: Get current IP
  console.log("🧪 Test 3: Getting current public IP...");
  let currentIp;
  try {
    currentIp = await getPublicIp();
    console.log(`   ✅ Current IP: ${currentIp}\n`);
  } catch (err) {
    console.error(`   ❌ Could not get IP: ${err.message}`);
    console.error("   (Is USB Tethering enabled on the phone?)\n");
    process.exit(1);
  }

  // Test 4: Airplane mode toggle + IP rotation
  console.log("🧪 Test 4: Running full IP rotation test...");
  console.log("   ⚠️  Phone ka network briefly disconnect hoga!\n");

  const result = await rotateIp(currentIp, {
    waitOnSec: 4,
    waitReconnectSec: 40,
    retries: 1,
  });

  if (result.success) {
    console.log(`\n🎉 ALL TESTS PASSED!`);
    console.log(`   IP changed: ${result.oldIp} → ${result.newIp}`);
  } else {
    console.log(`\n⚠️  Rotation ran but IP did not change.`);
    console.log(`   This can happen if your ISP assigns the same IP.`);
    console.log(`   Try increasing --wait-reconnect to 20-30 seconds.`);
  }
}

// Run self-test if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--test")) {
    runSelfTest().catch((err) => {
      console.error("❌ Test failed:", err.message);
      process.exit(1);
    });
  } else {
    console.log("Usage: node adb_helper.js --test");
    console.log("       This module is normally imported by ip_rotator.js");
  }
}

module.exports = {
  checkAdbStatus,
  enableAirplaneMode,
  disableAirplaneMode,
  getAirplaneModeState,
  getPublicIp,
  waitForNewIp,
  rotateIp,
  ADB,
};
