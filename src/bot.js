const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');

// Parse user-id argument (defaults to 1)
const processArgs = process.argv.slice(2);
const userArgIndex = processArgs.indexOf("--user-id");
let botUserId = 1;
if (userArgIndex !== -1 && userArgIndex + 1 < processArgs.length) {
  botUserId = parseInt(processArgs[userArgIndex + 1], 10);
}

// Replace with your bot token
// const token = '8940148847:AAErIaZ-zDna43RAfVt2uatyJaqmsx-sNZY';
const token = '8592538979:AAHI4yN9LR8PA4OHopgDXZTOLIYFowm1rU4';
const bot = new TelegramBot(token, { polling: true });

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

bot.setMyCommands([
  { command: '/start', description: 'Start the bot' },
  { command: '/switch_user', description: '👥 Switch active user context' },
  // Cart Operations
  { command: '/cart_list', description: '🛒 List items in cart' },
  { command: '/cart_add', description: '🛒 Add item to cart' },
  { command: '/cart_delete', description: '🛒 Delete item from cart' },
  // Address Operations
  { command: '/address_list', description: '📍 List saved addresses' },
  { command: '/address_add', description: '📍 Add new address' },
  { command: '/address_delete', description: '📍 Delete address' },
  // Order / Checkout
  { command: '/full_checkout', description: '🚀 Full Checkout (Cart+Address+Order)' },
  { command: '/checkout', description: '💳 Normal API Checkout' },
  { command: '/browser_checkout', description: '🌐 Browser Checkout' },
  // Login
  { command: '/login', description: '🔑 Login to Amazon' },
  // Accounts lists (Option 3 tables)
  { command: '/active_list', description: '✉️ View accounts (active)' },
  { command: '/success_list', description: '🎉 View success_accounts' },
  { command: '/no_cod_list', description: '🛑 View no_cod_accounts' },
  { command: '/past_order_list', description: '⚠️ View past_order' },
  { command: '/delivery_issue_list', description: '📍 View delivery_issue' },
  { command: '/purchase_limit_list', description: '📦 View purchase_limit' },
  { command: '/add_account', description: '✉️ Add Amazon account' },
  { command: '/move_account', description: '🔄 Move account between tables' },
  // Settings
  { command: '/add_products', description: '📦 Add products (keeps existing)' },
  { command: '/view_products', description: '📦 View current products' },
  { command: '/remove_product', description: '📦 Remove a product' },
  { command: '/clear_products', description: '📦 Clear all products' },
  { command: '/set_affiliate', description: '🏷️ Set affiliate tag' }
]);

