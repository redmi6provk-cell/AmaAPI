const db = require('./src/db');
const fs = require('fs');
const path = require('path');

async function sync() {
  const usersJsonPath = path.join(__dirname, 'db_export', 'users.json');
  if (!fs.existsSync(usersJsonPath)) {
    console.error("users.json not found");
    process.exit(1);
  }

  try {
    const users = JSON.parse(fs.readFileSync(usersJsonPath, 'utf8'));
    const u1 = users.find(u => u.id === 1);
    if (!u1) {
      console.error("User 1 not found in users.json");
      process.exit(1);
    }

    console.log("Connecting to DB and forcing User 1 update...");
    await db.initDB();
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
    console.log("✅ Successfully updated User 1 in database!");
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    if (db.pool) {
      await db.pool.end();
    }
  }
}

sync();
