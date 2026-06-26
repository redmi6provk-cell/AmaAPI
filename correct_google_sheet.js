const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const db = require("./src/db");

const CREDENTIALS_PATH = path.join(__dirname, 'config', 'google_credentials.json');
const SETTINGS_PATH = path.join(__dirname, 'config', 'settings.json');

// Get Spreadsheet ID from settings.json
let spreadsheetId = null;
if (fs.existsSync(SETTINGS_PATH)) {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    spreadsheetId = settings.googleSpreadsheetId || null;
  } catch (e) {
    console.error("Failed to parse settings.json:", e.message);
  }
}

function getSheetsClient() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error("google_credentials.json not found.");
    return null;
  }
  if (!spreadsheetId) {
    console.error("googleSpreadsheetId not set in settings.json.");
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function main() {
  const sheets = getSheetsClient();
  if (!sheets) {
    console.error("Could not initialize Google Sheets client.");
    return;
  }

  // 1. Load session-to-order map from log analysis
  let logMap = {};
  const mapPath = path.join(__dirname, "session_to_order_map.json");
  if (fs.existsSync(mapPath)) {
    logMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
    console.log(`Loaded ${Object.keys(logMap).length} mappings from log files.`);
  } else {
    console.warn("session_to_order_map.json not found. Will proceed without it.");
  }

  // 2. Load today's Amazon emails details
  let todayEmails = [];
  const emailsPath = path.join(__dirname, "today_amazon_emails.json");
  if (fs.existsSync(emailsPath)) {
    todayEmails = JSON.parse(fs.readFileSync(emailsPath, "utf8"));
    console.log(`Loaded ${todayEmails.length} email records received today.`);
  } else {
    console.warn("today_amazon_emails.json not found. Will proceed without it.");
  }

  // 3. Load DB cancellation records
  await db.initDB();
  const dbCancellations = {};
  const tables = ['past_order', 'delivery_issue', 'purchase_limit'];
  for (const tbl of tables) {
    try {
      const res = await db.pool.query(`SELECT email, order_id, reason_text FROM ${tbl}`);
      for (const row of res.rows) {
        dbCancellations[row.email.toLowerCase().trim()] = {
          table: tbl,
          orderId: row.order_id,
          reason: row.reason_text
        };
      }
    } catch (e) {
      console.error(`Error fetching from DB table ${tbl}:`, e.message);
    }
  }
  console.log(`Loaded ${Object.keys(dbCancellations).length} cancellation records from PostgreSQL.`);

  // 4. Fetch Google Sheet values
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Sheet1!A:H',
  });
  const rows = response.data.values || [];
  if (rows.length === 0) {
    console.log("Google Sheet is empty.");
    return;
  }
  console.log(`Fetched ${rows.length} rows from Google Sheet.`);

  let modifiedCount = 0;

  // 5. Update rows in memory
  // A=Timestamp, B=Email, C=Status, D=Order ID, E=Total Amount, F=ASIN, G=Reason, H=IP
  for (let i = 1; i < rows.length; i++) { // Skip header row
    const row = rows[i];
    const email = row[1] ? row[1].trim().toLowerCase() : '';
    const status = row[2] ? row[2].trim() : '';
    const orderId = row[3] ? row[3].trim() : '';
    
    let updatedOrderId = orderId;
    let updatedStatus = status;
    let updatedReason = row[6] || '';
    let isModified = false;

    // A. Check if the orderId is actually a sessionID from logs
    if (logMap[orderId]) {
      const correctId = logMap[orderId].correctOrderId;
      console.log(`[Row ${i+1}] Correcting Session ID ${orderId} -> Order ID ${correctId} for ${email}`);
      updatedOrderId = correctId;
      isModified = true;
    }

    // B. Check if this account is in the cancellation tables in the database
    if (dbCancellations[email]) {
      const dbInfo = dbCancellations[email];
      
      // If order ID is mismatch/empty or status is not CANCELLED
      if (updatedOrderId !== dbInfo.orderId || updatedStatus !== 'CANCELLED') {
        console.log(`[Row ${i+1}] Updating to CANCELLED from DB for ${email}: Order ID ${updatedOrderId} -> ${dbInfo.orderId}`);
        updatedStatus = 'CANCELLED';
        if (dbInfo.orderId) updatedOrderId = dbInfo.orderId;
        updatedReason = dbInfo.reason || `Cancelled (${dbInfo.table})`;
        isModified = true;
      }
    } else {
      // C. Fallback: check if we received a cancellation email today for this alias
      const cancelEmail = todayEmails.find(e => 
        e.recipients.some(r => r.toLowerCase().trim() === email) && 
        /cancel/i.test(e.subject)
      );
      if (cancelEmail) {
        if (updatedStatus !== 'CANCELLED') {
          console.log(`[Row ${i+1}] Updating to CANCELLED from email for ${email}: Order ID ${updatedOrderId} -> ${cancelEmail.orderId}`);
          updatedStatus = 'CANCELLED';
          if (cancelEmail.orderId && cancelEmail.orderId !== 'UNKNOWN') {
            updatedOrderId = cancelEmail.orderId;
          }
          updatedReason = `Cancelled (IMAP Email: ${cancelEmail.subject})`;
          isModified = true;
        }
      }
    }

    if (isModified) {
      row[2] = updatedStatus;
      row[3] = updatedOrderId;
      row[6] = updatedReason;
      modifiedCount++;
    }
  }

  if (modifiedCount === 0) {
    console.log("No modifications needed in Google Sheets.");
  } else {
    console.log(`Updating ${modifiedCount} rows in Google Sheets...`);
    
    // Write back the updated values to Sheet1!A1:H
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!A1:H${rows.length}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: rows }
    });
    console.log("🎉 Google Sheets successfully updated!");
  }

  await db.pool.end();
}

main().catch(err => {
  console.error("Error in repair execution:", err);
  db.pool.end().catch(() => {});
});
