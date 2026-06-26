const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CREDENTIALS_PATH = path.join(__dirname, 'config', 'google_credentials.json');
const SETTINGS_PATH = path.join(__dirname, 'config', 'settings.json');

let spreadsheetId = null;
if (fs.existsSync(SETTINGS_PATH)) {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  spreadsheetId = settings.googleSpreadsheetId;
}

async function getSheetId(sheets, sheetName = 'Sheet1') {
  try {
    const metadata = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = metadata.data.sheets.find(s => s.properties.title === sheetName);
    return sheet ? sheet.properties.sheetId : 0;
  } catch (e) {
    return 0;
  }
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const sheetId = await getSheetId(sheets, 'Sheet1');
    
    // We want to delete rows 275 to 318 (1-indexed).
    // In 0-indexed API terms: startIndex is 274, endIndex is 318.
    const requests = [{
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS',
          startIndex: 274,
          endIndex: 318
        }
      }
    }];

    console.log("📊 Deleting duplicate rows 275 to 318 from Google Sheets...");
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      resource: { requests }
    });
    console.log("✅ Successfully deleted rows 275 to 318.");
  } catch (e) {
    console.error("❌ Failed to delete rows:", e.message);
  }
}

main();
