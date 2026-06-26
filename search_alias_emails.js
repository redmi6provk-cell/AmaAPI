const { ImapFlow } = require("imapflow");
const db = require("./src/db");

async function main() {
  await db.initDB();
  const user = await db.getUser(1); // User 1 (pauljohnson's domain is kanuvk.com, which is mapped to User 1)
  if (!user || !user.imapConfig) {
    console.error("User 1 IMAP config not found.");
    return;
  }

  const client = new ImapFlow({
    host: user.imapConfig.host,
    port: user.imapConfig.port || 993,
    secure: user.imapConfig.secure !== undefined ? user.imapConfig.secure : true,
    auth: {
      user: user.imapConfig.user,
      pass: user.imapConfig.password
    },
    logger: false
  });

  const targetAlias = "pauljohnson4682259@kanuvk.com";
  console.log(`🔍 Connecting to IMAP to search for emails related to: ${targetAlias}`);

  try {
    await client.connect();
    let lock = await client.getMailboxLock("INBOX");
    try {
      console.log(`Total emails in INBOX: ${client.mailbox.exists}`);
      
      // Search all emails from today containing the alias email address
      const todayDate = new Date("2026-06-24T00:00:00+05:30");
      const searchResult = await client.search({ since: todayDate });
      console.log(`Found ${searchResult.length} emails received today. Fetching and filtering...`);

      const matchedEmails = [];
      
      // Fetch only envelopes first to find recipients/subjects
      for await (let msg of client.fetch(searchResult, { envelope: true, source: true })) {
        const toHeader = msg.envelope.to?.map(t => t.address.toLowerCase()) || [];
        const ccHeader = msg.envelope.cc?.map(c => c.address.toLowerCase()) || [];
        const rawSource = msg.source ? msg.source.toString().toLowerCase() : "";
        
        const isMatchedRecipient = toHeader.includes(targetAlias.toLowerCase()) || 
                                   ccHeader.includes(targetAlias.toLowerCase()) ||
                                   rawSource.includes(targetAlias.toLowerCase());

        if (isMatchedRecipient) {
          matchedEmails.push(msg);
        }
      }

      console.log(`\nFound ${matchedEmails.length} matching emails for ${targetAlias}:`);
      matchedEmails.forEach((msg, idx) => {
        console.log(`\n[Email ${idx + 1}] Date: ${msg.envelope.date.toLocaleString('en-IN')}`);
        console.log(`    From: ${msg.envelope.from?.[0]?.address || ''}`);
        console.log(`    Subject: ${msg.envelope.subject}`);
        console.log(`    To: ${msg.envelope.to?.map(t => t.address).join(", ")}`);
        
        // Match order ID in the subject/body of this email
        const rawBody = msg.source ? msg.source.toString() : "";
        const matches = rawBody.match(/\b\d{3}-\d{7}-\d{7}\b/g) || [];
        const uniqueMatches = [...new Set(matches)];
        console.log(`    Order IDs found in this email:`, uniqueMatches);
      });

    } finally {
      lock.release();
    }
  } catch (e) {
    console.error("IMAP Error:", e.message);
  } finally {
    await client.logout();
    await db.pool.end();
  }
}

main();
