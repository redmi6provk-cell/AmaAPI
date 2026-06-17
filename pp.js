const { pool } = require('./db');

async function updateAllPasswords() {
  try {
    console.log('Connecting to database...');
    
    // Update password for all users in the users table
    const newPassword = '112233';
    const res = await pool.query('UPDATE users SET amazon_password = $1', [newPassword]);
    
    console.log(`✅ Successfully updated Amazon password to "${newPassword}" for all (${res.rowCount}) users in the 'users' table.`);
    
    // Show current state of users
    const resUsers = await pool.query('SELECT id, email, amazon_password FROM users ORDER BY id');
    console.log('\nCurrent Users in Database:');
    console.table(resUsers.rows);
    
  } catch (error) {
    console.error('❌ Error updating database:', error.message);
  } finally {
    await pool.end();
  }
}

updateAllPasswords();
