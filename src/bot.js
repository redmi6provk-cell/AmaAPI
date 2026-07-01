const TelegramBot = require('node-telegram-bot-api');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');

function parseAddressString(str) {
  if (str.split(',').length >= 6) {
    return str.split(',').map(s => s.trim());
  }
  const regex = /"([^"]+)"|(\S+)/g;
  const fields = [];
  let match;
  while ((match = regex.exec(str)) !== null) {
    fields.push(match[1] || match[2]);
  }
  return fields;
}

function extractAsin(input) {
  if (!input) return null;
  const match = input.match(/\/dp\/([A-Z0-9]{10})/i) ||
    input.match(/\/gp\/product\/([A-Z0-9]{10})/i) ||
    input.match(/\/gp\/aw\/d\/([A-Z0-9]{10})/i) ||
    input.match(/\/asin\/([A-Z0-9]{10})/i) ||
    input.match(/\/d\/([A-Z0-9]{10})/i) ||
    input.match(/^([A-Z0-9]{10})$/i);
  if (match) return match[1].toUpperCase();

  const fallback = input.match(/\b(B[A-Z0-9]{9})\b/i);
  return fallback ? fallback[1].toUpperCase() : null;
}


// Parse user-id argument (defaults to 1)
const processArgs = process.argv.slice(2);
const userArgIndex = processArgs.indexOf("--user-id");
let botUserId = 1;
if (userArgIndex !== -1 && userArgIndex + 1 < processArgs.length) {
  botUserId = parseInt(processArgs[userArgIndex + 1], 10);
}

// Replace with your bot token
// const token = '8940148847:AAErIaZ-zDna43RAfVt2uatyJaqmsx-sNZY';
// const token = '8592538979:AAHI4yN9LR8PA4OHopgDXZTOLIYFowm1rU4';
const token = '8567521844:AAHKsMVPqqq4X-VCGNN3STDhiJqO642ggyg';
const bot = new TelegramBot(token, { polling: true });

function killProcessTree(childProcess) {
  if (!childProcess || !childProcess.pid) return;
  console.log(`[Abort] Killing process tree for PID ${childProcess.pid}...`);
  if (process.platform === 'win32') {
    exec(`taskkill /pid ${childProcess.pid} /f /t`, (err) => {
      if (err) {
        console.error(`[Abort] Error running taskkill for PID ${childProcess.pid}:`, err.message);
      } else {
        console.log(`[Abort] Process tree for PID ${childProcess.pid} killed successfully.`);
      }
    });
  } else {
    try {
      process.kill(-childProcess.pid, 'SIGKILL');
    } catch (e) {
      try {
        childProcess.kill('SIGKILL');
      } catch (err) { }
    }
  }
}

function handleStopAutomation(chatId) {
  const state = userState[chatId];
  if (!state || !state.activeExecution) {
    bot.sendMessage(chatId, "⚠️ Koi active automation nahi chal rahi hai jise stop kiya ja sake.", removeKeyboard);
    return;
  }

  bot.sendMessage(chatId, "🛑 Automation ko stop ", removeKeyboard);

  const execState = state.activeExecution;
  execState.aborted = true;

  // Clear any queue
  if (execState.queue) {
    execState.queue.length = 0;
  }

  // Clear any active timeout delay
  if (execState.activeTimeout) {
    clearTimeout(execState.activeTimeout);
  }

  // Kill all active processes
  if (execState.activeProcesses && execState.activeProcesses.length > 0) {
    execState.activeProcesses.forEach(child => {
      killProcessTree(child);
    });
    execState.activeProcesses = [];
  }

  state.activeExecution = null;
  bot.sendMessage(chatId, "🛑 Automation successfully stop ho gayi hai.", removeKeyboard);
}

const stopKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "🛑 STOP STOP KARO" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

function simplifyLogOutput(scriptName, rawOutput) {
  if (!rawOutput) return "Command finished with no output.";

  // Clean ANSI color codes
  const cleanText = rawOutput.replace(/\x1b\[[0-9;]*m/g, '').trim();

  if (scriptName !== "ip_rotator.js") {
    return cleanText.length > 3000 ? cleanText.substring(cleanText.length - 3000) : cleanText;
  }

  const lines = cleanText.split("\n");
  const importantLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Ignore all debug/orchestration/header/footer boilerplate lines
    if (trimmed.includes("DeprecationWarning") ||
      trimmed.includes("node --trace-deprecation") ||
      trimmed.includes("Running batch of") ||
      trimmed.includes("ADB IP Rotator") ||
      trimmed.includes("Loop mode") ||
      trimmed.includes("Max rotations") ||
      trimmed.includes("Runtime") ||
      trimmed.includes("IP Rotations :") ||
      trimmed.includes("IP History") ||
      trimmed.includes("IP Rotator finished") ||
      trimmed.includes("Checking ADB connection") ||
      trimmed.includes("Getting current public IP") ||
      trimmed.includes("Processing") ||
      trimmed.includes("Batch complete") ||
      trimmed.includes("SESSION STATS") ||
      trimmed.includes("Starting:") ||
      trimmed.startsWith("══") ||
      trimmed.startsWith("║") ||
      trimmed.startsWith("╔") ||
      trimmed.startsWith("╚") ||
      trimmed.startsWith("📈") ||
      trimmed.startsWith("⏱️") ||
      trimmed.startsWith("📦") ||
      trimmed.startsWith("🔄") ||
      trimmed.startsWith("🌐") ||
      trimmed.startsWith("🏁")) {
      continue;
    }

    // Keep lines that represent actual success/fail status or reason
    if (trimmed.includes("✅ Phone connected") ||
      trimmed.includes("✅ Current IP") ||
      trimmed.includes("✅ [Pipeline]") ||
      trimmed.includes("❌ [Pipeline]") ||
      trimmed.includes("🔍 Reason:") ||
      trimmed.includes("Moved") ||
      trimmed.includes("Done:") ||
      trimmed.includes("Failed:")) {
      importantLines.push(trimmed);
    }
  }

  if (importantLines.length > 0) {
    return importantLines.join("\n");
  }

  const successCount = (cleanText.match(/Done:/g) || []).length;
  const failCount = (cleanText.match(/Failed:/g) || []).length;
  return `🏁 Automation complete.\n✅ Success: ${successCount} | ❌ Failed: ${failCount}`;
}


// Gracefully handle polling errors
bot.on('polling_error', (error) => {
  const msg = error.message || String(error);
  if (msg.includes('403') || msg.includes('blocked')) {
    return; // Suppress noise when user blocks the bot
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('EPIPE')) {
    console.warn(`⚠️ Telegram Polling Warning: Network connection issue (${msg.split('\n')[0]}).`);
    return;
  }
  console.error(`[Telegram Polling Error] ${msg}`);
});

// Handle unhandled promise rejections globally (e.g. when bot is blocked by a user, DB issues, or network issues)
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  if (msg.includes('403 Forbidden') || msg.includes('blocked by the user')) {
    console.warn('⚠️ Telegram Bot Warning: Message could not be sent because the bot was blocked by the user.');
  } else if (msg.includes('5432') || (msg.toLowerCase().includes('connect') && (msg.includes('187.77.187.82') || msg.toLowerCase().includes('postgres') || msg.toLowerCase().includes('db') || msg.toLowerCase().includes('pool')))) {
    console.warn(`⚠️ Database Warning: Connection failed to database server (${msg.split('\n')[0]}). Please check if the database is online and your current IP is whitelisted.`);
  } else if (msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('EPIPE')) {
    console.warn(`⚠️ Telegram Bot Warning: Network connection issues with Telegram API (${msg.split('\n')[0]}).`);
  } else {
    console.error('⚠️ Unhandled Promise Rejection:', reason);
  }
});


// Active user ID per Telegram chat (defaults to botUserId)
const chatActiveUser = {};

function getUserIdForChat(chatId) {
  return chatActiveUser[chatId] || botUserId;
}

// Optional: Store state for users if they are in the middle of a command
const userState = {};

// No reply keyboard - all commands via Menu icon
const removeKeyboard = {
  reply_markup: { remove_keyboard: true }
};

const startKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "📋 Menu" }, { text: "⚡ Automation" }],
      [{ text: "⚙️ Setting" }, { text: "🔧 Config" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  }
};

bot.setMyCommands([
  { command: '/start', description: '👋 Start the bot & show main menu' },
  { command: '/switch_user', description: '👥 Switch active user context' },
  { command: '/stop', description: '🛑 Stop active automation' },
  { command: '/login', description: '🔑 Login to Amazon' },
  { command: '/active_list', description: '✉️ View accounts (active)' },
  { command: '/no_cod_list', description: '🛑 View no_cod_accounts' },
  { command: '/past_order_list', description: '⚠️ View past_order' },
  { command: '/delivery_issue_list', description: '📍 View delivery_issue' },
  { command: '/purchase_limit_list', description: '📦 View purchase_limit' },
  { command: '/add_account', description: '✉️ Add Amazon account' },
  { command: '/set_affiliate', description: '🏷️ Set default affiliate tag' },
  { command: '/move_account', description: '🔄 Move account between tables' }
]);

// Initialize DB

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = { step: null };
  const currentUserId = getUserIdForChat(chatId);
  const user = await db.getUser(currentUserId);
  const userText = user ? `${user.email} (ID: ${currentUserId})` : `ID ${currentUserId}`;

  bot.sendMessage(chatId,
    `👋 Welcome to the Amazon Bot!\n\nYour current user context is: *${userText}*\n\nWhat would you like to do? Select from the buttons below:`, { parse_mode: 'Markdown', ...startKeyboard }
  );
});

