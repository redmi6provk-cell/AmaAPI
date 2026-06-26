const db = require("./src/db");

async function main() {
  await db.initDB();
  const tables = ['accounts', 'success_accounts', 'no_cod_accounts', 'past_order', 'delivery_issue', 'purchase_limit'];
  
  for (const tbl of tables) {
    try {
      const res = await db.pool.query(
        `SELECT email, order_id, reason_text FROM ${tbl} WHERE email ILIKE '%johnsonsmithh880%'`
      );
      if (res.rows.length > 0) {
        console.log(`\n🗄️ Table: ${tbl} (${res.rows.length} rows)`);
        res.rows.forEach(r => {
          console.log(`  Email: ${r.email} | Order ID: ${r.order_id || 'NULL'} | Reason: ${r.reason_text || 'NULL'}`);
        });
      }
    } catch (e) {
      // Some tables like accounts, success_accounts might not have order_id or reason_text column
      try {
        const res = await db.pool.query(
          `SELECT email FROM ${tbl} WHERE email ILIKE '%johnsonsmithh880%'`
        );
        if (res.rows.length > 0) {
          console.log(`\n🗄️ Table: ${tbl} (${res.rows.length} rows)`);
          res.rows.forEach(r => {
            console.log(`  Email: ${r.email}`);
          });
        }
      } catch (err) {
        console.error(`Error querying ${tbl}:`, err.message);
      }
    }
  }
  await db.pool.end();
}

main();
