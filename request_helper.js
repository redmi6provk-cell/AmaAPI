const { Impit } = require("impit");
const { spawn } = require("child_process");
const cookiesHelper = require("./cookies");

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

const impit = new Impit({
  browser: "chrome"
});

function refreshCookiesForEmail(email) {
  return new Promise((resolve, reject) => {
    console.log(`\n🔑 [${email}] Spawning get_cookies.js to automatically refresh session...`);
    const args = ["get_cookies.js", "--email", email, "--headless"];
    
    // Propagate --user-id if present in parent process arguments
    const processArgs = process.argv;
    const userIdx = processArgs.indexOf("--user-id");
    if (userIdx !== -1 && userIdx + 1 < processArgs.length) {
      args.push("--user-id", processArgs[userIdx + 1]);
    }

    const child = spawn("node", args, { shell: true });
    let output = "";
    
    child.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;
      text.split("\n").forEach(line => {
        if (line.trim()) {
          console.log(`[${email}] [Auto-Login] ${line}`);
        }
      });
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      output += text;
      text.split("\n").forEach(line => {
        if (line.trim()) {
          console.error(`[${email}] [Auto-Login] ⚠️ ${line}`);
        }
      });
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Cookie refresh process failed with code ${code}.`));
      }
    });
  });
}

async function sendAuthorizedRequest(axiosConfig, email, redirectCount = 0, hasRefreshed = false) {
  if (redirectCount > 10) {
    throw new Error("Too many redirects (max 10 allowed)");
  }

  if (!email) {
    email = cookiesHelper.getActiveEmail();
  }
  if (!email) {
    throw new Error("No active email specified or configured in credentials.json.");
  }

  const cookieString = await cookiesHelper.getCookieString(email);
  if (!axiosConfig.headers) axiosConfig.headers = {};
  axiosConfig.headers["Cookie"] = cookieString;
  axiosConfig.headers["User-Agent"] = USER_AGENT;
  
  // Set browser-like headers to bypass robot detection
  axiosConfig.headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";
  axiosConfig.headers["sec-ch-ua"] = '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"';
  axiosConfig.headers["sec-ch-ua-mobile"] = "?0";
  axiosConfig.headers["sec-ch-ua-platform"] = '"Windows"';
  axiosConfig.headers["sec-fetch-dest"] = "document";
  axiosConfig.headers["sec-fetch-mode"] = "navigate";
  axiosConfig.headers["sec-fetch-site"] = "same-origin";
  axiosConfig.headers["sec-fetch-user"] = "?1";
  axiosConfig.headers["upgrade-insecure-requests"] = "1";
  axiosConfig.headers["accept-language"] = "en-US,en;q=0.9";

  const originalMaxRedirects = axiosConfig.maxRedirects;
  
  // Map Axios options to fetch options
  const method = (axiosConfig.method || "GET").toUpperCase();
  const fetchOptions = {
    method,
    headers: axiosConfig.headers,
    redirect: "manual"
  };

  if (method !== "GET" && method !== "HEAD" && axiosConfig.data !== undefined) {
    fetchOptions.body = axiosConfig.data;
  }

  let res;
  let responseText = "";
  try {
    res = await impit.fetch(axiosConfig.url, fetchOptions);
    
    // Construct headers object (lowercased keys, like Axios/Node http)
    const headersObj = {};
    for (const [key, value] of res.headers.entries()) {
      headersObj[key.toLowerCase()] = value;
    }
    
    // Extract set-cookie array
    if (res.headers.getSetCookie) {
      const setCookies = res.headers.getSetCookie();
      if (setCookies && setCookies.length > 0) {
        headersObj["set-cookie"] = setCookies;
      }
    }
    
    responseText = await res.text();
    
    // Save/update cookies in database
    await cookiesHelper.updateCookiesFromHeaders(email, headersObj);

    // Mock response object
    const requestUrl = new URL(axiosConfig.url);
    const response = {
      status: res.status,
      statusText: res.statusText || "",
      headers: headersObj,
      data: responseText,
      config: axiosConfig,
      request: {
        res: {
          responseUrl: res.url || axiosConfig.url
        },
        path: requestUrl.pathname + requestUrl.search
      }
    };

    // Handle redirects manually to preserve cookies
    const statusCode = response.status;
    if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
      let redirectUrl = response.headers.location;
      let origin = "https://www.amazon.in";
      try {
        if (axiosConfig.url && axiosConfig.url.startsWith("http")) {
          origin = new URL(axiosConfig.url).origin;
        }
      } catch (e) {}
      
      if (redirectUrl.startsWith("/")) {
        redirectUrl = `${origin}${redirectUrl}`;
      }
      
      console.log(`[Redirect ${redirectCount + 1}] ${statusCode} -> ${redirectUrl}`);
      
      const nextConfig = {
        ...axiosConfig,
        url: redirectUrl,
        method: "GET", // Redirection standard behavior
        maxRedirects: originalMaxRedirects
      };
      
      delete nextConfig.data;
      if (nextConfig.headers) {
        delete nextConfig.headers["Content-Type"];
        delete nextConfig.headers["content-type"];
        nextConfig.headers["Referer"] = axiosConfig.url;
      }
      
      return sendAuthorizedRequest(nextConfig, email, redirectCount + 1, hasRefreshed);
    }

    // Check if redirect points to Amazon signin page
    const finalUrl = response.headers.location || response.request?.res?.responseUrl || response.request?.path || "";
    const isSignInRedirect = finalUrl.includes('/ap/signin') || 
                             (finalUrl.includes('/ap/') && !finalUrl.includes('/a/addresses')) ||
                             responseText.includes('name="signIn"');

    if (isSignInRedirect) {
      if (!hasRefreshed) {
        console.warn(`\n⚠️ [${email}] Session expired/unauthorized. Attempting auto-login refresh...`);
        try {
          await refreshCookiesForEmail(email);
          console.log(`✅ [${email}] Cookie auto-refresh successful. Retrying original request...`);
          // Retry the request after cookies are refreshed
          return sendAuthorizedRequest(axiosConfig, email, redirectCount, true);
        } catch (err) {
          console.error(`❌ [${email}] Cookie auto-refresh failed:\n`, err.message);
          throw new Error("SESSION_EXPIRED");
        }
      } else {
        console.error(`\n\x1b[31m[SESSION EXPIRED/UNAUTHORIZED] Cookies for ${email} are invalid or expired.\x1b[0m`);
        console.error(`\x1b[33mPlease refresh your session cookies manually: node get_cookies.js --email ${email}\x1b[0m\n`);
        throw new Error("SESSION_EXPIRED");
      }
    }

    // Validate status code if validateStatus function is provided
    const validateStatus = axiosConfig.validateStatus || (s => s >= 200 && s < 300);
    if (!validateStatus(statusCode)) {
      throw new Error(`Request failed with status code ${statusCode}`);
    }

    return response;

  } catch (error) {
    if (error.message === "SESSION_EXPIRED") {
      throw error;
    }
    console.error("HTTP Request failed:", error.message);
    throw error;
  }
}

module.exports = {
  sendAuthorizedRequest,
  USER_AGENT
};