async function promptAccountSelection(chatId, actionMessage, actionCallbackData, tableName = null) {
  const currentUserId = getUserIdForChat(chatId);

  if (!tableName) {
    if (!userState[chatId]) userState[chatId] = { step: null };
    // Save to userState to prevent exceeding Telegram's 64-byte limit on callback_data
    userState[chatId].tempActionMessage = actionMessage;
    userState[chatId].tempActionCallback = actionCallbackData;

    const keyboard = [
      [{ text: "accounts", callback_data: `sel_table|accounts` }],
      [{ text: "success_accounts", callback_data: `sel_table|success_accounts` }],
      [{ text: "no_cod_accounts", callback_data: `sel_table|no_cod_accounts` }],
      [{ text: "past_order", callback_data: `sel_table|past_order` }],
      [{ text: "delivery_issue", callback_data: `sel_table|delivery_issue` }],
      [{ text: "purchase_limit", callback_data: `sel_table|purchase_limit` }]
    ];
    bot.sendMessage(chatId, "📋 Select which database table to use:", {
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  const accounts = await db.getAccountsFromTable(currentUserId, tableName);
  const emails = accounts.map(a => a.email);

  if (emails.length === 0) {
    bot.sendMessage(chatId, `⚠️ No accounts found in table '${tableName}'.`, removeKeyboard);
    return;
  }

  let messageText = `${actionMessage} (Using table: *${tableName}*)\n\nYou have ${emails.length} accounts.\n`;
  if (emails.length <= 15) {
    emails.forEach((email, i) => {
      messageText += `[${i + 1}] ${email}\n`;
    });
  } else {
    messageText += `(Too many to list here.)\n`;
  }
  messageText += "\nReply with:\n• A single number (e.g. 1)\n• A range (e.g. 1-5)\n• 'all' for all accounts";

  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].pendingAction = actionCallbackData;
  userState[chatId].selectedTableForAction = tableName; // Store selected table
  bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
}

function getCartAsins(chatId) {
  let items = [];
  const fileName = `cart_response_${chatId}.json`;
  try {
    if (fs.existsSync(fileName)) {
      items = JSON.parse(fs.readFileSync(fileName, "utf8"));
    }
  } catch (e) { }

  if (!Array.isArray(items)) return [];
  const asins = new Set();
  items.forEach(item => {
    if (item && item.asin) asins.add(item.asin);
  });
  return Array.from(asins);
}

function promptCartDelete(chatId) {
  const asins = getCartAsins(chatId);
  if (asins.length === 0) {
    if (!userState[chatId]) userState[chatId] = { step: null };
    userState[chatId].step = 'cart_delete_manual';
    bot.sendMessage(chatId, "No ASINs found in your recent cart data. Please type the ASIN manually, or 'all':");
    return;
  }

  const keyboard = [];
  asins.forEach(asin => {
    keyboard.push([{ text: `🗑️ Delete ${asin}`, callback_data: `delete_asin_${asin}` }]);
  });
  keyboard.push([{ text: `💥 Delete ALL ASINs`, callback_data: `delete_asin_all` }]);

  bot.sendMessage(chatId, "Select ASIN to delete from cart:", {
    reply_markup: { inline_keyboard: keyboard }
  });
}

function runModularScript(chatId, cmdArgs, accountRange, tableName = 'accounts') {
  const state = userState[chatId] || { step: null };
  let startUrlArg = "";
  if (state.startUrl) {
    startUrlArg = ` --start-url "${state.startUrl}"`;
    state.startUrl = null;
  }

  // Parse cmdArgs to see what command it is
  const parts = cmdArgs.trim().split(/\s+/);
  const verb1 = parts[0];
  const verb2 = parts[1];

  let scriptName = "";
  let args = [];

  // Determine which script and arguments to run
  if (verb1 === "cart" && verb2 === "list") {
    scriptName = "get_cart.js";
  } else if (verb1 === "cart" && verb2 === "add") {
    scriptName = "add_to_cart.js";
    args = parts.slice(2); // ASIN and Qty
  } else if (verb1 === "cart" && verb2 === "delete") {
    scriptName = "delete_item.js";
    args = parts.slice(2); // ASIN or "all"
  } else if (verb1 === "address" && verb2 === "list") {
    scriptName = "list_addresses.js";
  } else if (verb1 === "address" && verb2 === "add") {
    scriptName = "add_address.js";
    args = parts.slice(2); // Name, Phone, etc. (positionals)
  } else if (verb1 === "address" && verb2 === "delete") {
    scriptName = "delete_address.js";
    args = parts.slice(2); // ID or "all"
  } else if (verb1 === "checkout") {
    scriptName = "pay_on_delivery.js";
    if (cmdArgs.includes("--confirm-place-order")) {
      args.push("--confirm-place-order");
    }
  } else if (verb1 === "checkout-browser") {
    scriptName = "pay_on_delivery.js";
    if (cmdArgs.includes("--confirm-place-order")) {
      args.push("--confirm-place-order");
    }
    args.push("--browser");
  } else if (verb1 === "full-checkout") {
    scriptName = "ip_rotator.js";
    if (cmdArgs.includes("--confirm-place-order")) {
      args.push("--confirm-place-order");
    }
    // Set rotator settings to cycle after 3 accounts and run sequentially (concurrency 1)
    args.push("--rotate-every", "3");
    args.push("--concurrency", "1");
    // Pass the source table name so rotator knows where to move successful accounts from
    args.push("--table", tableName);
  } else if (verb1 === "login") {
    scriptName = "get_cookies.js";
  } else {
    bot.sendMessage(chatId, `❌ Unknown command: ${cmdArgs}`);
    return;
  }

  // Handle min/max price
  const minPriceMatch = cmdArgs.match(/--min-price\s+(\d+)/);
  if (minPriceMatch) {
    args.push("--min-price", minPriceMatch[1]);
  }
  const maxPriceMatch = cmdArgs.match(/--max-price\s+(\d+)/);
  if (maxPriceMatch) {
    args.push("--max-price", maxPriceMatch[1]);
  }

  // Handle start URL
  if (startUrlArg) {
    const urlMatch = startUrlArg.match(/"([^"]+)"/);
    if (urlMatch) {
      args.push("--start-url", urlMatch[1]);
    }
  }

  // Add user-id
  const currentUserId = getUserIdForChat(chatId);
  args.push("--user-id", String(currentUserId));

  // Resolve accounts
  let selectedEmails = [];
  db.getAccountsFromTable(currentUserId, tableName).then(async (accountsList) => {
    const emailsList = accountsList.map(a => a.email);

    if (accountRange) {
      if (accountRange.toLowerCase() === "all") {
        selectedEmails = emailsList;
      } else {
        const rangeMatch = accountRange.match(/^(\d+)-(\d+)$/);
        const singleMatch = accountRange.match(/^(\d+)$/);

        if (rangeMatch) {
          const start = parseInt(rangeMatch[1], 10) - 1;
          const end = parseInt(rangeMatch[2], 10) - 1;
          if (start >= 0 && end < emailsList.length && start <= end) {
            selectedEmails = emailsList.slice(start, end + 1);
          } else {
            bot.sendMessage(chatId, `❌ Invalid range: ${accountRange}`);
            return;
          }
        } else if (singleMatch) {
          const idx = parseInt(singleMatch[1], 10) - 1;
          if (idx >= 0 && idx < emailsList.length) {
            selectedEmails = [emailsList[idx]];
          } else {
            bot.sendMessage(chatId, `❌ Invalid account index: ${accountRange}`);
            return;
          }
        } else {
          selectedEmails = [accountRange];
        }
      }
    } else {
      selectedEmails = [null];
    }

    if (selectedEmails.length === 0) {
      bot.sendMessage(chatId, `❌ No accounts resolved for range: ${accountRange}`);
      return;
    }

    // Intercept emails for ip_rotator.js so it runs as a single process orchestrator
    if (scriptName === "ip_rotator.js") {
      const validEmails = selectedEmails.filter(Boolean);
      if (validEmails.length > 0) {
        args.push("--emails", validEmails.join(","));
      }
      selectedEmails = [null]; // Collapse list so bot.js executes ip_rotator.js once
    }

    // Initialize activeExecution state for this chat session
    if (!userState[chatId]) userState[chatId] = { step: null };
    userState[chatId].activeExecution = {
      aborted: false,
      queue: null,
      activeProcesses: [],
      activeTimeout: null
    };

    // Send the persistent stop keyboard to the user
    bot.sendMessage(chatId, "🚦 Automation started.", {
      parse_mode: 'Markdown',
      ...stopKeyboard
    });

    if (selectedEmails.length > 1) {
      // Initialize states
      const states = {};
      selectedEmails.forEach(email => {
        states[email] = {
          status: "pending",
          step: "Queued..."
        };
      });

      // Send initial dashboard message
      let dashboardMessage = null;
      function formatDashboard() {
        let text = `🤖 *Parallel Execution Status* (Table: *${tableName}*):\n\n`;
        selectedEmails.forEach((email, idx) => {
          const s = states[email];
          let icon = "⏳";
          if (s.status === "running") icon = "🔄";
          else if (s.status === "success") icon = "✅";
          else if (s.status === "failed") icon = "❌";
          text += `${icon} [${idx + 1}/${selectedEmails.length}] *${email}*: ${s.step}\n`;
        });
        return text;
      }

      bot.sendMessage(chatId, formatDashboard(), { parse_mode: "Markdown" }).then(msg => {
        dashboardMessage = msg;
      });

      // Throttled UI updater
      let lastUpdate = 0;
      let updateTimeout = null;
      function requestUiUpdate(force = false) {
        const now = Date.now();
        if (force || now - lastUpdate >= 2500) {
          if (updateTimeout) clearTimeout(updateTimeout);
          lastUpdate = now;
          if (dashboardMessage) {
            bot.editMessageText(formatDashboard(), {
              chat_id: chatId,
              message_id: dashboardMessage.message_id,
              parse_mode: "Markdown"
            }).catch(() => { });
          }
        } else if (!updateTimeout) {
          updateTimeout = setTimeout(() => {
            updateTimeout = null;
            requestUiUpdate(true);
          }, 2500 - (now - lastUpdate));
        }
      }

      const maxConcurrency = 5;
      const queue = [...selectedEmails];
      const activePromises = [];

      // Link queue to activeExecution so it can be cleared on abort
      if (userState[chatId] && userState[chatId].activeExecution) {
        userState[chatId].activeExecution.queue = queue;
      }

      async function runWorker(email) {
        if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) {
          return;
        }

        states[email].status = "running";
        states[email].step = "Starting...";
        requestUiUpdate();

        const finalArgs = [...args];
        if (email) {
          finalArgs.push("--email", email);
        }
        // Force headless for parallel execution to avoid memory crashes
        if (!finalArgs.includes("--headless")) {
          finalArgs.push("--headless");
        }

        const commandStr = `node ${scriptName} ${finalArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;
        console.log(`\n🚀 Starting parallel command from Telegram: ${commandStr}`);

        let failureReason = null;

        const child = spawn("node", [path.join(__dirname, scriptName), ...finalArgs], { shell: false });

        // Track child process
        if (userState[chatId] && userState[chatId].activeExecution) {
          userState[chatId].activeExecution.activeProcesses.push(child);
        }

        child.stdout.on("data", (data) => {
          if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) return;
          const text = data.toString();
          // Print output to terminal prefixed with email for debugging
          text.split("\n").forEach(line => {
            if (line.trim()) {
              console.log(`[${email}] ${line}`);
            }
          });

          // Check for specific error signatures
          if (text.includes("Your password is incorrect") || text.includes("password is incorrect") || text.includes("AMAZON_AUTH_ERROR")) {
            failureReason = "Wrong Password";
          } else if (text.includes("PASSWORD_RESET_REQUIRED") || text.includes("Password reset required")) {
            failureReason = "Reset Required";
          } else if (text.includes("COD_DISABLED") || text.includes("Cash on Delivery is disabled") || text.includes("Cash on Delivery (COD) is disabled")) {
            failureReason = "COD Disabled";
          } else if (text.includes("PRICE_CHECK_FAILED") || text.includes("Price limit check failed")) {
            failureReason = "Price Check Failed";
          } else if (text.includes("OTP_FAILED") || text.includes("OTP verification failed")) {
            failureReason = "OTP Failed";
          } else if (text.includes("CAPTCHA") || text.includes("Captcha")) {
            failureReason = "Captcha Blocked";
          } else if (text.includes("SESSION_EXPIRED")) {
            failureReason = "Session Expired";
          }

          if (text.includes("CLEANING SAVED ADDRESSES")) {
            states[email].step = "🧹 Cleaning addresses";
          } else if (text.includes("ADDING NEW SHIPPING ADDRESS")) {
            states[email].step = "📍 Adding address";
          } else if (text.includes("CLEANING CURRENT CART")) {
            states[email].step = "🗑️ Clearing cart";
          } else if (text.includes("ADDING PRODUCT(S) TO CART")) {
            states[email].step = "🛒 Adding products";
          } else if (text.includes("FETCHING CURRENT CART ITEMS")) {
            states[email].step = "📦 Fetching cart";
          } else if (text.includes("PERFORMING CASH ON DELIVERY CHECKOUT")) {
            states[email].step = "💳 Checking out (COD)";
          } else if (text.includes("Success! Address successfully added programmatically")) {
            states[email].step = "📍 Address added";
          } else if (text.includes("Success! ASIN") && text.includes("added to cart")) {
            states[email].step = "🛒 Product added";
          }
          requestUiUpdate();
        });

        child.stderr.on("data", (data) => {
          if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) return;
          const text = data.toString();
          text.split("\n").forEach(line => {
            if (line.trim()) {
              console.error(`[${email}] ⚠️ ERROR: ${line}`);
            }
          });

          // Check for specific error signatures in stderr
          if (text.includes("Your password is incorrect") || text.includes("password is incorrect") || text.includes("AMAZON_AUTH_ERROR")) {
            failureReason = "Wrong Password";
          } else if (text.includes("PASSWORD_RESET_REQUIRED") || text.includes("Password reset required")) {
            failureReason = "Reset Required";
          } else if (text.includes("COD_DISABLED") || text.includes("Cash on Delivery is disabled") || text.includes("Cash on Delivery (COD) is disabled")) {
            failureReason = "COD Disabled";
          } else if (text.includes("PRICE_CHECK_FAILED") || text.includes("Price limit check failed")) {
            failureReason = "Price Check Failed";
          } else if (text.includes("OTP_FAILED") || text.includes("OTP verification failed")) {
            failureReason = "OTP Failed";
          } else if (text.includes("CAPTCHA") || text.includes("Captcha")) {
            failureReason = "Captcha Blocked";
          } else if (text.includes("SESSION_EXPIRED")) {
            failureReason = "Session Expired";
          }
        });

        return new Promise((resolve) => {
          child.on("close", async (code) => {
            // Remove from active processes list
            if (userState[chatId] && userState[chatId].activeExecution) {
              const idx = userState[chatId].activeExecution.activeProcesses.indexOf(child);
              if (idx > -1) userState[chatId].activeExecution.activeProcesses.splice(idx, 1);
            }

            if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) {
              resolve();
              return;
            }

            if (code === 0) {
              states[email].status = "success";
              states[email].step = "🎉 Success!";
              // Move successful checkout to success_accounts table
              if ((scriptName === "pay_on_delivery.js" || scriptName === "pipeline.js") && tableName !== 'success_accounts') {
                try {
                  await db.moveAccount(email, currentUserId, tableName, 'success_accounts');
                  console.log(`🎉 Moved successful account ${email} to success_accounts.`);
                } catch (err) {
                  console.error(`❌ Failed to move successful account ${email}:`, err.message);
                }
              }
            } else {
              states[email].status = "failed";
              states[email].step = failureReason ? `❌ Failed: ${failureReason}` : `❌ Failed (Code: ${code})`;
            }
            requestUiUpdate();
            resolve();
          });
        });
      }

      (async () => {
        while ((queue.length > 0 || activePromises.length > 0) && !(userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted)) {
          while (activePromises.length < maxConcurrency && queue.length > 0 && !(userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted)) {
            const nextEmail = queue.shift();
            const promise = runWorker(nextEmail).then(() => {
              const idx = activePromises.indexOf(promise);
              if (idx > -1) activePromises.splice(idx, 1);
            });
            activePromises.push(promise);
          }
          if (activePromises.length > 0) {
            await Promise.race(activePromises);
          }
        }
        // Final forced update to ensure final states are displayed
        setTimeout(() => requestUiUpdate(true), 1000);

        if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) {
          // If aborted, handleStopAutomation has already sent the notification
          return;
        }

        bot.sendMessage(chatId, `🏁 Parallel execution finished for ${selectedEmails.length} account(s)!`, removeKeyboard);
        if (userState[chatId]) userState[chatId].activeExecution = null;
      })();

    } else {
      bot.sendMessage(chatId, `🤖 Processing: ${scriptName} for ${selectedEmails.length} account(s)...`);

      // Sequential execution function
      async function runSequentially(index) {
        if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) {
          return;
        }

        if (index >= selectedEmails.length) {
          bot.sendMessage(chatId, "What would you like to do next?", removeKeyboard);
          if (userState[chatId]) userState[chatId].activeExecution = null;
          return;
        }

        const email = selectedEmails[index];
        const finalArgs = [...args];
        if (email) {
          finalArgs.push("--email", email);
        }

        let friendlyAction = "Running automation script";
        if (scriptName === "ip_rotator.js") {
          friendlyAction = "Starting checkout automation";
        } else if (scriptName === "delete_address.js") {
          friendlyAction = "Cleaning saved addresses";
        } else if (scriptName === "add_address.js") {
          friendlyAction = "Adding new shipping address";
        } else if (scriptName === "delete_item.js") {
          friendlyAction = "Cleaning current cart";
        } else if (scriptName === "add_to_cart.js") {
          friendlyAction = "Adding product to cart";
        } else if (scriptName === "get_cart.js") {
          friendlyAction = "Fetching cart items";
        } else if (scriptName === "pay_on_delivery.js") {
          friendlyAction = "Performing Cash on Delivery checkout";
        } else if (scriptName === "get_cookies.js") {
          friendlyAction = "Refreshing login session";
        } else if (scriptName === "pipeline.js") {
          friendlyAction = "Running checkout pipeline";
        }

        const emailInfo = email ? ` for *${email}*` : "";
        bot.sendMessage(chatId, `⏳ [Account ${index + 1}/${selectedEmails.length}] ${friendlyAction}${emailInfo}... Please wait.`, { parse_mode: "Markdown" });
        const commandStr = `node ${scriptName} ${finalArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;
        console.log(`\n======================================================`);
        console.log(`🚀 Starting command from Telegram: ${commandStr}`);
        console.log(`======================================================\n`);

        const child = spawn("node", [path.join(__dirname, scriptName), ...finalArgs], { shell: false });

        if (userState[chatId] && userState[chatId].activeExecution) {
          userState[chatId].activeExecution.activeProcesses.push(child);
        }

        let fullOutput = "";

        child.stdout.on('data', (data) => {
          if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) return;
          process.stdout.write(data);
          fullOutput += data.toString();
        });

        child.stderr.on('data', (data) => {
          if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) return;
          process.stderr.write(data);
          fullOutput += data.toString();
        });

        child.on('close', async (code) => {
          // Remove child process from active list
          if (userState[chatId] && userState[chatId].activeExecution) {
            const idx = userState[chatId].activeExecution.activeProcesses.indexOf(child);
            if (idx > -1) userState[chatId].activeExecution.activeProcesses.splice(idx, 1);
          }

          if (userState[chatId] && userState[chatId].activeExecution && userState[chatId].activeExecution.aborted) {
            return;
          }

          console.log(`\n✅ Command finished with exit code ${code}.`);

          const safeEmail = email ? email.replace(/[^a-zA-Z0-9]/g, "_") : "unknown";
          const cartPath = `cart_response_${safeEmail}.json`;

          if (scriptName === "get_cart.js" && code === 0) {
            try {
              if (fs.existsSync(cartPath)) {
                fs.copyFileSync(cartPath, `cart_response_${chatId}.json`);
              }
            } catch (e) {
              console.error("Error backing up cart response:", e.message);
            }
          }

          // Clean up the temporary file in all cases
          try {
            if (fs.existsSync(cartPath)) {
              fs.unlinkSync(cartPath);
            }
          } catch (e) { }

          const cleanOutput = simplifyLogOutput(scriptName, fullOutput);
          bot.sendMessage(chatId, `[Account ${index + 1}/${selectedEmails.length}]\n${cleanOutput}`);

          // Move successful checkout to success_accounts table
          if ((scriptName === "pay_on_delivery.js" || scriptName === "pipeline.js") && code === 0 && tableName !== 'success_accounts' && email) {
            try {
              await db.moveAccount(email, currentUserId, tableName, 'success_accounts');
              bot.sendMessage(chatId, `🎉 Successfully moved active account *${email}* to *success_accounts* table.`, { parse_mode: 'Markdown' });
            } catch (err) {
              console.error(`❌ Failed to move successful account ${email}:`, err.message);
            }
          }

          // Delay before next account
          if (index < selectedEmails.length - 1) {
            bot.sendMessage(chatId, "⏳ Waiting 5 seconds before next account...");
            await new Promise(r => {
              const timeout = setTimeout(r, 5000);
              if (userState[chatId] && userState[chatId].activeExecution) {
                userState[chatId].activeExecution.activeTimeout = timeout;
              }
            });
          }

          runSequentially(index + 1);
        });
      }

      runSequentially(0);
    }
  }).catch((err) => {
    bot.sendMessage(chatId, `❌ Error reading accounts from database: ${err.message}`);
  });
}

