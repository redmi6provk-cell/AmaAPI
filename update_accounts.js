const fs = require('fs');
const path = require('path');
const db = require('./src/db');

async function main() {
  const usersJsonPath = path.join(__dirname, 'db_export', 'users.json');
  const accountsJsonPath = path.join(__dirname, 'db_export', 'accounts.json');
  const catTxtPath = path.join(__dirname, 'change', 'cat.txt');

  console.log('🔄 Starting update process...');

  // 1. Check if database is reachable (with a quick check)
  let isDbReachable = false;
  try {
    const client = await db.pool.connect();
    client.release();
    isDbReachable = true;
    console.log('📡 Database is REACHABLE.');
  } catch (err) {
    console.warn(`📡 Database is NOT reachable (${err.message}). Using local JSON mode only.`);
  }

  // 2. Load User 1 Details
  let user1 = null;
  if (isDbReachable) {
    try {
      await db.initDB();
      user1 = await db.getUser(1);
      if (user1) {
        console.log(`👤 User 1 details loaded from Database: email=${user1.email}`);
      }
    } catch (err) {
      console.warn(`⚠️ Failed to load User 1 from database: ${err.message}`);
    }
  }

  // Fallback to users.json if DB failed or user not found
  if (!user1) {
    if (!fs.existsSync(usersJsonPath)) {
      console.error(`❌ Error: ${usersJsonPath} does not exist, and database is not reachable.`);
      process.exit(1);
    }
    try {
      const users = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
      const u1 = users.find(u => u.id === 1);
      if (!u1) {
        console.error('❌ Error: User 1 not found in users.json');
        process.exit(1);
      }
      user1 = {
        id: u1.id,
        email: u1.email,
        imap_user: u1.imap_user,
        amazon_password: u1.amazon_password
      };
      console.log(`👤 User 1 details loaded from users.json fallback: email=${user1.email}`);

      // Upsert to DB since we have the JSON
      if (isDbReachable) {
        try {
          console.log('Updating user 1 in database from JSON...');
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
              u1.id,
              u1.email,
              u1.imap_host,
              u1.imap_port,
              u1.imap_secure,
              u1.imap_user,
              u1.imap_password,
              u1.amazon_password
            ]
          );
          console.log('✅ Synchronized User 1 configuration to database.');
        } catch (dbErr) {
          console.warn(`⚠️ Could not update User 1 in database: ${dbErr.message}`);
        }
      }
    } catch (e) {
      console.error("Error reading users.json:", e.message);
      process.exit(1);
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
    // Convert gmail.com to kanuvk.com (removing + sign to match change_amazon_email.js)
    const converted = trimmed.replace(/\+/, "").replace(/@gmail\.com$/i, '@kanuvk.com');
    if (converted.includes('@')) {
      newEmails.push(converted);
    }
  }

  console.log(`📖 Parsed ${newEmails.length} emails from cat.txt (converted to @kanuvk.com)`);

  // 4. Load existing accounts and add new ones
  let addedCount = 0;

  if (isDbReachable) {
    // Database mode (Primary)
    try {
      const existingEmails = await db.getAccountsByUser(1);
      const existingLower = new Set(existingEmails.map(e => e.toLowerCase()));

      for (const email of newEmails) {
        if (!existingLower.has(email.toLowerCase())) {
          try {
            await db.addAccount(1, email);
            addedCount++;
          } catch (dbErr) {
            console.error(`❌ Database insert failed for ${email}:`, dbErr.message);
          }
        }
      }
      console.log(`➕ Added ${addedCount} new accounts directly to VPS Database.`);

      // Optional: Sync back to local JSON if it exists
      if (fs.existsSync(accountsJsonPath)) {
        try {
          const accounts = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
          let maxId = 0;
          for (const acc of accounts) {
            if (acc.id > maxId) maxId = acc.id;
          }
          let jsonAdded = 0;
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
              jsonAdded++;
            }
          }
          if (jsonAdded > 0) {
            fs.writeFileSync(accountsJsonPath, JSON.stringify(accounts, null, 2), 'utf8');
            console.log(`💾 Synced and saved ${jsonAdded} new accounts to local accounts.json.`);
          }
        } catch (_) {}
      }
    } catch (err) {
      console.error("❌ Database sync error:", err.message);
    }
  } else {
    // Pure Local JSON Mode (Fallback)
    if (!fs.existsSync(accountsJsonPath)) {
      console.error(`❌ Error: ${accountsJsonPath} does not exist and database is not reachable.`);
      process.exit(1);
    }

    const accounts = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
    const initialUser1Count = accounts.filter(a => a.user_id === 1).length;
    console.log(`📊 User 1 currently has ${initialUser1Count} accounts in accounts.json`);

    let maxId = 0;
    for (const acc of accounts) {
      if (acc.id > maxId) maxId = acc.id;
    }

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
        addedCount++;
      }
    }

    if (addedCount > 0) {
      fs.writeFileSync(accountsJsonPath, JSON.stringify(accounts, null, 2), 'utf8');
      console.log(`💾 Saved ${addedCount} new accounts to local accounts.json.`);
    }
  }

  console.log(`\n🏁 Done! Process finished.`);

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
