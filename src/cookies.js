const fs = require("fs");
const path = require("path");

const COOKIES_FILE = path.join(__dirname, "..", "data", "a.json");

let db = null;
let useDb = false;

if (fs.existsSync(path.join(__dirname, "..", "config", "db_config.json"))) {
  try {
    db = require("./db");
    useDb = true;
  } catch (e) {
    console.warn("⚠️ Database module failed to load, falling back to local file:", e.message);
  }
}

function getActiveUserId() {
  const args = process.argv;
  const userIdx = args.indexOf("--user-id");
  if (userIdx !== -1 && userIdx + 1 < args.length) {
    return parseInt(args[userIdx + 1], 10);
  }
  return 1;
}

function loadAllCookies() {
  if (!fs.existsSync(COOKIES_FILE)) {
    return {};
  }
  try {
    const data = fs.readFileSync(COOKIES_FILE, "utf8");
    const json = JSON.parse(data);
    if (Array.isArray(json)) {
      const activeEmail = getActiveEmail();
      if (activeEmail) {
        return { [activeEmail]: json };
      }
      return {};
    }
    return json;
  } catch (e) {
    console.error("Error parsing a.json:", e.message);
    return {};
  }
}

function getActiveEmail(overrideEmail = null) {
  if (overrideEmail) return overrideEmail;
  
  // Try command line override
  const args = process.argv;
  const emailIdx = args.indexOf("--email");
  if (emailIdx !== -1 && emailIdx + 1 < args.length) {
    return args[emailIdx + 1];
  }
  
  if (fs.existsSync(path.join(__dirname, "..", "config", "credentials.json"))) {
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "credentials.json"), "utf8"));
      if (creds.email && creds.email !== "your_email@example.com") {
        return creds.email;
      }
    } catch (e) {}
  }
  return null;
}

async function readCookies(email) {
  if (useDb && db) {
    try {
      const userId = getActiveUserId();
      const dbCookies = await db.getCookies(userId, email);
      if (dbCookies && dbCookies.length > 0) {
        return dbCookies;
      }
      
      // Fallback: search by email across ALL 6 tables and any user ID
      const emailResult = await db.pool.query(
        `SELECT cookies, updated_at FROM (
           SELECT cookies, updated_at FROM accounts WHERE email = $1
           UNION ALL
           SELECT cookies, updated_at FROM no_cod_accounts WHERE email = $1
           UNION ALL
           SELECT cookies, updated_at FROM success_accounts WHERE email = $1
           UNION ALL
           SELECT cookies, updated_at FROM past_order WHERE email = $1
           UNION ALL
           SELECT cookies, updated_at FROM delivery_issue WHERE email = $1
           UNION ALL
           SELECT cookies, updated_at FROM purchase_limit WHERE email = $1
         ) AS all_cookies
         WHERE cookies IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`,
        [email]
      );
      if (emailResult.rows.length > 0 && emailResult.rows[0].cookies) {
        return emailResult.rows[0].cookies;
      }
    } catch (e) {
      console.warn("⚠️ Error reading cookies from database, falling back to local file:", e.message);
    }
  }

  const all = loadAllCookies();
  return all[email] || [];
}


async function saveCookies(email, cookies) {
  if (!email) return;
  if (useDb && db) {
    try {
      const userId = getActiveUserId();
      
      // Ensure the user ID exists in the users table first. 
      // If the user table is empty, we must create a default user record.
      const userCheck = await db.pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (userCheck.rows.length === 0) {
        await db.pool.query(
          `INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [userId, email]
        );
      }
      
      await db.updateCookies(userId, email, cookies);
      return;
    } catch (e) {
      console.warn("⚠️ Error saving cookies to database, falling back to local file:", e.message);
    }
  }

  const all = loadAllCookies();
  all[email] = cookies;
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(all, null, 2), "utf8");
}

async function getCookieString(email) {
  const cookies = await readCookies(email);
  return cookies.map(c => `${c.name}=${c.value}`).join("; ");
}

async function updateCookiesFromHeaders(email, headers) {
  if (!email) return;
  const setCookies = headers["set-cookie"];
  if (!setCookies) return;

  const cookies = await readCookies(email);
  const cookieMap = {};
  cookies.forEach(c => {
    cookieMap[c.name] = c;
  });

  setCookies.forEach(cookieStr => {
    const parts = cookieStr.split(";")[0].split("=");
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      if (name) {
        cookieMap[name] = {
          name,
          value,
          domain: ".amazon.in",
          path: "/"
        };
      }
    }
  });

  const updatedCookies = Object.values(cookieMap);
  await saveCookies(email, updatedCookies);
}

module.exports = {
  readCookies,
  saveCookies,
  getCookieString,
  updateCookiesFromHeaders,
  getActiveEmail,
  getActiveUserId
};