async function sendPaginatedAccounts(chatId, page) {
  const currentUserId = getUserIdForChat(chatId);
  const emails = await db.getAccountsByUser(currentUserId);
  if (emails.length === 0) {
    bot.sendMessage(chatId, "You have no accounts configured.");
    return;
  }
  const perPage = 20;
  const totalPages = Math.ceil(emails.length / perPage);
  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const start = (page - 1) * perPage;
  const end = start + perPage;
  const sliced = emails.slice(start, end);

  let text = `📄 Your Accounts (Page ${page}/${totalPages}):\n\n`;
  sliced.forEach((e, i) => text += `[${start + i + 1}] ${e}\n`);

  const keyboard = [];
  const navRow = [];
  if (page > 1) navRow.push({ text: "⬅️ Prev", callback_data: `page_acc_${page - 1}` });
  if (page < totalPages) navRow.push({ text: "Next ➡️", callback_data: `page_acc_${page + 1}` });
  if (navRow.length > 0) keyboard.push(navRow);

  bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Write address_input.json and cart_input.json from a DB config for backward compatibility
async function writeConfigFiles(userId, configName) {
  try {
    const details = await db.getAutomationConfigDetails(userId, configName);
    if (!details) {
      console.warn(`⚠️ writeConfigFiles: Config '${configName}' not found.`);
      return false;
    }

    const addressInputPath = path.join(__dirname, '..', 'config', 'address_input.json');
    const cartInputPath = path.join(__dirname, '..', 'config', 'cart_input.json');

    const addressData = {
      fullName: details.full_name,
      phone: details.phone,
      pin: details.pin,
      line1: details.line1,
      line2: details.line2,
      city: details.city,
      state: details.state,
      landmark: details.landmark || ''
    };
    fs.writeFileSync(addressInputPath, JSON.stringify(addressData, null, 2), 'utf8');

    const products = typeof details.products === 'string' ? JSON.parse(details.products) : details.products;
    const cartData = { products: products || [] };
    fs.writeFileSync(cartInputPath, JSON.stringify(cartData, null, 2), 'utf8');

    console.log(`✅ Wrote config files for '${configName}' (${details.full_name}, ${(products || []).length} product(s))`);
    return true;
  } catch (err) {
    console.error(`❌ writeConfigFiles error for '${configName}':`, err.message);
    return false;
  }
}

async function promptConfigSelection(chatId, cmdArgs) {
  const currentUserId = getUserIdForChat(chatId);
  try {
    const configs = await db.getAutomationConfigs(currentUserId);
    if (!configs || configs.length === 0) {
      userState[chatId].selectedConfigName = null;
      promptAccountSelection(chatId, `Select account for Checkout (No Config):`, cmdArgs);
      return;
    }

    const keyboard = configs.map(c => [{ text: `🔧 ${c.name}`, callback_data: `sel_cfg_for_run|${c.name}` }]);
    keyboard.push([{ text: "❌ Skip Config (Use JSON)", callback_data: "sel_cfg_for_run|skip" }]);

    bot.sendMessage(chatId, "🔧 *Select Configuration*:\nChoose a configuration to use for this checkout run:", {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (err) {
    bot.sendMessage(chatId, `❌ Error reading configurations: ${err.message}`);
  }
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  bot.answerCallbackQuery(query.id).catch((err) => {
    console.warn(`⚠️ Telegram Warning: Failed to answer callback query: ${err.message}`);
  });

  if (!userState[chatId]) userState[chatId] = { step: null };

  // ── INLINE KEYBOARD HANDLERS ──────────────────────────────────
  if (data.startsWith('tbl_list_')) {
    const tableName = data.replace('tbl_list_', '');
    sendTableAccountsList(chatId, tableName);
    return;
  }

  if (data.startsWith('auto_')) {
    const action = data.replace('auto_', '');
    if (action === 'stop') {
      handleStopAutomation(chatId);
      return;
    }
    if (action === 'login') {
      promptAccountSelection(chatId, "Select account for Login:", "login");
      return;
    }
    if (action === 'switch_user') {
      const users = await db.getAllUsers();
      if (users.length === 0) {
        bot.sendMessage(chatId, "❌ No users found in DB.", startKeyboard);
        return;
      }
      let messageText = "👥 Select User Context to switch to:\n\n";
      const keyboard = users.map(u => [{ text: u.email, callback_data: `switch_to_user_${u.id}` }]);
      bot.sendMessage(chatId, messageText, { reply_markup: { inline_keyboard: keyboard } });
      return;
    }

    let cmdArgs = "";
    if (action === 'normal_checkout') cmdArgs = "checkout --confirm-place-order";
    else if (action === 'browser_checkout') cmdArgs = "checkout-browser --confirm-place-order";
    else if (action === 'full_checkout') cmdArgs = "full-checkout --confirm-place-order";

    userState[chatId].tempCheckoutAction = cmdArgs;
    promptConfigSelection(chatId, cmdArgs);
    return;
  }

  if (data.startsWith('sel_cfg_for_run|')) {
    const configName = data.split('|')[1];
    const action = userState[chatId].tempCheckoutAction || "checkout --confirm-place-order";
    userState[chatId].selectedConfigName = (configName === 'skip') ? null : configName;

    if (configName !== 'skip') {
      const currentUserId = getUserIdForChat(chatId);
      const wrote = await writeConfigFiles(currentUserId, configName);
      if (!wrote) {
        bot.sendMessage(chatId, `⚠️ Could not load config *${configName}* details to write JSON files. Proceeding anyway.`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(chatId, `✅ Config *${configName}* loaded and files written.`, { parse_mode: 'Markdown' });
      }
    }

    const friendlyName = (configName === 'skip') ? "No Config" : `Config: ${configName}`;
    promptAccountSelection(chatId, `Select account for Checkout (${friendlyName}):`, action);
    return;
  }

  if (data === 'set_view_addresses') {
    const currentUserId = getUserIdForChat(chatId);
    try {
      const addresses = await db.getSavedAddresses(currentUserId);
      if (!addresses || addresses.length === 0) {
        bot.sendMessage(chatId, "No saved addresses found.", startKeyboard);
        return;
      }
      let text = "📍 *Saved Addresses*:\n\n";
      const keyboard = [];
      addresses.forEach(a => {
        text += `• *${a.name}*: ${a.full_name}, ${a.phone}, ${a.pin}, ${a.line1}, ${a.line2}, ${a.city}, ${a.state}\n\n`;
        keyboard.push([{ text: `🗑️ Delete ${a.name}`, callback_data: `delete_addr|${a.name}` }]);
      });
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data === 'set_add_address') {
    userState[chatId].step = 'setting_add_address_name';
    bot.sendMessage(chatId, "➕ *Add Saved Address*\n\nPlease enter a unique nickname/identifier for this address (e.g. `address1`, `mumbai_hub`):", { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('delete_addr|')) {
    const name = data.split('|')[1];
    const currentUserId = getUserIdForChat(chatId);
    try {
      await db.deleteSavedAddress(currentUserId, name);
      bot.sendMessage(chatId, `🗑️ Address *${name}* deleted successfully.`, { parse_mode: 'Markdown', ...startKeyboard });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to delete address: ${err.message}`);
    }
    return;
  }

  if (data === 'set_view_buckets') {
    const currentUserId = getUserIdForChat(chatId);
    try {
      const buckets = await db.getProductBuckets(currentUserId);
      if (!buckets || buckets.length === 0) {
        bot.sendMessage(chatId, "No product buckets found.", startKeyboard);
        return;
      }
      let text = "📦 *Product Buckets*:\n\n";
      const keyboard = [];
      buckets.forEach(b => {
        const prodList = typeof b.products === 'string' ? JSON.parse(b.products) : b.products;
        const prodLines = prodList.map(p => `- ${p.asin} (Qty: ${p.quantity})`).join('\n');
        text += `• *${b.name}*:\n${prodLines}\n\n`;
        keyboard.push([{ text: `🗑️ Delete ${b.name}`, callback_data: `delete_bucket|${b.name}` }]);
      });
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data === 'set_add_bucket') {
    userState[chatId].step = 'setting_add_bucket_name';
    bot.sendMessage(chatId, "➕ *Add Product Bucket*\n\nPlease enter a unique name for this product bucket (e.g. `bucket1`, `low_price`):", { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('delete_bucket|')) {
    const name = data.split('|')[1];
    const currentUserId = getUserIdForChat(chatId);
    try {
      await db.deleteProductBucket(currentUserId, name);
      bot.sendMessage(chatId, `🗑️ Product bucket *${name}* deleted successfully.`, { parse_mode: 'Markdown', ...startKeyboard });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to delete product bucket: ${err.message}`);
    }
    return;
  }

  if (data === 'set_affiliate_tag') {
    let currentTag = 'earnkaro09e_1192-21';
    const settingsPath = path.join(__dirname, '..', 'config', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.affiliateTag) currentTag = settings.affiliateTag;
      } catch (e) { }
    }
    userState[chatId].step = 'setting_affiliate_tag';
    bot.sendMessage(chatId, `🏷️ *Set Affiliate Tag*\n\nYour current affiliate tag is: *${currentTag}*\n\nPlease send your new affiliate tag (or full Amazon affiliate link), or send \`default\` to reset to the default tag (\`earnkaro09e_1192-21\`):`, { parse_mode: 'Markdown' });
    return;
  }

  if (data === 'cfg_add_config') {
    userState[chatId].step = 'config_add_name';
    bot.sendMessage(chatId, "➕ *Add Config*\n\nPlease enter a unique name for this automation configuration (e.g. `mumbai_cfg`):", { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('cfg_sel_addr|')) {
    const addrName = data.split('|')[1];
    userState[chatId].tempConfigAddressName = addrName;

    const currentUserId = getUserIdForChat(chatId);
    try {
      const buckets = await db.getProductBuckets(currentUserId);
      if (!buckets || buckets.length === 0) {
        bot.sendMessage(chatId, "❌ You have no product buckets yet. Please create one under Settings first.", startKeyboard);
        userState[chatId].step = null;
        userState[chatId].tempConfigName = null;
        return;
      }
      const keyboard = buckets.map(b => [{ text: `📦 ${b.name}`, callback_data: `cfg_sel_bucket|${b.name}` }]);
      bot.sendMessage(chatId, "Step 3: Select a *Product Bucket* for this configuration:", {
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data.startsWith('cfg_sel_bucket|')) {
    const bucketName = data.split('|')[1];
    const configName = userState[chatId].tempConfigName;
    const addrName = userState[chatId].tempConfigAddressName;
    const currentUserId = getUserIdForChat(chatId);

    if (!configName || !addrName) {
      bot.sendMessage(chatId, "❌ Configuration session expired. Please start over.", startKeyboard);
      userState[chatId].step = null;
      return;
    }

    try {
      await db.addAutomationConfig(currentUserId, configName, addrName, bucketName);
      bot.sendMessage(chatId, `✅ Configuration *${configName}* successfully saved!\n\n• Address: *${addrName}*\n• Product Bucket: *${bucketName}*`, { parse_mode: 'Markdown', ...startKeyboard });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to save configuration: ${err.message}`, startKeyboard);
    }

    userState[chatId].step = null;
    userState[chatId].tempConfigName = null;
    userState[chatId].tempConfigAddressName = null;
    return;
  }

  if (data === 'cfg_bucket_replace_yes') {
    const bucketName = userState[chatId].tempBucketName;
    if (!bucketName) {
      bot.sendMessage(chatId, "❌ Session expired. Please start over.", startKeyboard);
      userState[chatId].step = null;
      return;
    }
    userState[chatId].tempBucket = { name: bucketName };
    userState[chatId].step = 'setting_add_bucket_products';
    userState[chatId].tempBucketName = null;
    bot.sendMessage(chatId,
      `✅ Bucket Name: *${bucketName}*\n\n` +
      `Now send the *product list* (one per line):\n\n` +
      `Format: \`ASIN  Quantity\`\n\n` +
      `Example:\n\`\`\`\nB006LXBSYM 2\nB01ABC456 1\n\`\`\`\n\n` +
      `_(If no quantity given, default is 1)_`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data === 'cfg_bucket_replace_no') {
    userState[chatId].step = null;
    userState[chatId].tempBucketName = null;
    bot.sendMessage(chatId, "❌ Cancelled adding product bucket.", startKeyboard);
    return;
  }

  if (data === 'cfg_address_replace_yes') {
    const addrName = userState[chatId].tempAddrName;
    if (!addrName) {
      bot.sendMessage(chatId, "❌ Session expired. Please start over.", startKeyboard);
      userState[chatId].step = null;
      return;
    }
    userState[chatId].tempAddr = { name: addrName };
    userState[chatId].step = 'setting_add_address_fullname';
    userState[chatId].tempAddrName = null;
    bot.sendMessage(chatId,
      `✅ Name: *${addrName}*\n\nStep 2/9: Enter the *Full Name* for this address.\n\nUse *(kabir)* to randomize names (e.g. \`(kabir) Sharma\`):`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (data === 'cfg_address_replace_no') {
    userState[chatId].step = null;
    userState[chatId].tempAddrName = null;
    bot.sendMessage(chatId, "❌ Cancelled adding address.", startKeyboard);
    return;
  }

  if (data === 'cfg_config_replace_yes') {
    const configName = userState[chatId].tempConfigNameConflict;
    if (!configName) {
      bot.sendMessage(chatId, "❌ Session expired. Please start over.", startKeyboard);
      userState[chatId].step = null;
      return;
    }
    userState[chatId].tempConfigName = configName;
    userState[chatId].tempConfigNameConflict = null;
    const currentUserId = getUserIdForChat(chatId);
    try {
      const addresses = await db.getSavedAddresses(currentUserId);
      if (!addresses || addresses.length === 0) {
        bot.sendMessage(chatId, '❌ No saved addresses found. Please add an address first under ⚙️ Setting.', startKeyboard);
        userState[chatId].tempConfigName = null;
        return;
      }
      const keyboard = addresses.map(a => [{ text: `📍 ${a.name}`, callback_data: `cfg_sel_addr|${a.name}` }]);
      bot.sendMessage(chatId, `✅ Config Name: *${configName}*\n\nStep 2: Select an *Address*:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data === 'cfg_config_replace_no') {
    userState[chatId].step = null;
    userState[chatId].tempConfigNameConflict = null;
    bot.sendMessage(chatId, "❌ Cancelled adding config.", startKeyboard);
    return;
  }

  if (data === 'cfg_edit_config') {
    const currentUserId = getUserIdForChat(chatId);
    try {
      const configs = await db.getAutomationConfigs(currentUserId);
      if (!configs || configs.length === 0) {
        bot.sendMessage(chatId, "No saved configurations found.", startKeyboard);
        return;
      }
      let text = "🔧 *Select configuration to edit/delete*:\n";
      const keyboard = configs.map(c => [{ text: `🔧 ${c.name}`, callback_data: `cfg_edit_select|${c.name}` }]);
      bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data.startsWith('cfg_edit_select|')) {
    const configName = data.split('|')[1];
    const keyboard = [
      [{ text: `✏️ Modify Config: ${configName}`, callback_data: `cfg_modify|${configName}` }],
      [{ text: `🗑️ Delete Config: ${configName}`, callback_data: `cfg_delete|${configName}` }],
      [{ text: "🔙 Back to Configurations", callback_data: "cfg_edit_config" }]
    ];
    bot.sendMessage(chatId, `🔧 *Edit Configuration*: *${configName}*\n\nSelect an option:`, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (data.startsWith('cfg_modify|')) {
    const configName = data.split('|')[1];
    userState[chatId].step = 'config_modify_name';
    userState[chatId].tempEditConfigName = configName;
    const currentUserId = getUserIdForChat(chatId);
    try {
      const addresses = await db.getSavedAddresses(currentUserId);
      if (!addresses || addresses.length === 0) {
        bot.sendMessage(chatId, '❌ No saved addresses found. Add one under ⚙️ Setting first.', startKeyboard);
        userState[chatId].step = null;
        return;
      }
      const keyboard = addresses.map(a => [{ text: `📍 ${a.name}`, callback_data: `cfg_modify_addr|${a.name}` }]);
      bot.sendMessage(chatId, `✏️ *Modify Config*: *${configName}*\n\nStep 1: Select new *Address*:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data.startsWith('cfg_modify_addr|')) {
    const addrName = data.split('|')[1];
    userState[chatId].tempModifyAddressName = addrName;
    const currentUserId = getUserIdForChat(chatId);
    try {
      const buckets = await db.getProductBuckets(currentUserId);
      if (!buckets || buckets.length === 0) {
        bot.sendMessage(chatId, '❌ No product buckets found. Add one under ⚙️ Setting first.', startKeyboard);
        userState[chatId].step = null;
        return;
      }
      const keyboard = buckets.map(b => [{ text: `📦 ${b.name}`, callback_data: `cfg_modify_bucket|${b.name}` }]);
      bot.sendMessage(chatId, `Step 2: Select new *Product Bucket*:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (data.startsWith('cfg_modify_bucket|')) {
    const bucketName = data.split('|')[1];
    const configName = userState[chatId].tempEditConfigName;
    const addrName = userState[chatId].tempModifyAddressName;
    const currentUserId = getUserIdForChat(chatId);
    if (!configName || !addrName) {
      bot.sendMessage(chatId, '❌ Modify session expired. Please start over.', startKeyboard);
      userState[chatId].step = null;
      return;
    }
    try {
      await db.updateAutomationConfig(currentUserId, configName, addrName, bucketName);
      bot.sendMessage(chatId, `✅ Config *${configName}* updated!\n\n• Address: *${addrName}*\n• Product Bucket: *${bucketName}*`, { parse_mode: 'Markdown', ...startKeyboard });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to update config: ${err.message}`, startKeyboard);
    }
    userState[chatId].step = null;
    userState[chatId].tempEditConfigName = null;
    userState[chatId].tempModifyAddressName = null;
    return;
  }

  if (data.startsWith('cfg_delete|')) {
    const configName = data.split('|')[1];
    const currentUserId = getUserIdForChat(chatId);
    try {
      await db.deleteAutomationConfig(currentUserId, configName);
      bot.sendMessage(chatId, `🗑️ Configuration *${configName}* deleted successfully.`, { parse_mode: 'Markdown', ...startKeyboard });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to delete configuration: ${err.message}`);
    }
    return;
  }

  // ── MOVE ACCOUNT FLOW ──────────────────────────────────────────
  if (data.startsWith('move_from|')) {
    const fromTable = data.split('|')[1];
    const currentUserId = getUserIdForChat(chatId);
    userState[chatId].moveFrom = fromTable;

    const accounts = await db.getAccountsFromTable(currentUserId, fromTable);
    if (!accounts || accounts.length === 0) {
      bot.sendMessage(chatId, `⚠️ No accounts found in *${fromTable}*.`, { parse_mode: 'Markdown', ...removeKeyboard });
      userState[chatId].step = null;
      return;
    }

    // Show list and ask for account number
    let text = `📋 *${fromTable}* (${accounts.length} accounts):\n\n`;
    accounts.forEach((acc, i) => { text += `[${i + 1}] ${acc.email}\n`; });
    text += `\nStep 2: Reply with account *number* (e.g. 1) or *all* to move all accounts.`;

    userState[chatId].moveAccounts = accounts.map(a => a.email);
    userState[chatId].step = 'move_select_account';
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
    return;
  }

  if (data.startsWith('move_to|')) {
    const toTable = data.split('|')[1];
    const fromTable = userState[chatId].moveFrom;
    const emailsToMove = userState[chatId].moveEmailsToMove;
    const currentUserId = getUserIdForChat(chatId);

    if (!fromTable || !emailsToMove || emailsToMove.length === 0) {
      bot.sendMessage(chatId, '❌ Move session expired. Please run /move_account again.', removeKeyboard);
      return;
    }
    if (fromTable === toTable) {
      bot.sendMessage(chatId, '⚠️ Source and destination are the same table. Please pick a different table.', removeKeyboard);
      return;
    }

    userState[chatId].step = null;
    bot.sendMessage(chatId, `⏳ Moving ${emailsToMove.length} account(s) from *${fromTable}* → *${toTable}*...`, { parse_mode: 'Markdown' });

    let successCount = 0;
    let failCount = 0;
    for (const email of emailsToMove) {
      try {
        await db.moveAccount(email, currentUserId, fromTable, toTable);
        successCount++;
      } catch (err) {
        console.error(`❌ Move failed for ${email}:`, err.message);
        failCount++;
      }
    }

    let resultMsg = `✅ *Move Complete!*\n\n`;
    resultMsg += `From: *${fromTable}*\n`;
    resultMsg += `To: *${toTable}*\n\n`;
    resultMsg += `✅ Moved: ${successCount} account(s)\n`;
    if (failCount > 0) resultMsg += `❌ Failed: ${failCount} account(s)\n`;
    bot.sendMessage(chatId, resultMsg, { parse_mode: 'Markdown', ...removeKeyboard });
    return;
  }
  // ──────────────────────────────────────────────────────────────

  if (data.startsWith('sel_table|')) {
    const parts = data.split('|');
    const tableName = parts[1];
    const state = userState[chatId] || {};
    const actionMessage = state.tempActionMessage || "Select account:";
    const actionCallbackData = state.tempActionCallback || "cart list";
    promptAccountSelection(chatId, actionMessage, actionCallbackData, tableName);
    return;
  }

  if (data.startsWith('switch_to_user_')) {
    const userId = parseInt(data.replace('switch_to_user_', ''), 10);
    chatActiveUser[chatId] = userId;
    db.getUser(userId).then(user => {
      const email = user ? user.email : `ID ${userId}`;
      bot.sendMessage(chatId, `🔄 Switched active user context to: *${email}* (ID: ${userId})`, { parse_mode: 'Markdown', ...removeKeyboard });
    }).catch(e => {
      bot.sendMessage(chatId, `❌ Failed to switch user: ${e.message}`, removeKeyboard);
    });
    return;
  }

  if (data.startsWith('page_acc_')) {
    const page = parseInt(data.replace('page_acc_', ''), 10);
    sendPaginatedAccounts(chatId, page);
    return;
  }

  if (data.startsWith('delete_asin_')) {
    const asin = data.replace('delete_asin_', '');
    promptAccountSelection(chatId, `Select account to delete ASIN ${asin} from cart:`, `cart delete ${asin}`);
    return;
  }

  switch (data) {
    case 'menu_cart':
      bot.sendMessage(chatId, "🛒 Cart Operations:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📄 List Cart", callback_data: "cmd_cart_list" }],
            [{ text: "➕ Add to Cart", callback_data: "prompt_cart_add" }],
            [{ text: "❌ Delete from Cart", callback_data: "prompt_cart_delete" }],
            [{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]
          ]
        }
      });
      break;
    case 'menu_address':
      bot.sendMessage(chatId, "📍 Address Operations:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "📄 List Addresses", callback_data: "cmd_address_list" }],
            [{ text: "➕ Add Address", callback_data: "prompt_address_add" }],
            [{ text: "❌ Delete Address", callback_data: "prompt_address_delete" }],
            [{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]
          ]
        }
      });
      break;
    case 'menu_checkout':
      bot.sendMessage(chatId, "💳 Checkout Operations:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🛍️ Normal Checkout", callback_data: "cmd_checkout" }],
            [{ text: "🌐 Browser Checkout", callback_data: "cmd_checkout_browser" }],
            [{ text: "🚀 Full Checkout", callback_data: "cmd_full_checkout" }],
            [{ text: "🔙 Back to Main Menu", callback_data: "menu_main" }]
          ]
        }
      });
      break;
    case 'menu_main':
      bot.sendMessage(chatId, "Main Menu:", removeKeyboard);
      break;

    case 'cmd_cart_list': promptAccountSelection(chatId, "Select account for List Cart:", "cart list"); break;
    case 'prompt_cart_add':
      userState[chatId].step = 'cart_add';
      bot.sendMessage(chatId, "Send me the ASIN to add to cart:");
      break;
    case 'prompt_cart_delete': promptCartDelete(chatId); break;
    case 'cmd_address_list': promptAccountSelection(chatId, "Select account for List Addresses:", "address list"); break;
    case 'cmd_checkout': promptAccountSelection(chatId, "Select account for Normal Checkout:", "checkout --confirm-place-order"); break;
    case 'cmd_checkout_browser': promptAccountSelection(chatId, "Select account for Browser Checkout:", "checkout-browser --confirm-place-order"); break;
    case 'cmd_full_checkout': promptAccountSelection(chatId, "Select account for Full Checkout:", "full-checkout --confirm-place-order"); break;

    case 'prompt_address_add':
      userState[chatId].step = 'address_add';
      bot.sendMessage(chatId, "Send address details: <Name> <Phone> <Pin> <Line1> <Line2> <City> <State> [Landmark]");
      break;
    case 'prompt_address_delete':
      userState[chatId].step = 'address_delete';
      bot.sendMessage(chatId, "Send Address ID to delete or 'all':");
      break;
  }
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === '🛑 STOP STOP KARO' || text === 'STOP STOP KARO') {
    handleStopAutomation(chatId);
    return;
  }

  if (!text) return;

  if (text === '📋 Menu') {
    const keyboard = [
      [{ text: "✉️ Active List", callback_data: "tbl_list_accounts" }],
      [{ text: "🛑 No COD List", callback_data: "tbl_list_no_cod_accounts" }, { text: "⚠️ Past Order List", callback_data: "tbl_list_past_order" }],
      [{ text: "📍 Delivery Issue List", callback_data: "tbl_list_delivery_issue" }, { text: "📦 Purchase Limit List", callback_data: "tbl_list_purchase_limit" }]
    ];
    bot.sendMessage(chatId, "📋 *Account Lists by Table*:\nSelect a table to view accounts:", {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (text === '⚡ Automation') {
    const keyboard = [
      [{ text: "🚀 Full Checkout (IP Rotator)", callback_data: "auto_full_checkout" }],
      [{ text: "🔑 Login to Amazon", callback_data: "auto_login" }],
      [{ text: "👥 Switch User Context", callback_data: "auto_switch_user" }],
      [{ text: "🛑 STOP AUTOMATION", callback_data: "auto_stop" }]
    ];
    bot.sendMessage(chatId, "⚡ *Checkout & Automation Menu*:\nSelect an option to run:", {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (text === '⚙️ Setting') {
    const keyboard = [
      [{ text: "📋 View Saved Addresses", callback_data: "set_view_addresses" }, { text: "➕ Add Address", callback_data: "set_add_address" }],
      [{ text: "📋 View Product Buckets", callback_data: "set_view_buckets" }, { text: "➕ Add Product Bucket", callback_data: "set_add_bucket" }],
      [{ text: "🏷️ Set Affiliate Tag", callback_data: "set_affiliate_tag" }]
    ];
    bot.sendMessage(chatId, "⚙️ *Settings Menu*:\nManage saved addresses, product buckets, and affiliate tags:", {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (text === '🔧 Config') {
    const keyboard = [
      [{ text: "➕ Add Config", callback_data: "cfg_add_config" }],
      [{ text: "✏️ Edit Config", callback_data: "cfg_edit_config" }]
    ];
    bot.sendMessage(chatId, "🔧 *Configuration Menu*:\nMap addresses and product buckets together for easy automation runs:", {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
    return;
  }

  if (text.startsWith('/')) return;

  if (!userState[chatId]) userState[chatId] = { step: null };

  // ── MOVE ACCOUNT: Step 2 — account selection ───────────────────
  if (userState[chatId].step === 'move_select_account') {
    const accounts = userState[chatId].moveAccounts || [];
    let emailsToMove = [];

    if (text.trim().toLowerCase() === 'all') {
      emailsToMove = accounts;
    } else {
      const rangeMatch = text.trim().match(/^(\d+)-(\d+)$/);
      const singleMatch = text.trim().match(/^(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10) - 1;
        const end = parseInt(rangeMatch[2], 10) - 1;
        if (start >= 0 && end < accounts.length && start <= end) {
          emailsToMove = accounts.slice(start, end + 1);
        } else {
          bot.sendMessage(chatId, '❌ Invalid range. Try again or run /move_account again.', removeKeyboard);
          return;
        }
      } else if (singleMatch) {
        const idx = parseInt(singleMatch[1], 10) - 1;
        if (idx >= 0 && idx < accounts.length) {
          emailsToMove = [accounts[idx]];
        } else {
          bot.sendMessage(chatId, '❌ Invalid number. Try again or run /move_account again.', removeKeyboard);
          return;
        }
      } else {
        bot.sendMessage(chatId, '❌ Invalid input. Send a number (e.g. 3), a range (e.g. 1-5), or "all".', removeKeyboard);
        return;
      }
    }

    userState[chatId].moveEmailsToMove = emailsToMove;
    userState[chatId].step = 'move_select_to';

    let preview = emailsToMove.length <= 5
      ? emailsToMove.map((e, i) => `${i + 1}. ${e}`).join('\n')
      : `${emailsToMove.length} accounts selected`;

    const destTables = ALL_TABLES.filter(t => t !== userState[chatId].moveFrom);
    const keyboard = destTables.map(t => [
      { text: `${TABLE_ICONS[t]} ${t}`, callback_data: `move_to|${t}` }
    ]);
    bot.sendMessage(chatId,
      `✅ Selected:\n${preview}\n\nStep 3: Select *TO* which table to move:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
    );
    return;
  }
  // ──────────────────────────────────────────────────────────────
  const state = userState[chatId];

  // Detect if the message is a start URL (affiliate link)
  if (text.trim().startsWith("http") && text.includes("amazon.in") && text.includes("tag=")) {
    state.startUrl = text.trim();
    bot.sendMessage(chatId, `✅ Affiliate start URL registered:\n\`${state.startUrl}\`\n\nThis link will be opened first in the browser during your next checkout command.`, { parse_mode: 'Markdown', ...removeKeyboard });
    return;
  }

  if (state.pendingAction) {
    const action = state.pendingAction;
    const table = state.selectedTableForAction || 'accounts';
    state.pendingAction = null;
    state.selectedTableForAction = null;
    if (text.toLowerCase() === 'all' || /^\d+$/.test(text) || /^\d+-\d+$/.test(text)) {
      if (action.includes("checkout")) {
        state.checkoutAction = action;
        state.selectedAccounts = text;
        state.checkoutTable = table;
        state.step = 'checkout_price_limit';
        bot.sendMessage(chatId, "💰 *Set Price Limits (Min-Max)*\n\nPlease enter the price range for this checkout.\nFormat: `500-1200` (e.g. Min 500, Max 1200)\n\nType *no* if you don't want any price limits.", { parse_mode: 'Markdown', ...removeKeyboard });
      } else {
        runModularScript(chatId, action, text, table);
      }
    } else {
      bot.sendMessage(chatId, "❌ Invalid input. Returning to main menu.", removeKeyboard);
    }
    return;
  }

  if (state.step === 'checkout_price_limit') {
    const response = text.trim().toLowerCase();
    const table = state.checkoutTable || 'accounts';
    if (response === 'no' || response === 'skip') {
      state.step = null;
      const action = state.checkoutAction;
      const accounts = state.selectedAccounts;
      state.checkoutAction = null;
      state.selectedAccounts = null;
      state.checkoutTable = null;
      runModularScript(chatId, action, accounts, table);
    } else {
      const match = text.trim().match(/^(\d+)-(\d+)$/);
      if (match) {
        state.step = null;
        const minPrice = parseInt(match[1], 10);
        const maxPrice = parseInt(match[2], 10);
        const action = `${state.checkoutAction} --min-price ${minPrice} --max-price ${maxPrice}`;
        const accounts = state.selectedAccounts;
        state.checkoutAction = null;
        state.selectedAccounts = null;
        state.checkoutTable = null;
        runModularScript(chatId, action, accounts, table);
      } else {
        bot.sendMessage(chatId, "❌ Invalid format. Please enter as `Min-Max` (e.g. `500-1200`) or type `no` to skip:", { parse_mode: 'Markdown' });
      }
    }
    return;
  }

  if (state.step === 'cart_add') {
    state.step = null;
    promptAccountSelection(chatId, "Select account to add ASIN to cart:", `cart add ${text}`);
  } else if (state.step === 'cart_delete_manual') {
    state.step = null;
    promptAccountSelection(chatId, "Select account to delete ASIN from cart:", `cart delete ${text}`);
  } else if (state.step === 'address_add') {
    state.step = null;
    promptAccountSelection(chatId, "Select account to add address to:", `address add ${text}`);
  } else if (state.step === 'address_delete') {
    state.step = null;
    promptAccountSelection(chatId, "Select account to delete address from:", `address delete ${text}`);
  } else if (state.step === 'add_account') {
    state.step = null;
    const email = text.trim();
    if (email.includes('@')) {
      const currentUserId = getUserIdForChat(chatId);
      await db.addAccount(currentUserId, email);
      bot.sendMessage(chatId, `✅ Added account: ${email} for User ID ${currentUserId}`, removeKeyboard);
    } else {
      bot.sendMessage(chatId, `❌ Invalid email format.`, removeKeyboard);
    }
  } else if (state.step === 'set_affiliate') {
    state.step = null;
    let tag = text.trim();
    const match = tag.match(/tag=([^&\s]+)/);
    if (match) tag = match[1];

    let settings = {};
    if (fs.existsSync("settings.json")) {
      try { settings = JSON.parse(fs.readFileSync("settings.json", "utf8")); } catch (e) { }
    }
    settings.affiliateTag = tag;
    fs.writeFileSync("settings.json", JSON.stringify(settings, null, 2));
    bot.sendMessage(chatId, `✅ Affiliate tag successfully set to: ${tag}`, removeKeyboard);
  } else if (state.step === 'add_products') {
    state.step = null;
    const lines = text.trim().split('\n').filter(l => l.trim());
    const newProducts = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const rawInput = parts[0];
      const quantity = parseInt(parts[1], 10) || 1;
      const asin = extractAsin(rawInput);
      if (asin) newProducts.push({ asin, quantity });
    }
    if (newProducts.length === 0) {
      bot.sendMessage(chatId, '❌ No valid products found. Please try again.', removeKeyboard);
      return;
    }
    // Load existing products and append
    let existing = [];
    if (fs.existsSync('cart_input.json')) {
      try {
        const cartInput = JSON.parse(fs.readFileSync('cart_input.json', 'utf8'));
        if (cartInput.products && Array.isArray(cartInput.products)) {
          existing = cartInput.products;
        } else if (cartInput.asin) {
          existing = [{ asin: cartInput.asin, quantity: cartInput.quantity || 1 }];
        }
      } catch (e) { }
    }
    const allProducts = [...existing, ...newProducts];
    fs.writeFileSync('cart_input.json', JSON.stringify({ products: allProducts }, null, 2));
    let msg = `✅ Added ${newProducts.length} product(s). Total: ${allProducts.length}\n\n`;
    allProducts.forEach((p, i) => {
      const isNew = i >= existing.length ? ' 🆕' : '';
      msg += `${i + 1}. ${p.asin} (Qty: ${p.quantity})${isNew}\n`;
    });
    bot.sendMessage(chatId, msg, removeKeyboard);
  } else if (state.step === 'remove_product') {
    state.step = null;
    const idx = parseInt(text.trim(), 10) - 1;
    let products = [];
    if (fs.existsSync('cart_input.json')) {
      try {
        const cartInput = JSON.parse(fs.readFileSync('cart_input.json', 'utf8'));
        if (cartInput.products && Array.isArray(cartInput.products)) products = cartInput.products;
        else if (cartInput.asin) products = [{ asin: cartInput.asin, quantity: cartInput.quantity || 1 }];
      } catch (e) { }
    }
    if (idx < 0 || idx >= products.length) {
      bot.sendMessage(chatId, `❌ Invalid number. You have ${products.length} products. Send a number between 1-${products.length}.`, removeKeyboard);
      return;
    }
    const removed = products.splice(idx, 1)[0];
    fs.writeFileSync('cart_input.json', JSON.stringify({ products }, null, 2));
    bot.sendMessage(chatId, `🗑️ Removed: ${removed.asin} (Qty: ${removed.quantity})\nRemaining: ${products.length} product(s)`, removeKeyboard);

    // ── STEP-BY-STEP: Add Saved Address ────────────────────────────
  } else if (state.step === 'setting_add_address_name') {
    const addrNickname = text.trim();
    if (!addrNickname || addrNickname.includes(' ')) {
      bot.sendMessage(chatId, '❌ Invalid name. It should be a single word (e.g. `address1`, `mumbai_hub`). Try again:', { parse_mode: 'Markdown' });
      return;
    }
    const currentUserId = getUserIdForChat(chatId);
    try {
      const existing = await db.getSavedAddressByName(currentUserId, addrNickname);
      if (existing) {
        state.tempAddrName = addrNickname;
        const keyboard = [
          [{ text: "✅ Yes, Replace", callback_data: "cfg_address_replace_yes" }],
          [{ text: "❌ No, Cancel", callback_data: "cfg_address_replace_no" }]
        ];
        bot.sendMessage(chatId, `⚠️ Saved address *${addrNickname}* already exists in VPS DB. Do you want to replace it?`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }
    } catch (err) {
      console.error(err);
    }
    state.tempAddr = { name: addrNickname };
    state.step = 'setting_add_address_fullname';
    bot.sendMessage(chatId,
      `✅ Name: *${addrNickname}*\n\nStep 2/9: Enter the *Full Name* for this address.\n\nUse *(kabir)* to randomize names (e.g. \`(kabir) Sharma\`):`,
      { parse_mode: 'Markdown' }
    );
  } else if (state.step === 'setting_add_address_fullname') {
    state.tempAddr.fullName = text.trim();
    state.step = 'setting_add_address_phone';
    bot.sendMessage(chatId, `✅ Full Name: *${state.tempAddr.fullName}*\n\nStep 3/9: Enter the *Phone Number*:`, { parse_mode: 'Markdown' });
  } else if (state.step === 'setting_add_address_phone') {
    state.tempAddr.phone = text.trim();
    state.step = 'setting_add_address_pin';
    bot.sendMessage(chatId, `✅ Phone: *${state.tempAddr.phone}*\n\nStep 4/9: Enter the *PIN / Postal Code*:`, { parse_mode: 'Markdown' });
  } else if (state.step === 'setting_add_address_pin') {
    state.tempAddr.pin = text.trim();
    state.step = 'setting_add_address_line1';
    bot.sendMessage(chatId, `✅ PIN: *${state.tempAddr.pin}*\n\nStep 5/9: Enter *Address Line 1*.\n\nUse *(123)* to randomize numbers (e.g. \`House No. (123)\`):`, { parse_mode: 'Markdown' });
  } else if (state.step === 'setting_add_address_line1') {
    state.tempAddr.line1 = text.trim();
    state.step = 'setting_add_address_line2';
    bot.sendMessage(chatId, `✅ Line 1: *${state.tempAddr.line1}*\n\nStep 6/9: Enter *Address Line 2*.\n\nUse *(89)* to randomize numbers (e.g. \`Street No. (89)\`):`, { parse_mode: 'Markdown' });
  } else if (state.step === 'setting_add_address_line2') {
    state.tempAddr.line2 = text.trim();
    state.step = 'setting_add_address_city';
    bot.sendMessage(chatId, `✅ Line 2: *${state.tempAddr.line2}*\n\nStep 7/9: Enter the *City*:`, { parse_mode: 'Markdown' });
  } else if (state.step === 'setting_add_address_city') {
    state.tempAddr.city = text.trim();
    state.step = 'setting_add_address_state';
    bot.sendMessage(chatId, `✅ City: *${state.tempAddr.city}*\n\nStep 8/9: Enter the *State* (e.g. \`Maharashtra\`, \`Delhi\`):`, { parse_mode: 'Markdown' });
  } else if (state.step === 'setting_add_address_state') {
    state.tempAddr.state = text.trim();
    state.step = 'setting_add_address_landmark';
    bot.sendMessage(chatId, `✅ State: *${state.tempAddr.state}*\n\nStep 9/9: Enter a *Landmark* (optional — send \`-\` to skip):`, { parse_mode: 'Markdown' });
  } else if (state.step === 'setting_add_address_landmark') {
    const landmark = (text.trim() === '-') ? '' : text.trim();
    state.tempAddr.landmark = landmark;
    const a = state.tempAddr;
    const currentUserId = getUserIdForChat(chatId);
    state.step = null;
    state.tempAddr = null;
    try {
      await db.addSavedAddress(currentUserId, a.name, a.fullName, a.phone, a.pin, a.line1, a.line2, a.city, a.state, a.landmark);
      bot.sendMessage(chatId,
        `✅ *Address Saved!*\n\n` +
        `📌 *Name:* ${a.name}\n` +
        `👤 *Full Name:* ${a.fullName}\n` +
        `📞 *Phone:* ${a.phone}\n` +
        `🏠 *Line 1:* ${a.line1}\n` +
        `🏠 *Line 2:* ${a.line2}\n` +
        `🏙️ *City:* ${a.city}, ${a.state} - ${a.pin}\n` +
        (a.landmark ? `🏛️ *Landmark:* ${a.landmark}\n` : ''),
        { parse_mode: 'Markdown', ...startKeyboard }
      );
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to save address: ${err.message}`, startKeyboard);
    }

    // ── STEP-BY-STEP: Add Product Bucket ───────────────────────────
  } else if (state.step === 'setting_add_bucket_name') {
    const bucketNickname = text.trim();
    if (!bucketNickname || bucketNickname.includes(' ')) {
      bot.sendMessage(chatId, '❌ Invalid bucket name. It should be a single word (e.g. `bucket1`, `low_price`). Try again:', { parse_mode: 'Markdown' });
      return;
    }
    const currentUserId = getUserIdForChat(chatId);
    try {
      const existing = await db.getProductBucketByName(currentUserId, bucketNickname);
      if (existing) {
        state.tempBucketName = bucketNickname;
        const keyboard = [
          [{ text: "✅ Yes, Replace", callback_data: "cfg_bucket_replace_yes" }],
          [{ text: "❌ No, Cancel", callback_data: "cfg_bucket_replace_no" }]
        ];
        bot.sendMessage(chatId, `⚠️ Product bucket *${bucketNickname}* already exists in VPS db. Do you want to replace it?`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }
    } catch (err) {
      console.error(err);
    }
    state.tempBucket = { name: bucketNickname };
    state.step = 'setting_add_bucket_products';
    bot.sendMessage(chatId,
      `✅ Bucket Name: *${bucketNickname}*\n\n` +
      `Now send the *product list* (one per line):\n\n` +
      `Format: \`ASIN  Quantity\`\n\n` +
      `Example:\n\`\`\`\nB006LXBSYM 2\nB01ABC456 1\n\`\`\`\n\n` +
      `_(If no quantity given, default is 1)_`,
      { parse_mode: 'Markdown' }
    );
  } else if (state.step === 'setting_add_bucket_products') {
    const lines = text.trim().split('\n').filter(l => l.trim());
    const newProducts = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const rawInput = parts[0];
      const quantity = parseInt(parts[1], 10) || 1;
      const asin = extractAsin(rawInput);
      if (asin) newProducts.push({ asin, quantity });
    }
    if (newProducts.length === 0) {
      bot.sendMessage(chatId, '❌ No valid products found. Send at least one product in the format `ASIN Quantity`:', { parse_mode: 'Markdown' });
      return;
    }
    const bucketName = state.tempBucket.name;
    const currentUserId = getUserIdForChat(chatId);
    state.step = null;
    state.tempBucket = null;
    try {
      await db.addProductBucket(currentUserId, bucketName, newProducts);
      let msg = `✅ *Product Bucket Saved!*\n\n📦 *Bucket:* ${bucketName}\n\n*Products (${newProducts.length}):*\n`;
      newProducts.forEach((p, i) => { msg += `${i + 1}. ${p.asin} (Qty: ${p.quantity})\n`; });
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', ...startKeyboard });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to save product bucket: ${err.message}`, startKeyboard);
    }

    // ── STEP-BY-STEP: Add Config — name step ───────────────────────
  } else if (state.step === 'config_add_name') {
    const configNickname = text.trim();
    if (!configNickname || configNickname.includes(' ')) {
      bot.sendMessage(chatId, '❌ Invalid config name. It should be a single word (e.g. `config1`, `mumbai_cfg`). Try again:', { parse_mode: 'Markdown' });
      return;
    }
    const currentUserId = getUserIdForChat(chatId);
    try {
      const existing = await db.getAutomationConfigDetails(currentUserId, configNickname);
      if (existing) {
        state.tempConfigNameConflict = configNickname;
        const keyboard = [
          [{ text: "✅ Yes, Replace", callback_data: "cfg_config_replace_yes" }],
          [{ text: "❌ No, Cancel", callback_data: "cfg_config_replace_no" }]
        ];
        bot.sendMessage(chatId, `⚠️ Automation config *${configNickname}* already exists. Do you want to replace it?`, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        });
        return;
      }
    } catch (err) {
      console.error(err);
    }
    state.tempConfigName = configNickname;
    state.step = null;
    try {
      const addresses = await db.getSavedAddresses(currentUserId);
      if (!addresses || addresses.length === 0) {
        bot.sendMessage(chatId, '❌ No saved addresses found. Please add an address first under ⚙️ Setting.', startKeyboard);
        state.tempConfigName = null;
        return;
      }
      const keyboard = addresses.map(a => [{ text: `📍 ${a.name}`, callback_data: `cfg_sel_addr|${a.name}` }]);
      bot.sendMessage(chatId, `✅ Config Name: *${configNickname}*\n\nStep 2: Select an *Address*:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    } catch (err) {
      bot.sendMessage(chatId, `❌ Error: ${err.message}`);
      state.tempConfigName = null;
    }

    // ── Affiliate tag from callback ─────────────────────────────────
  } else if (state.step === 'setting_affiliate_tag') {
    state.step = null;
    let tag = text.trim();
    if (tag.toLowerCase() === 'default') tag = 'earnkaro09e_1192-21';
    const tagMatch = tag.match(/tag=([^&\s]+)/);
    if (tagMatch) tag = tagMatch[1];
    const settingsPath = path.join(__dirname, '..', 'config', 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch (e) { }
    }
    settings.affiliateTag = tag;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    bot.sendMessage(chatId, `✅ Affiliate tag set to: *${tag}*`, { parse_mode: 'Markdown', ...startKeyboard });
  }
});

// Helper to display accounts in a specific table
async function sendTableAccountsList(chatId, tableName) {
  const currentUserId = getUserIdForChat(chatId);
  try {
    const accounts = await db.getAccountsFromTable(currentUserId, tableName);
    if (!accounts || accounts.length === 0) {
      bot.sendMessage(chatId, `No accounts in table *${tableName}* yet.`, { parse_mode: 'Markdown', ...removeKeyboard });
      return;
    }

    const chunks = [];
    let currentChunk = `📋 *Table: ${tableName}* (Total: ${accounts.length}):\n\n`;

    accounts.forEach((acc, idx) => {
      const addedDate = acc.added_at ? new Date(acc.added_at).toLocaleString() : 'N/A';
      let entryText = `[${idx + 1}] *${acc.email}*\n`;
      if (acc.order_id) entryText += `   Order ID: \`${acc.order_id}\`\n`;
      if (acc.reason_text) entryText += `   Reason: _${acc.reason_text}_\n`;
      if (acc.added_at) entryText += `   Moved: _${addedDate}_\n`;
      entryText += `\n`;

      if (currentChunk.length + entryText.length > 3900) {
        chunks.push(currentChunk);
        currentChunk = entryText;
      } else {
        currentChunk += entryText;
      }
    });

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', ...removeKeyboard });
    }
  } catch (err) {
    bot.sendMessage(chatId, `❌ Failed to retrieve accounts for ${tableName}: ${err.message}`, removeKeyboard);
  }
}

bot.onText(/\/manage_accounts/, (msg) => {
  sendPaginatedAccounts(msg.chat.id, 1);
});

bot.onText(/\/active_list/, (msg) => {
  sendTableAccountsList(msg.chat.id, 'accounts');
});

bot.onText(/\/no_cod_list/, (msg) => {
  sendTableAccountsList(msg.chat.id, 'no_cod_accounts');
});

bot.onText(/\/past_order_list/, (msg) => {
  sendTableAccountsList(msg.chat.id, 'past_order');
});

bot.onText(/\/delivery_issue_list/, (msg) => {
  sendTableAccountsList(msg.chat.id, 'delivery_issue');
});

bot.onText(/\/purchase_limit_list/, (msg) => {
  sendTableAccountsList(msg.chat.id, 'purchase_limit');
});

// ==================== MOVE ACCOUNT COMMAND ====================
const ALL_TABLES = ['accounts', 'no_cod_accounts', 'success_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
const TABLE_ICONS = {
  accounts: '✅',
  no_cod_accounts: '🛑',
  success_accounts: '🎉',
  past_order: '⚠️',
  delivery_issue: '📦',
  purchase_limit: '🔒'
};

bot.onText(/\/move_account/, (msg) => {
  const chatId = msg.chat.id;
  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].step = 'move_select_from';

  const keyboard = ALL_TABLES.map(t => [
    { text: `${TABLE_ICONS[t]} ${t}`, callback_data: `move_from|${t}` }
  ]);
  bot.sendMessage(chatId, '🔄 *Move Account*\n\nStep 1: Select *FROM* which table to move the account:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.onText(/\/add_account/, (msg) => {
  const chatId = msg.chat.id;
  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].step = 'add_account';
  bot.sendMessage(chatId, "Please type the Amazon email address you want to add:");
});

bot.onText(/\/cart_list/, (msg) => { promptAccountSelection(msg.chat.id, "Select account for List Cart:", "cart list"); });
bot.onText(/\/cart_add/, (msg) => {
  const chatId = msg.chat.id;
  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].step = 'cart_add';
  bot.sendMessage(chatId, "Send me the ASIN to add to cart:");
});
bot.onText(/\/cart_delete/, (msg) => { promptCartDelete(msg.chat.id); });
bot.onText(/\/address_list/, (msg) => { promptAccountSelection(msg.chat.id, "Select account for List Addresses:", "address list"); });
bot.onText(/\/address_add/, (msg) => {
  const chatId = msg.chat.id;
  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].step = 'address_add';
  bot.sendMessage(chatId, "Send address details:");
});
bot.onText(/\/address_delete/, (msg) => {
  const chatId = msg.chat.id;
  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].step = 'address_delete';
  bot.sendMessage(chatId, "Send address ID or 'all' to delete:");
});
bot.onText(/\/full_checkout/, (msg) => { promptAccountSelection(msg.chat.id, "Select account for Full Checkout:", "full-checkout --confirm-place-order"); });
bot.onText(/\/checkout/, (msg) => { promptAccountSelection(msg.chat.id, "Select account for Normal Checkout:", "checkout --confirm-place-order"); });
bot.onText(/\/browser_checkout/, (msg) => { promptAccountSelection(msg.chat.id, "Select account for Browser Checkout:", "checkout-browser --confirm-place-order"); });
bot.onText(/\/login/, (msg) => { promptAccountSelection(msg.chat.id, "Select account for Login:", "login"); });

bot.onText(/\/switch_user/, async (msg) => {
  const chatId = msg.chat.id;
  const users = await db.getAllUsers();

  if (users.length === 0) {
    bot.sendMessage(chatId, "❌ No users found in the database. Use `node add_user.js` to add one.", removeKeyboard);
    return;
  }

  let messageText = "👥 Select User Context to switch to:\n\n";
  const keyboard = [];

  users.forEach((u) => {
    const isCurrent = getUserIdForChat(chatId) === u.id ? " (Current)" : "";
    messageText += `• ID ${u.id}: ${u.email}${isCurrent}\n`;
    keyboard.push([{ text: `${u.email}${isCurrent}`, callback_data: `switch_to_user_${u.id}` }]);
  });

  bot.sendMessage(chatId, messageText, {
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.onText(/\/set_affiliate(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const tag = match[1];

  if (!tag) {
    if (!userState[chatId]) userState[chatId] = { step: null };
    userState[chatId].step = 'set_affiliate';
    bot.sendMessage(chatId, "Please send your affiliate tag (e.g., earnkaro09e_1192-21) or your full affiliate link:");
    return;
  }

  let extractedTag = tag.trim();
  const tagMatch = extractedTag.match(/tag=([^&\s]+)/);
  if (tagMatch) extractedTag = tagMatch[1];

  let settings = {};
  if (fs.existsSync("settings.json")) {
    try { settings = JSON.parse(fs.readFileSync("settings.json", "utf8")); } catch (e) { }
  }
  settings.affiliateTag = extractedTag;
  fs.writeFileSync("settings.json", JSON.stringify(settings, null, 2));
  bot.sendMessage(chatId, `✅ Affiliate tag successfully set to: ${extractedTag}`, removeKeyboard);
});

bot.onText(/\/add_products/, (msg) => {
  const chatId = msg.chat.id;
  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].step = 'add_products';
  let existingCount = 0;
  if (fs.existsSync('cart_input.json')) {
    try {
      const cartInput = JSON.parse(fs.readFileSync('cart_input.json', 'utf8'));
      if (cartInput.products) existingCount = cartInput.products.length;
      else if (cartInput.asin) existingCount = 1;
    } catch (e) { }
  }
  const existingMsg = existingCount > 0 ? `\n📝 You already have ${existingCount} product(s). New ones will be ADDED to the list.\n` : '';
  bot.sendMessage(chatId,
    "📦 Send me products to add (one per line):\n" + existingMsg + "\n" +
    "Format: ASIN_or_URL  Quantity\n\n" +
    "Example:\n" +
    "B006LXBSYM 5\n" +
    "https://amazon.in/dp/B08XYZ123 2\n" +
    "B01ABC456\n\n" +
    "(If no quantity given, default is 1)",
    { reply_markup: { remove_keyboard: true } }
  );
});

bot.onText(/\/view_products/, (msg) => {
  const chatId = msg.chat.id;
  if (!fs.existsSync('cart_input.json')) {
    bot.sendMessage(chatId, '❌ No products set. Use /add_products to add them.', removeKeyboard);
    return;
  }
  const cartInput = JSON.parse(fs.readFileSync('cart_input.json', 'utf8'));
  let products = [];
  if (cartInput.products && Array.isArray(cartInput.products)) {
    products = cartInput.products;
  } else if (cartInput.asin) {
    products = [{ asin: cartInput.asin, quantity: cartInput.quantity || 1 }];
  }
  if (products.length === 0) {
    bot.sendMessage(chatId, '❌ No products found. Use /add_products to add them.', removeKeyboard);
    return;
  }
  let msg2 = `📦 Current Products (${products.length}):\n\n`;
  products.forEach((p, i) => {
    msg2 += `${i + 1}. ${p.asin} (Qty: ${p.quantity})\n`;
  });
  msg2 += '\nUse /remove_product to delete one, or /clear_products to remove all.';
  bot.sendMessage(chatId, msg2, removeKeyboard);
});

bot.onText(/\/remove_product/, (msg) => {
  const chatId = msg.chat.id;
  if (!fs.existsSync('cart_input.json')) {
    bot.sendMessage(chatId, '❌ No products to remove.', removeKeyboard);
    return;
  }
  const cartInput = JSON.parse(fs.readFileSync('cart_input.json', 'utf8'));
  let products = [];
  if (cartInput.products && Array.isArray(cartInput.products)) products = cartInput.products;
  else if (cartInput.asin) products = [{ asin: cartInput.asin, quantity: cartInput.quantity || 1 }];
  if (products.length === 0) {
    bot.sendMessage(chatId, '❌ No products to remove.', removeKeyboard);
    return;
  }
  let msg2 = 'Which product to remove? Send the number:\n\n';
  products.forEach((p, i) => {
    msg2 += `${i + 1}. ${p.asin} (Qty: ${p.quantity})\n`;
  });
  if (!userState[chatId]) userState[chatId] = { step: null };
  userState[chatId].step = 'remove_product';
  bot.sendMessage(chatId, msg2);
});

bot.onText(/\/clear_products/, (msg) => {
  const chatId = msg.chat.id;
  fs.writeFileSync('cart_input.json', JSON.stringify({ products: [] }, null, 2));
  bot.sendMessage(chatId, '🗑️ All products cleared!', removeKeyboard);
});

bot.onText(/\/stop/, (msg) => {
  handleStopAutomation(msg.chat.id);
});

(async () => {
  try {
    await db.initDB();
    const user = await db.getUser(botUserId);
    if (user) {
      console.log(`🤖 Bot is running for User: ${user.email} (ID: ${botUserId})`);
    } else {
      console.log(`🤖 Bot is running... (ID: ${botUserId} - User details not found yet in DB)`);
    }
  } catch (err) {
    console.error("❌ Fatal: Database connection could not be established on startup:", err.message);
    console.error("Please ensure that your database is running, the host/port in db_config.json are correct, and your IP is whitelisted.");
  }
})();