// Initialize DB

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = { step: null };
  const currentUserId = getUserIdForChat(chatId);
  const user = await db.getUser(currentUserId);
  const userText = user ? `${user.email} (ID: ${currentUserId})` : `ID ${currentUserId}`;
  
  bot.sendMessage(chatId, 
`👋 Welcome to the Amazon Bot!\n\nYour current user context is: *${userText}*\n\nUse the menu icon to access commands.`, { parse_mode: 'Markdown', ...removeKeyboard }
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
  } catch(e) {}
  
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
            }).catch(() => {});
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

      async function runWorker(email) {
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

        child.stdout.on("data", (data) => {
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
        while (queue.length > 0 || activePromises.length > 0) {
          while (activePromises.length < maxConcurrency && queue.length > 0) {
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
        bot.sendMessage(chatId, `🏁 Parallel execution finished for ${selectedEmails.length} account(s)!`, removeKeyboard);
      })();

    } else {
      bot.sendMessage(chatId, `🤖 Processing: ${scriptName} for ${selectedEmails.length} account(s)...`);

      // Sequential execution function
      async function runSequentially(index) {
        if (index >= selectedEmails.length) {
          bot.sendMessage(chatId, "What would you like to do next?", removeKeyboard);
          return;
        }

        const email = selectedEmails[index];
        const finalArgs = [...args];
        if (email) {
          finalArgs.push("--email", email);
        }

        const commandStr = `node ${scriptName} ${finalArgs.map(a => a.includes(" ") ? `"${a}"` : a).join(" ")}`;
        bot.sendMessage(chatId, `⏳ [Account ${index + 1}/${selectedEmails.length}] Executing: ${commandStr}... Please wait.`);
        
        console.log(`\n======================================================`);
        console.log(`🚀 Starting command from Telegram: ${commandStr}`);
        console.log(`======================================================\n`);
        
        const child = spawn("node", [path.join(__dirname, scriptName), ...finalArgs], { shell: false });
        let fullOutput = "";

        child.stdout.on('data', (data) => {
          process.stdout.write(data);
          fullOutput += data.toString();
        });

        child.stderr.on('data', (data) => {
          process.stderr.write(data);
          fullOutput += data.toString();
        });

        child.on('close', async (code) => {
          console.log(`\n✅ Command finished with exit code ${code}.`);
          
          const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
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
          } catch (e) {}

          if (fullOutput.length > 4000) {
            fullOutput = fullOutput.substring(fullOutput.length - 4000);
            bot.sendMessage(chatId, `[Account ${index + 1}/${selectedEmails.length}] (Output truncated...)\n${fullOutput}`);
          } else {
            bot.sendMessage(chatId, `[Account ${index + 1}/${selectedEmails.length}] ${fullOutput || "Command finished with no output."}`);
          }

          // Move successful checkout to success_accounts table
          if ((scriptName === "pay_on_delivery.js" || scriptName === "pipeline.js") && code === 0 && tableName !== 'success_accounts') {
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
            await new Promise(r => setTimeout(r, 5000));
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
  if (page > 1) navRow.push({ text: "⬅️ Prev", callback_data: `page_acc_${page-1}` });
  if (page < totalPages) navRow.push({ text: "Next ➡️", callback_data: `page_acc_${page+1}` });
  if (navRow.length > 0) keyboard.push(navRow);
  
  bot.sendMessage(chatId, text, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  bot.answerCallbackQuery(query.id).catch((err) => {
    console.warn(`⚠️ Telegram Warning: Failed to answer callback query: ${err.message}`);
  });
  
  if (!userState[chatId]) userState[chatId] = { step: null };

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
  if (!text || text.startsWith('/')) return;
  
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
      try { settings = JSON.parse(fs.readFileSync("settings.json", "utf8")); } catch(e) {}
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
      const asin = parts[0];
      const quantity = parseInt(parts[1], 10) || 1;
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
      } catch(e) {}
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
      } catch(e) {}
    }
    if (idx < 0 || idx >= products.length) {
      bot.sendMessage(chatId, `❌ Invalid number. You have ${products.length} products. Send a number between 1-${products.length}.`, removeKeyboard);
      return;
    }
    const removed = products.splice(idx, 1)[0];
    fs.writeFileSync('cart_input.json', JSON.stringify({ products }, null, 2));
    bot.sendMessage(chatId, `🗑️ Removed: ${removed.asin} (Qty: ${removed.quantity})\nRemaining: ${products.length} product(s)`, removeKeyboard);
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

    let text = `📋 *Table: ${tableName}* (Total: ${accounts.length}):\n\n`;
    accounts.forEach((acc, idx) => {
      const addedDate = acc.added_at ? new Date(acc.added_at).toLocaleString() : 'N/A';
      text += `[${idx + 1}] *${acc.email}*\n`;
      if (acc.order_id) text += `   Order ID: \`${acc.order_id}\`\n`;
      if (acc.reason_text) text += `   Reason: _${acc.reason_text}_\n`;
      if (acc.added_at) text += `   Moved: _${addedDate}_\n`;
      text += `\n`;
    });

    if (text.length > 4000) {
      text = text.substring(0, 4000) + "\n...(truncated)...";
    }
    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...removeKeyboard });
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

bot.onText(/\/success_list/, (msg) => {
  sendTableAccountsList(msg.chat.id, 'success_accounts');
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
    try { settings = JSON.parse(fs.readFileSync("settings.json", "utf8")); } catch(e) {}
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
    } catch(e) {}
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
