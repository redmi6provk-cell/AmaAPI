const fs = require('fs');
const path = require('path');
const db = require('./db');

const importDir = path.join(__dirname, '..', 'db_export');

async function importDatabase() {
  const args = process.argv.slice(2);
  const isAppend = args.includes('--append');

  console.log(`🚀 Starting database import from JSON (${isAppend ? 'Append mode' : 'Full Overwrite mode'})...`);
  
  if (!fs.existsSync(importDir)) {
    console.error(`❌ Error: Export directory not found at ${importDir}. Please copy the "db_export" folder here first.`);
    process.exit(1);
  }

  const client = await db.pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Import Users (with ON CONFLICT to update existing settings)
    const usersFile = path.join(importDir, 'users.json');
    if (fs.existsSync(usersFile)) {
      console.log('👥 Importing users...');
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
      for (const user of users) {
        await client.query(`
          INSERT INTO users (id, email, imap_host, imap_port, imap_secure, imap_user, imap_password, amazon_password, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            imap_host = EXCLUDED.imap_host,
            imap_port = EXCLUDED.imap_port,
            imap_secure = EXCLUDED.imap_secure,
            imap_user = EXCLUDED.imap_user,
            imap_password = EXCLUDED.imap_password,
            amazon_password = EXCLUDED.amazon_password,
            created_at = EXCLUDED.created_at
        `, [
          user.id,
          user.email,
          user.imap_host,
          user.imap_port,
          user.imap_secure,
          user.imap_user,
          user.imap_password,
          user.amazon_password,
          user.created_at
        ]);
      }
      console.log(`  -> Imported/Updated ${users.length} users.`);
    }

    // 2. Clear old tables ONLY if NOT in append mode
    if (!isAppend) {
      console.log('🧹 Clearing old account tables (Truncating)...');
      await client.query('TRUNCATE accounts, success_accounts, no_cod_accounts, past_order, delivery_issue, purchase_limit CASCADE');
    } else {
      console.log('⏭️ Skipping truncation (Append mode active). Keeping existing accounts in database.');
    }

    // 3. Import Account Tables
    const accountTables = [
      { name: 'accounts', hasAddedAt: false, hasOrder: false },
      { name: 'success_accounts', hasAddedAt: true, hasOrder: false },
      { name: 'no_cod_accounts', hasAddedAt: true, hasOrder: false },
      { name: 'past_order', hasAddedAt: true, hasOrder: true },
      { name: 'delivery_issue', hasAddedAt: true, hasOrder: true },
      { name: 'purchase_limit', hasAddedAt: true, hasOrder: true }
    ];

    for (const tbl of accountTables) {
      const filePath = path.join(importDir, `${tbl.name}.json`);
      if (!fs.existsSync(filePath)) {
        console.log(`⚠️ Skip table "${tbl.name}" (JSON file not found)`);
        continue;
      }

      console.log(`📋 Importing table "${tbl.name}"...`);
      const rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      
      for (const row of rows) {
        if (isAppend) {
          // Append mode: insert without specifying id (let sequence generate it) and ON CONFLICT DO NOTHING
          if (tbl.hasOrder) {
            await client.query(`
              INSERT INTO ${tbl.name} (user_id, email, cookies, order_id, reason_text, updated_at, added_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (user_id, email) DO NOTHING
            `, [
              row.user_id,
              row.email,
              row.cookies ? JSON.stringify(row.cookies) : null,
              row.order_id,
              row.reason_text,
              row.updated_at,
              row.added_at
            ]);
          } else if (tbl.hasAddedAt) {
            await client.query(`
              INSERT INTO ${tbl.name} (user_id, email, cookies, updated_at, added_at)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (user_id, email) DO NOTHING
            `, [
              row.user_id,
              row.email,
              row.cookies ? JSON.stringify(row.cookies) : null,
              row.updated_at,
              row.added_at
            ]);
          } else {
            await client.query(`
              INSERT INTO ${tbl.name} (user_id, email, cookies, updated_at)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (user_id, email) DO NOTHING
            `, [
              row.user_id,
              row.email,
              row.cookies ? JSON.stringify(row.cookies) : null,
              row.updated_at
            ]);
          }
        } else {
          // Full overwrite mode: keep the original file IDs and behavior
          if (tbl.hasOrder) {
            await client.query(`
              INSERT INTO ${tbl.name} (id, user_id, email, cookies, order_id, reason_text, updated_at, added_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
              row.id,
              row.user_id,
              row.email,
              row.cookies ? JSON.stringify(row.cookies) : null,
              row.order_id,
              row.reason_text,
              row.updated_at,
              row.added_at
            ]);
          } else if (tbl.hasAddedAt) {
            await client.query(`
              INSERT INTO ${tbl.name} (id, user_id, email, cookies, updated_at, added_at)
              VALUES ($1, $2, $3, $4, $5, $6)
            `, [
              row.id,
              row.user_id,
              row.email,
              row.cookies ? JSON.stringify(row.cookies) : null,
              row.updated_at,
              row.added_at
            ]);
          } else {
            await client.query(`
              INSERT INTO ${tbl.name} (id, user_id, email, cookies, updated_at)
              VALUES ($1, $2, $3, $4, $5)
            `, [
              row.id,
              row.user_id,
              row.email,
              row.cookies ? JSON.stringify(row.cookies) : null,
              row.updated_at
            ]);
          }
        }
      }
      console.log(`  -> Processed ${rows.length} rows for "${tbl.name}".`);
    }

    await client.query('COMMIT');
    console.log(`\n🎉 Database import completed successfully (${isAppend ? 'Append mode' : 'Overwrite mode'})!`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Error during import:', err.message);
  } finally {
    client.release();
    await db.pool.end();
  }
}

importDatabase();
