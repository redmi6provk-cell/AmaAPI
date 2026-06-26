const fs = require('fs');
const path = require('path');
const db = require('./src/db');

async function main() {
  const usersJsonPath = path.join(__dirname, 'db_export', 'users.json');
  const accountsJsonPath = path.join(__dirname, 'db_export', 'accounts.json');
  const catTxtPath = path.join(__dirname, 'change', 'cat.txt');

  console.log('🔄 Starting update process...');

  // 1. Read User 1 config from JSON
  if (!fs.existsSync(usersJsonPath)) {
    console.error(`❌ Error: ${usersJsonPath} does not exist.`);
    process.exit(1);
  }

  const users = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
  const user1 = users.find(u => u.id === 1);
  if (!user1) {
    console.error('❌ Error: User 1 not found in users.json');
    process.exit(1);
  }

  console.log(`👤 User 1 details loaded: email=${user1.email}, imap_user=${user1.imap_user}`);

  // 2. Check if database is reachable (with a quick check)
  let isDbReachable = false;
  try {
    const client = await db.pool.connect();
    client.release();
    isDbReachable = true;
    console.log('📡 Database is REACHABLE.');
  } catch (err) {
    console.warn(`📡 Database is NOT reachable (${err.message}). Using local JSON mode only.`);
  }

  if (isDbReachable) {
    try {
      await db.initDB();
      console.log('Updating user 1 in database...');
      await db.pool.query(
        `INSERT INTO users (id, email, imap_host, imap_port, imap_secure, imap_user, imap_password, amazon_password)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           imap_host = EXCLUDED.imap_host,
           imap_port = EXCLUDED.imap_port,
           imap_secure = EXCLUDED.imap_secure,
           imap_user = EXCLUDED.imap_user,
           imap_password = EXCLUDED.imap_password,
           amazon_password = EXCLUDED.amazon_password`,
        [
          user1.id,
          user1.email,
          user1.imap_host,
          user1.imap_port,
          user1.imap_secure,
          user1.imap_user,
          user1.imap_password,
          user1.amazon_password
        ]
      );
      console.log('✅ Updated User 1 in database.');
    } catch (err) {
      console.warn(`⚠️ Could not update User 1 in database: ${err.message}`);
    }
  }

  // 3. Read and parse change/cat.txt
  if (!fs.existsSync(catTxtPath)) {
    console.error(`❌ Error: ${catTxtPath} does not exist.`);
    process.exit(1);
  }

  const content = fs.readFileSync(catTxtPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const newEmails = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    // Convert gmail.com to kanuvk.com
    const converted = trimmed.replace(/@gmail\.com$/i, '@kanuvk.com');
    if (converted.includes('@')) {
      newEmails.push(converted);
    }
  }

  console.log(`📖 Parsed ${newEmails.length} emails from cat.txt (converted to @kanuvk.com)`);

  // 4. Read db_export/accounts.json
  if (!fs.existsSync(accountsJsonPath)) {
    console.error(`❌ Error: ${accountsJsonPath} does not exist.`);
    process.exit(1);
  }

  const accounts = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
  
  // Count current User 1 accounts
  const initialUser1Count = accounts.filter(a => a.user_id === 1).length;
  console.log(`📊 User 1 currently has ${initialUser1Count} accounts in accounts.json`);

  // Find max ID to assign new ones
  let maxId = 0;
  for (const acc of accounts) {
    if (acc.id > maxId) {
      maxId = acc.id;
    }
  }
  console.log(`🔍 Highest account ID currently is: ${maxId}`);

  // 5. Append new accounts if they don't already exist
  let addedCount = 0;
  for (const email of newEmails) {
    const exists = accounts.some(a => a.user_id === 1 && a.email && a.email.toLowerCase() === email.toLowerCase());
    if (!exists) {
      maxId++;
      accounts.push({
        id: maxId,
        user_id: 1,
        email: email,
        cookies: null,
        updated_at: new Date().toISOString()
      });

      // Try database insertion only if DB is reachable
      if (isDbReachable) {
        try {
          await db.addAccount(1, email);
        } catch (dbErr) {
          // Ignored
        }
      }

      addedCount++;
    }
  }

  // 6. Write back to local accounts.json
  if (addedCount > 0) {
    fs.writeFileSync(accountsJsonPath, JSON.stringify(accounts, null, 2), 'utf8');
    console.log(`💾 Saved updated accounts.json.`);
  }

  const finalUser1Count = accounts.filter(a => a.user_id === 1).length;
  console.log(`\n🏁 Done!`);
  console.log(`➕ Added ${addedCount} new accounts for User 1.`);
  console.log(`📊 User 1 now has ${finalUser1Count} accounts total in accounts.json (initial: ${initialUser1Count}).`);

  // Close database pool to let process exit cleanly
  if (db.pool) {
    await db.pool.end();
  }
}

main().catch(async (err) => {
  console.error("Fatal error:", err);
  if (db.pool) {
    await db.pool.end();
  }
});
