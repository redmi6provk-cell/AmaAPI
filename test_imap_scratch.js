const { ImapFlow } = require("imapflow");
const fs = require("fs");
const path = require("path");

function decodeQuotedPrintable(text) {
  if (!text) return "";
  let result = text.replace(/=\r?\n/g, "");
  result = result.replace(/=([0-9A-F]{2})/gi, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return result;
}

async function main() {
  const usersJsonPath = path.join(__dirname, "db_export", "users.json");
  const users = JSON.parse(fs.readFileSync(usersJsonPath, "utf8"));
  const u1 = users.find(u => u.id === 1);

  const client = new ImapFlow({
    host: u1.imap_host,
    port: u1.imap_port,
    secure: u1.imap_secure,
    auth: {
      user: u1.imap_user,
      pass: u1.imap_password,
    },
    logger: false,
  });

  console.log("Connecting to IMAP...");
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const totalEmails = client.mailbox.exists;
    console.log(`Total emails in INBOX: ${totalEmails}`);
    const range = `${Math.max(1, totalEmails - 9)}:${totalEmails}`;
    
    const messages = [];
    for await (let msg of client.fetch(range, { envelope: true })) {
      messages.push(msg);
    }
    messages.reverse();

    for (const msg of messages) {
      const from = msg.envelope?.from?.[0]?.address || "";
      const subject = msg.envelope?.subject || "";
      const date = msg.envelope?.date;
      const to = msg.envelope?.to?.[0]?.address || "";
      
      console.log(`\n===================================`);
      console.log(`Date: ${date}`);
      console.log(`Subject: ${subject}`);
      console.log(`From: ${from}`);
      console.log(`To: ${to}`);
    }
  } finally {
    lock.release();
  }
  await client.logout();
  console.log("Logged out.");
}

main().catch(console.error);



