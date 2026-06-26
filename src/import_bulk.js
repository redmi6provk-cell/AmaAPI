const fs = require('fs');
const path = require('path');
const db = require('./db');

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    userId: 1,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help':
      case '-h':
        config.help = true;
        break;
      case '--user-id':
        config.userId = parseInt(args[++i], 10) || 1;
        break;
    }
  }
  return config;
}

async function main() {
  const config = parseArgs();

  if (config.help) {
    console.log(`
Usage:
  node src/import_bulk.js [options]

Options:
  --user-id <id>     Assign emails to Profile ID (1 or 2) [default: 1]
  --help, -h         Show help message
`);
    process.exit(0);
  }

  const configDir = path.join(__dirname, '..', 'config');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const emailsFile = path.join(configDir, 'bulk_emails.txt');

  if (!fs.existsSync(emailsFile)) {
    fs.writeFileSync(emailsFile, `# Add your emails here, one per line.\n# Empty lines and lines starting with '#' will be ignored.\n\nexample1@gmail.com\nexample2@gmail.com\n`, 'utf8');
    console.log(`📝 Created file at: ${emailsFile}`);
    console.log(`Please open this file, paste your list of bulk emails, and run this script again.`);
    process.exit(0);
  }

  console.log(`📖 Reading emails from: ${emailsFile}`);
  const content = fs.readFileSync(emailsFile, 'utf8');
  const lines = content.split(/\r?\n/);
  const emails = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    // Very basic email validation
    if (trimmed.includes('@')) {
      emails.push(trimmed);
    }
  }

  if (emails.length === 0) {
    console.log(`⚠️ No valid emails found in bulk_emails.txt.`);
    process.exit(0);
  }

  console.log(`🚀 Bulk importing ${emails.length} account(s) under Profile ID: ${config.userId}...`);

  let successCount = 0;
  for (const email of emails) {
    try {
      await db.addAccount(config.userId, email);
      console.log(`  ➕ Added: ${email}`);
      successCount++;
    } catch (e) {
      console.error(`  ❌ Failed for ${email}:`, e.message);
    }
  }

  console.log(`\n🏁 Done! Successfully imported ${successCount}/${emails.length} account(s).`);
  console.log(`💡 Now you can run "node src/get_cookies.js" (or launch from the terminal runner) to login these accounts!`);
  
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
