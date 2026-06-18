const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const axios = require("axios");
const puppeteer = require("puppeteer");
const { sendAuthorizedRequest } = require("./request_helper");
const cookiesHelper = require("./cookies");
const googleSheets = require("./google_sheets");

let db = null;
if (fs.existsSync(path.join(__dirname, "db_config.json"))) {
  try {
    db = require("./db");
  } catch (e) {
    console.warn("⚠️ Could not load database module in pay_on_delivery.js:", e.message);
  }
}

async function handleCodUnavailable(email, userId) {
  if (db) {
    try {
      console.log(`📝 Moving account ${email} to NO COD table in database...`);
      await db.moveAccountToNoCod(email, userId);
      console.log(`✅ Successfully moved ${email} to NO COD table.`);
    } catch (err) {
      console.error(`❌ Failed to move account to NO COD table in database:`, err.message);
    }
  } else {
    console.log(`⚠️ Database not initialized, skipping database update for NO COD.`);
  }
}

// ==================== GLOBAL SETTINGS FROM CLI ====================
let minPriceOverride = null;
let maxPriceOverride = null;
let startUrl = null;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

async function checkForCaptcha(page, isHeadless) {
  const captchaDetected = await page.evaluate(() => {
    const url = window.location.href.toLowerCase();
    
    // Check if an OTP box is active. If so, it is not a captcha.
    const otpSelectors = [
      "#input-box-otp",
      "#auth-mfa-otpcode",
      "#cvf-widget-input-code",
      "#cvf-input-code",
      "input[name='otpCode']",
      "input[name='code']",
      "input#cvf-a-input",
      "#cvf-otp-input",
      ".cvf-widget-input-code"
    ];
    for (const sel of otpSelectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        return false;
      }
    }

    if (url.includes("captcha") || url.includes("puzzle")) return true;
    if (url.includes("/cvf/")) {
      if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return true;
      if (document.querySelector("iframe[title*='verification']")) return true;
      const text = document.body ? (document.body.innerText || "") : "";
      if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
      return true;
    }
    if (document.querySelector("input[placeholder='Type characters']")) return true;
    if (document.title && document.title.toLowerCase().includes("authentication required")) return true;
    const text = document.body ? (document.body.innerText || "") : "";
    if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
    return false;
  });

  if (captchaDetected) {
    if (isHeadless) {
      throw new Error("RELAUNCH_HEADED");
    } else {
      console.log("\n    ⚠️ [!] ALERT: CAPTCHA/Puzzle/Verification Challenge Detected! Please solve it manually in the browser window.");
      console.log("    Waiting for manual captcha solution...");
      
      const startTime = Date.now();
      let stillCaptcha = true;
      while (stillCaptcha && (Date.now() - startTime < 300000)) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          stillCaptcha = await page.evaluate(() => {
            const url = window.location.href.toLowerCase();
            const otpSelectors = [
              "#input-box-otp",
              "#auth-mfa-otpcode",
              "#cvf-widget-input-code",
              "#cvf-input-code",
              "input[name='otpCode']",
              "input[name='code']",
              "input#cvf-a-input",
              "#cvf-otp-input",
              ".cvf-widget-input-code"
            ];
            for (const sel of otpSelectors) {
              const el = document.querySelector(sel);
              if (el && el.offsetParent !== null) {
                return false;
              }
            }

            if (url.includes("captcha") || url.includes("puzzle")) return true;
            if (url.includes("/cvf/")) {
              if (document.querySelector("#cvf-aamation-challenge-iframe") || document.querySelector(".cvf-aamation-iframe")) return true;
              if (document.querySelector("iframe[title*='verification']")) return true;
              const text = document.body ? (document.body.innerText || "") : "";
              if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
              return true;
            }
            if (document.querySelector("input[placeholder='Type characters']")) return true;
            const text = document.body ? (document.body.innerText || "") : "";
            if (text.includes("characters you see below") || text.includes("Solve this puzzle") || text.includes("verification puzzle")) return true;
            return false;
          });
        } catch (e) {
          stillCaptcha = false;
        }
      }
      console.log("    ✅ Captcha resolved! Continuing login/checkout flow...");
    }
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    confirm: false,
    email: null,
    minPrice: null,
    maxPrice: null,
    startUrl: null,
    headless: false,
    browser: false,
    userId: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--confirm-place-order":
      case "--confirm":
        config.confirm = true;
        break;
      case "--email":
        config.email = args[++i];
        break;
      case "--min-price":
        config.minPrice = parseFloat(args[++i]);
        break;
      case "--max-price":
        config.maxPrice = parseFloat(args[++i]);
        break;
      case "--start-url":
        config.startUrl = args[++i];
        break;
      case "--headless":
        config.headless = true;
        break;
      case "--browser":
      case "--force-browser":
        config.browser = true;
        break;
      case "--user-id":
        config.userId = parseInt(args[++i], 10) || null;
        break;
      case "--help":
      case "-h":
        config.help = true;
        break;
    }
  }
  return config;
}

// ==================== HELPERS ====================
function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseForm(html, searchStr) {
  const idx = html.toLowerCase().indexOf(searchStr.toLowerCase());
  if (idx === -1) return null;
  
  const formStart = html.lastIndexOf("<form", idx);
  if (formStart === -1) return null;
  
  const tagEnd = html.indexOf(">", formStart);
  const formTag = html.substring(formStart, tagEnd + 1);
  
  const actionMatch = formTag.match(/action=["']([^"']*)["']/i);
  const methodMatch = formTag.match(/method=["']([^"']*)["']/i);
  const action = actionMatch ? decodeHtmlEntities(actionMatch[1]) : "";
  const method = methodMatch ? methodMatch[1].toLowerCase() : "get";
  
  const formEnd = html.indexOf("</form>", formStart);
  const innerHtml = formEnd !== -1 ? html.substring(tagEnd + 1, formEnd) : html.substring(tagEnd + 1);
  
  const inputs = {};
  const inputRegex = /<input([^>]*?)>/gi;
  let m;
  while ((m = inputRegex.exec(innerHtml)) !== null) {
    const attrs = m[1];
    const nameMatch = attrs.match(/name=["']([^"']*)["']/i);
    if (nameMatch) {
      const name = nameMatch[1];
      const typeMatch = attrs.match(/type=["']([^"']*)["']/i);
      const type = typeMatch ? typeMatch[1].toLowerCase() : "text";
      
      if (type === "submit") continue;
      if ((type === "radio" || type === "checkbox") && !attrs.match(/\bchecked\b/i)) continue;
      
      const valueMatch = attrs.match(/value=["']([^"']*)["']/i);
      const value = valueMatch ? decodeHtmlEntities(valueMatch[1]) : "";
      inputs[name] = value;
    }
  }
  
  if (!inputs["anti-csrftoken-a2z"]) {
    const csrfMatch = innerHtml.match(/name=["']anti-csrftoken-a2z["']\s*value=["']([^"']*)["']/i) || 
                      html.match(/name=["']anti-csrftoken-a2z["']\s*value=["']([^"']*)["']/i);
    if (csrfMatch) inputs["anti-csrftoken-a2z"] = decodeHtmlEntities(csrfMatch[1]);
  }
  
  return { action, method, inputs };
}

function normalizeAmazonUrl(url, baseUrl = "https://www.amazon.in") {
  if (!url) return "";
  const decodedUrl = decodeHtmlEntities(String(url));
  if (decodedUrl.toLowerCase().startsWith("javascript:")) return "";
  if (decodedUrl.startsWith("http")) return decodedUrl;
  if (decodedUrl.startsWith("/")) return `${baseUrl}${decodedUrl}`;
  return decodedUrl;
}

function getResponseUrl(response, fallbackUrl = "") {
  return response.headers?.location ||
         response.request?.res?.responseUrl ||
         response.request?.path ||
         fallbackUrl;
}

async function fetchHtmlAt(url, email, referer = "") {
  const r = await sendAuthorizedRequest({
    method: "GET", url,
    headers: referer ? { Referer: referer } : {},
    maxRedirects: 10,
    validateStatus: s => s >= 200 && s < 500,
  }, email);
  const finalUrl = normalizeAmazonUrl(getResponseUrl(r, url)) || url;
  const html = typeof r.data === "string" ? r.data : JSON.stringify(r.data);
  return { currentUrl: finalUrl, pageHtml: html };
}

function getPipelineId(url) {
  const m = String(url).match(/\/checkout\/p\/([^/?#]+)/);
  return m ? m[1] : "";
}

function buildSpcUrl(id) {
  if (!id) return "";
  return `https://www.amazon.in/checkout/p/${id}/spc?pipelineType=Chewbacca&referrer=pay`;
}

function extractCodValue(html) {
  const pats = [
    /<input[^>]+name=["']ppw-instrumentRowSelection["'][^>]+value=["']([^"']*(?:COD|Cash|PayOnDelivery|pay_on_delivery)[^"']*)["']/i,
    /<input[^>]+value=["']([^"']*(?:COD|Cash|PayOnDelivery|pay_on_delivery)[^"']*)["'][^>]+name=["']ppw-instrumentRowSelection["']/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) {
      return m[1].replace(/&amp;/g,"&");
    }
  }

  const all = [...html.matchAll(/<input[^>]+name=["']ppw-instrumentRowSelection["'][^>]+value=["']([^"']*)["'][^>]*>/gi)];
  for (const match of all) {
    const nearby = html.substring(match.index, match.index + 800);
    if (/cash on delivery|pay on delivery|\bCOD\b/i.test(nearby)) {
      return match[1].replace(/&amp;/g,"&");
    }
  }
  return "instrumentId=0_PayOnDelivery&paymentMethod=COD";
}

function extractOrderTotal(html) {
  if (!html) return null;
  let match = html.match(/Order\s+Total:[\s\S]*?data-shimmer-target=["']ordertotals-amount["'][^>]*>([\s\S]*?)<\/span>/i);
  if (match) return match[1].replace(/<[^>]*>/g, "").trim();

  match = html.match(/data-shimmer-target=["']ordertotals-amount["'][^>]*>([\s\S]*?)<\/span>/i);
  if (match) return match[1].replace(/<[^>]*>/g, "").trim();

  match = html.match(/class=["'][^"']*grand-total-price[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (match) return match[1].replace(/<[^>]*>/g, "").trim();

  match = html.match(/Order\s+Total:[\s\S]{0,100}?<span[^>]*>([\s\S]*?)<\/span>/i);
  return match ? match[1].replace(/<[^>]*>/g, "").trim() : null;
}

async function runBrowserFallbackCheckout(email, confirm, checkoutUrl, minPrice, maxPrice, headless = false) {
  console.log("\n--- [BROWSER FALLBACK] LAUNCHING PUPPETEER CHECKOUT ---");
  console.log(`Starting URL: ${checkoutUrl}`);
  console.log(`Headless mode: ${headless}`);

  const browser = await puppeteer.launch({
    headless: headless ? true : false,
    defaultViewport: null,
    args: ["--start-maximized"]
  });

  try {
    const page = await browser.newPage();
    try {
      const client = await page.target().createCDPSession();
      await client.send('WebAuthn.enable');
      await client.send('WebAuthn.addVirtualAuthenticator', {
        config: {
          protocol: 'ctap2',
          transport: 'usb',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true
        }
      });
    } catch (_) {}
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36");

    const cookies = await cookiesHelper.readCookies(email);
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log("Injected session cookies.");
    }

    console.log("Navigating to checkout page...");
    await page.goto(checkoutUrl, { waitUntil: "networkidle2", timeout: 90000 });

    // 1. Check if we need to sign in (in case session expired in browser context)
    if (page.url().includes("/ap/signin") || await page.$('input[name="signIn"]') !== null) {
      console.log("⚠️ Browser session redirects to sign-in page. Please complete sign-in in browser or verify cookies.");
      if (headless) {
        throw new Error("Re-authentication required. Cannot complete headless browser fallback.");
      }
      console.log("Waiting up to 5 minutes for manual sign-in in browser window...");
      await page.waitForNavigation({ timeout: 300000 }).catch(() => {});
    }

    // 2. Select Cash on Delivery (COD)
    console.log("Locating Cash on Delivery option...");
    await page.waitForSelector('input[name="ppw-instrumentRowSelection"]', { timeout: 30000 });

    const codOptionResult = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[name="ppw-instrumentRowSelection"]'));
      const codRadio = radios.find(r => r.value.includes('paymentMethod=COD') || r.value.includes('COD') || r.value.includes('Cash'));
      if (codRadio) {
        const isDisabled = codRadio.disabled;
        if (codRadio.disabled) {
          console.log("Force enabling disabled COD radio option in DOM...");
          codRadio.disabled = false;
        }
        codRadio.click();
        codRadio.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, value: codRadio.value, disabled: isDisabled };
      }
      return { success: false, disabled: true };
    });

    if (codOptionResult.success) {
      console.log(`Selected Cash on Delivery: ${codOptionResult.value}`);
      if (codOptionResult.disabled) {
        console.error("❌ Cash on Delivery option is disabled/suppressed in browser.");
        throw new Error("COD_DISABLED");
      }
    } else {
      console.error("❌ Could not find Cash on Delivery radio option in browser.");
      throw new Error("COD_DISABLED");
    }

    // Wait a brief moment for any dynamic layout updates
    await new Promise(r => setTimeout(r, 2000));

    // 3. Click Continue button
    console.log("Clicking Continue button...");
    const clickedContinue = await page.evaluate(() => {
      const btn = document.querySelector('input[name*="ContinueEvent"]') ||
                  document.querySelector('input[type="submit"][value="Continue"]') ||
                  document.querySelector('.pmts-continue-button input') ||
                  document.querySelector('input[type="submit"]'); // Fallback
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (clickedContinue) {
      console.log("Clicked continue. Waiting for navigation...");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    } else {
      console.warn("⚠️ Continue button not found. Waiting for manual or auto navigation...");
      await new Promise(r => setTimeout(r, 5000));
    }

    // 4. Handle Prime promotion upsell if present
    for (let check = 0; check < 3; check++) {
      const currentUrl = page.url();
      if (currentUrl.includes("prime") || await page.$('form[action*="decline"]') !== null || await page.$('a[href*="action=decline"]') !== null) {
        console.log("Prime promotion detected. Declining...");
        const declineClicked = await page.evaluate(() => {
          const declineLink = document.querySelector('a[href*="action=decline"]') ||
                                document.querySelector('input[value*="decline"]') ||
                                document.querySelector('[class*="decline"]');
          if (declineLink) {
            declineLink.click();
            return true;
          }
          return false;
        });
        if (declineClicked) {
          await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
        } else {
          break;
        }
      } else {
        break;
      }
    }

    // 5. Single Page Checkout (SPC) - Place Order
    console.log("Checking SPC page status...");
    await page.waitForSelector('span[data-shimmer-target="ordertotals-amount"], .grand-total-price, .a-color-price, input[name="placeYourOrder1"]', { timeout: 30000 });

    const orderTotal = await page.evaluate(() => {
      const el = document.querySelector('[data-shimmer-target="ordertotals-amount"]') ||
                 document.querySelector('.grand-total-price') ||
                 document.querySelector('.a-color-price');
      return el ? el.textContent.trim() : null;
    });
    console.log(`🛒 Order Total in browser: ${orderTotal}`);

    // Validate price range limits
    if (minPrice !== null || maxPrice !== null) {
      if (orderTotal) {
        const parsedPrice = parseFloat(orderTotal.replace(/[^\d.]/g, ""));
        if (!isNaN(parsedPrice)) {
          if (minPrice !== null && parsedPrice < minPrice) {
            console.error(`❌ Price Check Failed: ₹${parsedPrice} < Min ₹${minPrice}`);
            throw new Error("PRICE_CHECK_FAILED");
          }
          if (maxPrice !== null && parsedPrice > maxPrice) {
            console.error(`❌ Price Check Failed: ₹${parsedPrice} > Max ₹${maxPrice}`);
            throw new Error("PRICE_CHECK_FAILED");
          }
          console.log(`✅ Price check passed: ₹${parsedPrice} is within allowed range (₹${minPrice || 0} - ₹${maxPrice || 'No Limit'}).`);
        } else {
          console.error(`❌ Price Check Failed: Could not parse "${orderTotal}"`);
          throw new Error("PRICE_CHECK_FAILED");
        }
      } else {
        console.error("❌ Price Check Failed: Could not find order total.");
        throw new Error("PRICE_CHECK_FAILED");
      }
    }

    // Place order if confirmed
    if (confirm) {
      console.log("Placing order...");
      const clickedPlace = await page.evaluate(() => {
        const btn = document.querySelector('input[name="placeYourOrder1"]') ||
                    document.querySelector('input[type="submit"][value*="Place"]') ||
                    document.querySelector('#submitOrderButton input') ||
                    document.querySelector('.place-your-order-button input');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!clickedPlace) {
        throw new Error("Place Order button not found");
      }

      console.log("Waiting for confirmation page...");
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});

      const finalUrl = page.url();
      const pageContent = await page.content();
      if (/thankyou|thank-you|order-placed|orderPlaced/i.test(finalUrl + pageContent)) {
        console.log("\x1b[32m\n🎉 === ORDER PLACED SUCCESSFULLY WITH COD VIA BROWSER FALLBACK! ===\x1b[0m\n");
        const orderIdMatch = pageContent.match(/\b\d{3}-\d{7}-\d{7}\b/);
        const orderId = orderIdMatch ? orderIdMatch[0] : "UNKNOWN";
        
        // Save final cookies back
        const finalCookies = await page.cookies();
        await cookiesHelper.saveCookies(email, finalCookies);
        console.log("Saved updated session cookies from browser fallback.");
        return { success: true, orderId, orderTotal };
      } else {
        throw new Error(`Unexpected final page URL: ${finalUrl}`);
      }
    } else {
      console.log("\x1b[33m✅ Browser checkout simulation completed. Ready to place order. Run with --confirm-place-order.\x1b[0m");
      // Save final cookies back
      const finalCookies = await page.cookies();
      await cookiesHelper.saveCookies(email, finalCookies);
      console.log("Saved updated session cookies from browser fallback.");
      return { success: true, orderId: "SIMULATION", orderTotal };
    }

  } catch (err) {
    if (err.message === "PRICE_CHECK_FAILED" || err.message === "COD_DISABLED") {
      throw err;
    }
    console.error(`❌ Browser fallback failed: ${err.message}`);
    // If headed, sleep so user can inspect
    if (!headless) {
      console.log("Keeping browser open for 30 seconds to allow inspection...");
      await new Promise(r => setTimeout(r, 30000));
    }
    return false;
  } finally {
    await browser.close();
  }
}

async function runFullBrowserCheckout(email, confirm, minPrice, maxPrice, headless = false, startUrl = "https://www.amazon.in/gp/cart/view.html") {
  console.log("\n--- [BROWSER CHECKOUT] LAUNCHING PUPPETEER CHECKOUT ---");
  console.log(`Email: ${email}`);
  console.log(`Headless mode: ${headless}`);
  console.log(`Confirm order placement: ${confirm}`);
  console.log(`Starting URL: ${startUrl}`);

  const runFlow = async (currentHeadless) => {
    const browser = await puppeteer.launch({
      headless: currentHeadless ? true : false,
      defaultViewport: null,
      args: ["--start-maximized"]
    });

    let page = null;
    let orderTotal = 'UNKNOWN';
    let orderId = 'UNKNOWN';
    try {
      page = await browser.newPage();
      try {
        const client = await page.target().createCDPSession();
        await client.send('WebAuthn.enable');
        await client.send('WebAuthn.addVirtualAuthenticator', {
          config: {
            protocol: 'ctap2',
            transport: 'usb',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true
          }
        });
      } catch (_) {}
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36");

      const cookies = await cookiesHelper.readCookies(email);
      if (cookies && cookies.length > 0) {
        await page.setCookie(...cookies);
        console.log("Injected session cookies.");
      }

      console.log("Navigating to checkout page...");
      await page.goto(startUrl, { waitUntil: "networkidle2", timeout: 90000 });

      // Check for captcha/challenge on initial load
      await checkForCaptcha(page, currentHeadless);

      // 1. Check if we need to sign in (in case session expired in browser context)
      if (page.url().includes("/ap/signin") || await page.$('input[name="signIn"]') !== null) {
        console.log("⚠️ Browser session redirects to sign-in page. Please complete sign-in in browser window.");
        if (currentHeadless) {
          throw new Error("RELAUNCH_HEADED");
        }
        console.log("Waiting up to 5 minutes for manual sign-in in browser window...");
        await page.waitForNavigation({ timeout: 300000 }).catch(() => {});
      }

      // 2. Check if cart is empty and proceed (only if starting from cart page)
      if (page.url().includes("cart/view")) {
        const isCartEmpty = await page.evaluate(() => {
          const emptyMsg = document.querySelector('.sc-your-amazon-cart-is-empty') || 
                           document.querySelector('#sc-empty-cart-message') ||
                           document.querySelector('.sc-empty-active-cart-message');
          return !!emptyMsg;
        });

        if (isCartEmpty) {
          throw new Error("Your Amazon cart is empty! Cannot checkout.");
        }

        // Click Proceed to checkout
        console.log("Proceeding to checkout...");
        const clickedProceed = await page.evaluate(() => {
          const btn = document.querySelector('input[name="proceedToRetailCheckout"]') ||
                      document.querySelector('input[value="Proceed to checkout"]') ||
                      document.querySelector('.a-button-input[name="proceedToRetailCheckout"]') ||
                      document.querySelector('a[href*="/gp/checkout/html"]') ||
                      document.querySelector('[data-action="proceed-to-checkout"]');
          if (btn) {
            btn.click();
            return true;
          }
          return false;
        });

        if (!clickedProceed) {
          if (!page.url().includes("/checkout/")) {
            throw new Error("Proceed to checkout button not found");
          }
          console.log("Already on checkout page.");
        } else {
          console.log("Clicked proceed. Waiting for checkout page...");
          await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});
        }
      }

      await new Promise(r => setTimeout(r, 3000));

      let maxSteps = 10;
      let currentStep = 0;
      let completed = false;

      while (currentStep < maxSteps) {
        currentStep++;
        try {
          const pages = await browser.pages();
          const currentPage = pages[pages.length - 1] || page;

          // Check for captcha/challenge on current page state
          await checkForCaptcha(currentPage, currentHeadless);

          const currentUrl = currentPage.url();
          const content = await currentPage.content();
          console.log(`[Checkout Step ${currentStep}/10] Current URL: ${currentUrl}`);

          // Handle re-auth if asked
          if (currentUrl.includes("/ap/signin")) {
            console.log("⚠️ Re-authentication required. Please log in manually...");
            if (currentHeadless) throw new Error("RELAUNCH_HEADED");
            await currentPage.waitForNavigation({ timeout: 120000 }).catch(() => {});
            continue;
          }

          // Handle Prime promo upsell
          const isPrimePromo = currentUrl.includes("prime") || 
                               content.includes("prime-signup-form") || 
                               await currentPage.$('form[action*="decline"]') !== null || 
                               await currentPage.$('a[href*="action=decline"]') !== null;
          if (isPrimePromo) {
            console.log("Prime promotion detected. Declining...");
            const declineClicked = await currentPage.evaluate(() => {
              const declineLink = document.querySelector('a[href*="action=decline"]') ||
                                    document.querySelector('input[value*="decline"]') ||
                                    document.querySelector('[class*="decline"]') ||
                                    document.querySelector('a[href*="decline"]');
              if (declineLink) {
                declineLink.click();
                return true;
              }
              return false;
            });
            if (declineClicked) {
              await currentPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 2000));
            } else {
              console.warn("Could not click decline link, waiting...");
              await new Promise(r => setTimeout(r, 5000));
            }
            continue;
          }

          // Handle Address selection
          const isAddressPage = currentUrl.includes("address") || 
                                content.includes("select-address-event") || 
                                content.includes("billingAddressSelectForm") || 
                                content.includes("shippingAddressSelectForm") ||
                                await currentPage.$('input[name*="useSelectedAddress"]') !== null ||
                                await currentPage.$('input[type="submit"][value*="Use this address"]') !== null;
          if (isAddressPage && !content.includes("ppw-instrumentRowSelection")) {
            console.log("Address selection page detected. Proceeding with default address...");
            const clickedAddress = await currentPage.evaluate(() => {
              const btn = document.querySelector('input[type="submit"][value*="Use this address"]') ||
                          document.querySelector('input[type="submit"][value*="Deliver to this address"]') ||
                          document.querySelector('input[name*="useSelectedAddress"]') ||
                          document.querySelector('[data-action="select-address-event"]') ||
                          document.querySelector('.address-select-button') ||
                          document.querySelector('input[type="submit"]');
              if (btn) {
                btn.click();
                return true;
              }
              return false;
            });

            if (clickedAddress) {
              console.log("Clicked address select. Waiting for navigation...");
              await currentPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 2000));
            } else {
              console.warn("Could not find address selection button. Waiting...");
              await new Promise(r => setTimeout(r, 5000));
            }
            continue;
          }

          // Handle Payment page
          const isPaymentPage = content.includes("ppw-instrumentRowSelection") || currentUrl.includes("/pay");
          if (isPaymentPage && !currentUrl.includes("/spc")) {
            console.log("Payment options page detected. Selecting Cash on Delivery...");
            const codSelected = await currentPage.evaluate(() => {
              const radios = Array.from(document.querySelectorAll('input[name="ppw-instrumentRowSelection"]'));
              const codRadio = radios.find(r => r.value.includes('paymentMethod=COD') || r.value.includes('COD') || r.value.includes('Cash') || r.value.includes('pay_on_delivery'));
              if (codRadio) {
                const isDisabled = codRadio.disabled;
                if (codRadio.disabled) {
                  console.log("Force enabling disabled COD radio option...");
                  codRadio.disabled = false;
                }
                codRadio.click();
                codRadio.dispatchEvent(new Event('change', { bubbles: true }));
                return { success: true, value: codRadio.value, disabled: isDisabled };
              }
              return { success: false, disabled: true };
            });

            if (codSelected.success) {
              console.log(`COD option selected: ${codSelected.value}`);
              if (codSelected.disabled) {
                console.error("❌ Cash on Delivery option is disabled/suppressed in browser.");
                throw new Error("COD_DISABLED");
              }
            } else {
              console.error("❌ Could not locate Cash on Delivery option in browser.");
              throw new Error("COD_DISABLED");
            }

            await new Promise(r => setTimeout(r, 2000));

            console.log("Clicking Continue button...");
            const clickedContinue = await currentPage.evaluate(() => {
              const btn = document.querySelector('input[name*="ContinueEvent"]') ||
                          document.querySelector('input[type="submit"][value="Continue"]') ||
                          document.querySelector('.pmts-continue-button input') ||
                          document.querySelector('input[type="submit"]');
              if (btn) {
                btn.click();
                return true;
              }
              return false;
            });

            if (clickedContinue) {
              console.log("Clicked Continue. Waiting for navigation...");
              await currentPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 2000));
            } else {
              console.warn("Continue button not found. Waiting...");
              await new Promise(r => setTimeout(r, 5000));
            }
            continue;
          }

          // Handle SPC (Place Order Review) page
          const isSpcPage = currentUrl.includes("/spc") || 
                            content.includes("place-order") || 
                            content.includes("placeYourOrder1") ||
                            await currentPage.$('input[name="placeYourOrder1"]') !== null;
          if (isSpcPage) {
            console.log("SPC/Review page reached. Extracting order total...");
            orderTotal = await currentPage.evaluate(() => {
              const el = document.querySelector('[data-shimmer-target="ordertotals-amount"]') ||
                         document.querySelector('.grand-total-price') ||
                         document.querySelector('.a-color-price');
              return el ? el.textContent.trim() : null;
            });
            console.log(`🛒 Order Total in browser: ${orderTotal}`);

            // Validate price range limits
            if (minPrice !== null || maxPrice !== null) {
              if (orderTotal) {
                const parsedPrice = parseFloat(orderTotal.replace(/[^\d.]/g, ""));
                if (!isNaN(parsedPrice)) {
                  if (minPrice !== null && parsedPrice < minPrice) {
                    throw new Error(`PRICE_CHECK_FAILED: ₹${parsedPrice} < Min ₹${minPrice}`);
                  }
                  if (maxPrice !== null && parsedPrice > maxPrice) {
                    throw new Error(`PRICE_CHECK_FAILED: ₹${parsedPrice} > Max ₹${maxPrice}`);
                  }
                  console.log(`✅ Price check passed: ₹${parsedPrice} is within allowed range (₹${minPrice || 0} - ₹${maxPrice || 'No Limit'}).`);
                } else {
                  throw new Error(`PRICE_CHECK_FAILED: Could not parse "${orderTotal}"`);
                }
              } else {
                throw new Error("PRICE_CHECK_FAILED: Could not find order total.");
              }
            }

            if (confirm) {
              console.log("Placing order...");
              const clickedPlace = await currentPage.evaluate(() => {
                const btn = document.querySelector('input[name="placeYourOrder1"]') ||
                            document.querySelector('input[type="submit"][value*="Place"]') ||
                            document.querySelector('#submitOrderButton input') ||
                            document.querySelector('.place-your-order-button input');
                if (btn) {
                  btn.click();
                  return true;
                }
                return false;
              });

              if (!clickedPlace) {
                throw new Error("Place Order button not found on SPC page");
              }

              console.log("Waiting for confirmation page...");
              await currentPage.waitForNavigation({ waitUntil: "networkidle2", timeout: 45000 }).catch(() => {});

              const finalUrl = currentPage.url();
              const finalContent = await currentPage.content();
              if (/thankyou|thank-you|order-placed|orderPlaced/i.test(finalUrl + finalContent)) {
                console.log("\x1b[32m\n🎉 === ORDER PLACED SUCCESSFULLY VIA BROWSER CHECKOUT! ===\x1b[0m\n");
                const orderIdMatch = finalContent.match(/\b\d{3}-\d{7}-\d{7}\b/);
                if (orderIdMatch) orderId = orderIdMatch[0];
                completed = true;
                break;
              } else {
                throw new Error(`Unexpected final page URL/content: ${finalUrl}`);
              }
            } else {
              console.log("\x1b[33m✅ Browser checkout simulation completed. Ready to place order. Run with --confirm-place-order.\x1b[0m");
              if (!currentHeadless) {
                console.log("Keeping browser open for 60 seconds to allow inspection...");
                await new Promise(r => setTimeout(r, 60000));
              }
              orderId = "SIMULATION";
              completed = true;
              break;
            }
          }

          // If we got here, page didn't match any state yet, wait a bit
          await new Promise(r => setTimeout(r, 3000));
        } catch (stepErr) {
          if (stepErr.message.includes("PRICE_CHECK_FAILED") || stepErr.message === "COD_DISABLED" || stepErr.message === "RELAUNCH_HEADED") {
            throw stepErr; // ❌ Immediately stop — no retry for COD, price, or relaunch issues
          }
          console.warn(`[Warning] Temporary error on checkout step ${currentStep}: ${stepErr.message}. Retrying...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (!completed) {
        throw new Error("Checkout flow timed out or could not progress to completion.");
      }

      const pagesList = await browser.pages();
      const finalCookies = await (pagesList[pagesList.length - 1] || page).cookies();
      await cookiesHelper.saveCookies(email, finalCookies);
      console.log("Saved updated session cookies from browser checkout.");
      return { success: true, orderId, orderTotal };

    } catch (err) {
      if (err.message.includes("PRICE_CHECK_FAILED") || err.message === "COD_DISABLED" || err.message === "RELAUNCH_HEADED") {
        throw err; // Propagate up to caller
      }
      console.error(`❌ Browser checkout failed: ${err.message}`);
      if (!currentHeadless) {
        console.log("Keeping browser open for 15 seconds to allow inspection...");
        await new Promise(r => setTimeout(r, 15000));
      }
      return { success: false, error: err.message };
    } finally {
      await browser.close();
    }
  };

  try {
    return await runFlow(headless);
  } catch (err) {
    if (err.message === "RELAUNCH_HEADED") {
      console.log(`\n🔄 [${email}] CAPTCHA/Challenge detected in headless checkout mode! Relaunching in non-headless (headed) mode for manual solving...`);
      return await runFlow(false);
    }
    throw err;
  }
}

// ==================== CHECKOUT PIPELINES ====================

async function runPayOnDeliveryCheckout(email, confirm, headless = false) {
  console.log("\n=== AMAZON COD API CHECKOUT ===");
  if (!confirm) console.log("[SAFE MODE] Order will NOT be confirmed. Use --confirm-place-order to place the order.\n");

  let selectedPayment = false;
  let finalOrderTotal = 'UNKNOWN';

  // ── 1. Cart page ──────────────────────────────────────────
  console.log("[1/5] Cart page...");
  const cartR = await sendAuthorizedRequest({
    method: "GET", url: "https://www.amazon.in/gp/cart/view.html",
    maxRedirects: 10, validateStatus: s => s >= 200 && s < 500,
  }, email);
  const cartHtml = cartR.data;
  const initForm = parseForm(cartHtml, "proceedToRetailCheckout") || parseForm(cartHtml, "proceedToCheckout");
  if (!initForm) {
    fs.writeFileSync(path.join(__dirname, "debug_cart.html"), cartHtml, "utf8");
    throw new Error("Checkout form not found — cart empty? Saved debug_cart.html");
  }
  initForm.inputs["proceedToCheckout"] = "1";
  if (!initForm.inputs["pipelineType"]) initForm.inputs["pipelineType"] = "Chewbacca";

  let currentUrl = normalizeAmazonUrl(initForm.action) || "https://www.amazon.in/checkout/enter-checkout";
  let pageHtml = "";

  // ── 2. Initiate checkout ──────────────────────────────────
  console.log("[2/5] Initiating checkout...");
  const method = (initForm.method || "post").toLowerCase();
  let initR;
  if (method === "get") {
    const target = `${currentUrl.split("?")[0]}?${querystring.stringify(initForm.inputs)}`;
    initR = await sendAuthorizedRequest({ method: "GET", url: target, headers: { Referer: "https://www.amazon.in/gp/cart/view.html" }, maxRedirects: 10, validateStatus: s => s >= 200 && s < 500 }, email);
  } else {
    initR = await sendAuthorizedRequest({ method: "POST", url: currentUrl, data: querystring.stringify(initForm.inputs), headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: "https://www.amazon.in/gp/cart/view.html", Origin: "https://www.amazon.in" }, maxRedirects: 10, validateStatus: s => s >= 200 && s < 500 }, email);
  }
  currentUrl = normalizeAmazonUrl(getResponseUrl(initR, currentUrl)) || currentUrl;
  pageHtml = typeof initR.data === "string" ? initR.data : JSON.stringify(initR.data);
  if (initR.status >= 300 && initR.headers.location) {
    currentUrl = normalizeAmazonUrl(initR.headers.location);
    const fetchRes = await fetchHtmlAt(currentUrl, email);
    currentUrl = fetchRes.currentUrl;
    pageHtml = fetchRes.pageHtml;
  }

  // ── Prime upsell bypass ──
  for (let i = 0; i < 3; i++) {
    if (!/prime-signup-form|action=decline/.test(pageHtml + currentUrl)) break;
    const dm = pageHtml.match(/href="([^"]*action=decline[^"]*)"/i);
    if (!dm) break;
    let du = dm[1].replace(/&amp;/g,"&");
    if (du.startsWith("/")) du = "https://www.amazon.in" + du;
    console.log("Prime upsell — declining:", du);
    const fetchRes = await fetchHtmlAt(du, email, currentUrl);
    currentUrl = fetchRes.currentUrl;
    pageHtml = fetchRes.pageHtml;
  }

  // ── 3. Address selection ──────────────────────────────────
  // Check if we are actually on the address page. Avoid matching CSS/JS filenames containing "address" in pageHtml.
  const hasPaymentWidget = /ppw-widgetState|ppw-instrumentRowSelection/i.test(pageHtml);
  const isOnAddressPage = !hasPaymentWidget && (
                            (/\/address|billingaddressselect|selectaddress|select-address/i.test(currentUrl)) || 
                            (/billingAddressSelectForm|shippingAddressSelectForm/i.test(pageHtml)) || 
                            (/Select a delivery address|Select a billing address|Choose a delivery address|Choose a shipping address/i.test(pageHtml))
                          );

  if (isOnAddressPage) {
    console.log("[3/5] Address selection...");
    fs.writeFileSync(path.join(__dirname, "debug_address_page.html"), pageHtml, "utf8");
    const af = parseForm(pageHtml, "billingAddressSelectForm") || parseForm(pageHtml, "shippingAddressSelectForm") || parseForm(pageHtml, "main-continue-form");
    if (af) {
      const aUrl = normalizeAmazonUrl(af.action) || currentUrl;
      console.log(`[DEBUG] Submitting address form to action URL: ${aUrl}`);
      console.log(`[DEBUG] Form inputs:`, JSON.stringify(af.inputs, null, 2));
      try {
        const ar = await sendAuthorizedRequest({ 
          method: "POST", 
          url: aUrl, 
          data: querystring.stringify(af.inputs), 
          headers: { 
            "Content-Type": "application/x-www-form-urlencoded", 
            Referer: currentUrl, 
            Origin: "https://www.amazon.in" 
          }, 
          maxRedirects: 10, 
          validateStatus: s => s >= 200 && s < 500 
        }, email);
        currentUrl = normalizeAmazonUrl(getResponseUrl(ar, aUrl)) || aUrl;
        pageHtml = typeof ar.data === "string" ? ar.data : JSON.stringify(ar.data);
        if (ar.status >= 300 && ar.headers.location) {
          const fetchRes = await fetchHtmlAt(normalizeAmazonUrl(ar.headers.location), email, aUrl);
          currentUrl = fetchRes.currentUrl;
          pageHtml = fetchRes.pageHtml;
        }
      } catch (postErr) {
        if (postErr.response) {
          fs.writeFileSync(path.join(__dirname, "debug_address_post_response.html"), typeof postErr.response.data === "string" ? postErr.response.data : JSON.stringify(postErr.response.data), "utf8");
          console.error(`[DEBUG] Address POST failed with status: ${postErr.response.status}`);
        } else {
          console.error(`[DEBUG] Address POST failed: ${postErr.message}`);
        }
        throw postErr;
      }
    } else {
      console.log("[DEBUG] Address page detected, but no address selection form was found.");
    }
  } else {
    console.log("[3/5] No address page — skipping.");
  }

  // ── 4. Payment — pick COD ─────────────────────────────────
  console.log("[4/5] Payment stage...");
  let pipeId = getPipelineId(currentUrl);

  for (let attempt = 0; attempt < 3; attempt++) {
    console.log(`[DEBUG] Attempt ${attempt}: currentUrl = ${currentUrl}`);
    fs.writeFileSync(path.join(__dirname, "debug_checkout_stage.html"), pageHtml, "utf8");
    
    // ── Prime upsell bypass inside loop ──
    for (let i = 0; i < 3; i++) {
      if (!/prime-signup-form|action=decline/i.test(pageHtml + currentUrl)) break;
      const dm = pageHtml.match(/href=["']([^"']*action=decline[^"']*)["']/i);
      if (!dm) break;
      let du = dm[1].replace(/&amp;/g,"&");
      if (du.startsWith("/")) du = "https://www.amazon.in" + du;
      console.log("Prime upsell inside loop — declining:", du);
      const fetchRes = await fetchHtmlAt(du, email, currentUrl);
      currentUrl = fetchRes.currentUrl;
      pageHtml = fetchRes.pageHtml;
      fs.writeFileSync(path.join(__dirname, "debug_checkout_stage.html"), pageHtml, "utf8");
    }

    const onPay = (/\/pay\b/i.test(currentUrl) || /ppw-widgetState|ppw-instrumentRowSelection/i.test(pageHtml)) && !/\/spc/i.test(currentUrl) && !/membersignup/i.test(currentUrl) && !/prime/i.test(currentUrl);
    const onSpc = /\/spc/i.test(currentUrl) || /spc-form|place-order|place_your_order|placeYourOrder|selected-payment-methods/i.test(pageHtml);
    console.log(`[DEBUG] onPay = ${onPay}, onSpc = ${onSpc}`);

    if (onPay) {
      fs.writeFileSync(path.join(__dirname, "debug_payment_page.html"), pageHtml, "utf8");
      const codVal = extractCodValue(pageHtml);
      console.log(`COD value: ${codVal}`);
      
      // Check if COD option is disabled/suppressed
      const escapeRegex = (string) => string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
      const escapedCodVal = escapeRegex(codVal).replace(/&/g, '(?:&|&amp;)');
      const disabledRegex = new RegExp(`<input[^>]+value=["']${escapedCodVal}["'][^>]*disabled`, 'i');
      const disabledRegexAlt = new RegExp(`<input[^>]+disabled[^>]+value=["']${escapedCodVal}["']`, 'i');
      
      const isCodDisabled = disabledRegex.test(pageHtml) || 
                            disabledRegexAlt.test(pageHtml) || 
                            pageHtml.includes("cod-suppressed-color") ||
                            /Unavailable for this payment/i.test(pageHtml);
                            
      if (isCodDisabled) {
        let reason = "Unavailable for this payment";
        const matches = [...pageHtml.matchAll(/class=["'][^"']*cod-suppressed-color[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)];
        if (matches.length > 0) {
          const reasons = matches.map(m => m[1].replace(/<[^>]*>/g, "").trim()).filter(Boolean);
          reason = reasons.join(" - ");
        }
        console.error(`\x1b[31m❌ Cash on Delivery (COD) is disabled/suppressed: "${reason}"\x1b[0m`);
        console.log("⚠️ Programmatic COD is unavailable. Falling back to Puppeteer browser session...");
        try {
          return await runFullBrowserCheckout(email, confirm, minPriceOverride, maxPriceOverride, headless, currentUrl);
        } catch (browserErr) {
          if (browserErr.message === "COD_DISABLED") {
            throw browserErr;
          }
          throw new Error("COD_DISABLED");
        }
      }
      
      const pf = parseForm(pageHtml, "ppw-widgetState") || parseForm(pageHtml, "paymentForm") || parseForm(pageHtml, "ppw-instrumentRowSelection");
      if (!pf) {
        fs.writeFileSync(path.join(__dirname, "debug_pay_noform.html"), pageHtml, "utf8");
        throw new Error("Payment form not found — debug_pay_noform.html saved");
      }
      pf.inputs["ppw-instrumentRowSelection"] = codVal;
      pf.inputs["ppw-widgetEvent"] = "SetPaymentPlanSelectContinueEvent";
      
      let csrf = "";
      const csrfMetaMatch = pageHtml.match(/<meta[^>]*name=["']anti-csrftoken-a2z["'][^>]*content=["']([^"']*)["']/i) ||
                            pageHtml.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']anti-csrftoken-a2z["']/i);
      if (csrfMetaMatch) csrf = csrfMetaMatch[1];
      else {
        const csrfInputMatch = pageHtml.match(/name=["']anti-csrftoken-a2z["']\s*value=["']([^"']*)["']/i);
        if (csrfInputMatch) csrf = csrfInputMatch[1];
      }
      
      const pUrl = normalizeAmazonUrl(pf.action) || currentUrl;
      if (!pipeId) pipeId = getPipelineId(pUrl) || getPipelineId(currentUrl);
      
      const pr = await sendAuthorizedRequest({ method: "POST", url: pUrl, data: querystring.stringify(pf.inputs), headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: currentUrl, Origin: "https://www.amazon.in", ...(csrf ? {"anti-csrftoken-a2z": csrf} : {}) }, maxRedirects: 10, validateStatus: s => s >= 200 && s < 500 }, email);
      fs.writeFileSync(path.join(__dirname, "debug_payment_submit_response.html"), typeof pr.data === "string" ? pr.data : JSON.stringify(pr.data), "utf8");
      
      selectedPayment = true;
      
      if (pr.status >= 300 && pr.headers.location) {
        currentUrl = normalizeAmazonUrl(pr.headers.location);
        if (!pipeId) pipeId = getPipelineId(currentUrl);
        const fetchRes = await fetchHtmlAt(currentUrl, email, pUrl);
        currentUrl = fetchRes.currentUrl;
        pageHtml = fetchRes.pageHtml;
      } else {
        currentUrl = normalizeAmazonUrl(getResponseUrl(pr, pUrl)) || pUrl;
        pageHtml = typeof pr.data === "string" ? pr.data : JSON.stringify(pr.data);
        if (/ppw-widgetState|ppw-instrumentRowSelection/i.test(pageHtml) && pipeId) {
          const spc = buildSpcUrl(pipeId);
          console.log("Still on payment — fetching SPC:", spc);
          const fetchRes = await fetchHtmlAt(spc, email, pUrl);
          currentUrl = fetchRes.currentUrl;
          pageHtml = fetchRes.pageHtml;
        }
      }
      continue;
    }

    if (onSpc) {
      // Robust detection of selected payment method in SPC page
      let payText = "";
      const selectedPaymentMatch = pageHtml.match(/id=["']selected-payment-instrument-name["'][^>]*>([\s\S]*?)<\/span>/i) ||
                                  pageHtml.match(/class=["'][^"']*pmts-instrument-display-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
      
      if (selectedPaymentMatch) {
        payText = selectedPaymentMatch[1].replace(/<[^>]*>/g, "").trim();
      } else {
        // Fallback: Find break-word span containing Cash or Pay on Delivery
        const allSpans = [...pageHtml.matchAll(/<span[^>]*class=["']break-word["'][^>]*>([\s\S]*?)<\/span>/gi)];
        const codSpan = allSpans.find(m => /pay on delivery|cash on delivery|cod/i.test(m[1]));
        if (codSpan) {
          payText = codSpan[1].replace(/<[^>]*>/g, "").trim();
        } else {
          // If no specific match, grab the first break-word span that doesn't look like agreement text
          const fallbackSpan = allSpans.find(m => {
            const txt = m[1].replace(/<[^>]*>/g, "").trim();
            return txt && !/placing your order|agree to|privacy notice|conditions of use/i.test(txt);
          });
          if (fallbackSpan) {
            payText = fallbackSpan[1].replace(/<[^>]*>/g, "").trim();
          } else {
            payText = (pageHtml.match(/<span[^>]*class=["']break-word["'][^>]*>([\s\S]*?)<\/span>/i)||[])[1]?.replace(/<[^>]*>/g,"").trim() || "";
          }
        }
      }

      const isCod = /pay on delivery|cash on delivery|\bcod\b/i.test(payText);
      console.log(`SPC — payment: "${payText}" COD:${isCod}`);

      const orderTotal = extractOrderTotal(pageHtml);
      if (orderTotal) {
        finalOrderTotal = orderTotal;
        console.log(`\x1b[32m🛒 Order Total: ${orderTotal}\x1b[0m`);
      }

      if (!isCod && !selectedPayment) {
        const cm = pageHtml.match(/href="([^"]*\/pay\?[^"]*pipelineType=Chewbacca[^"]*)"/i);
        if (!cm) {
          console.warn("Change payment link not found — proceeding.");
        } else {
          let cu = cm[1].replace(/&amp;/g,"&");
          if (cu.startsWith("/")) cu = "https://www.amazon.in" + cu;
          const fetchRes = await fetchHtmlAt(cu, email, currentUrl);
          currentUrl = fetchRes.currentUrl;
          pageHtml = fetchRes.pageHtml;
          continue;
        }
      }

      if (!isCod) {
        console.error(`❌ Checkout Aborted: Payment method is not Cash on Delivery ("${payText}").`);
        throw new Error("COD_DISABLED");
      }

      // ── 5. Place Order ─────────────────────────────────────
      console.log("[5/5] Place Order form...");

      if (minPriceOverride !== null || maxPriceOverride !== null) {
        if (orderTotal) {
          const parsedPrice = parseFloat(orderTotal.replace(/[^\d.]/g, ""));
          if (!isNaN(parsedPrice)) {
            if (minPriceOverride !== null && parsedPrice < minPriceOverride) {
              console.error(`\x1b[31m❌ Price Check Failed: Order total (₹${parsedPrice}) is below the minimum allowed price (₹${minPriceOverride}). Skipping order placement!\x1b[0m`);
              throw new Error("PRICE_CHECK_FAILED");
            }
            if (maxPriceOverride !== null && parsedPrice > maxPriceOverride) {
              console.error(`\x1b[31m❌ Price Check Failed: Order total (₹${parsedPrice}) is above the maximum allowed price (₹${maxPriceOverride}). Skipping order placement!\x1b[0m`);
              throw new Error("PRICE_CHECK_FAILED");
            }
            console.log(`✅ Price check passed: ₹${parsedPrice} is within allowed range (₹${minPriceOverride || 0} - ₹${maxPriceOverride || 'No Limit'}).`);
          } else {
            console.error(`\x1b[31m❌ Price Check Failed: Price range is configured, but order total (${orderTotal}) could not be parsed numerically. Skipping order placement!\x1b[0m`);
            throw new Error("PRICE_CHECK_FAILED");
          }
        } else {
          console.error("❌ Price Check Failed: Price range is configured, but order total could not be determined. Skipping order placement!");
          throw new Error("PRICE_CHECK_FAILED");
        }
      }

      const pof = parseForm(pageHtml,"place-order") || parseForm(pageHtml,"placeYourOrder") || parseForm(pageHtml,"chk_spc_chw_placeOrder") || parseForm(pageHtml,"spc-form") || parseForm(pageHtml,"submitOrder");
      if (!pof) { 
        fs.writeFileSync(path.join(__dirname, "checkout_ready_to_place_order.html"), pageHtml,"utf8"); 
        console.warn("Place Order form not found — saved checkout_ready_to_place_order.html"); 
        console.log("⚠️ Programmatic Place Order form not found. Falling back to Puppeteer browser session...");
        return await runFullBrowserCheckout(email, confirm, minPriceOverride, maxPriceOverride, headless, currentUrl);
      }
      
      const poUrl = normalizeAmazonUrl(pof.action) || currentUrl;
      if (!confirm) { 
        fs.writeFileSync(path.join(__dirname, "checkout_ready_to_place_order.html"), pageHtml,"utf8"); 
        console.log("\x1b[33m✅ Checkout simulation completed. Ready to place order. Run with --confirm-place-order.\x1b[0m"); 
        return { success: true, orderId: "SIMULATION", orderTotal: finalOrderTotal }; 
      }
      
      const por = await sendAuthorizedRequest({ method: "POST", url: poUrl, data: querystring.stringify(pof.inputs), headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: currentUrl, Origin: "https://www.amazon.in" }, maxRedirects: 10, validateStatus: s => s >= 200 && s < 500 }, email);
      if (por.status >= 300 && por.headers.location) {
        const fetchRes = await fetchHtmlAt(normalizeAmazonUrl(por.headers.location), email, poUrl);
        currentUrl = fetchRes.currentUrl;
        pageHtml = fetchRes.pageHtml;
      } else {
        currentUrl = normalizeAmazonUrl(getResponseUrl(por, poUrl)) || poUrl;
        pageHtml = typeof por.data === "string" ? por.data : JSON.stringify(por.data);
      }
      
      if (/thankyou|thank-you|order-placed|orderPlaced/i.test(currentUrl + pageHtml)) {
        console.log("\x1b[32m\n🎉 === ORDER PLACED SUCCESSFULLY WITH COD! ===\x1b[0m\n");
        const orderIdMatch = pageHtml.match(/\b\d{3}-\d{7}-\d{7}\b/);
        const orderId = orderIdMatch ? orderIdMatch[0] : "UNKNOWN";
        return { success: true, orderId, orderTotal: finalOrderTotal };
      } else { 
        fs.writeFileSync(path.join(__dirname, "checkout_unexpected.html"), pageHtml,"utf8"); 
        console.warn("\x1b[33mUnexpected final page:", currentUrl, "— saved checkout_unexpected.html\x1b[0m"); 
        return { success: false, error: `Unexpected final page URL: ${currentUrl}` };
      }
    }
    break;
  }
  return { success: false, error: "Checkout loop completed without placing order" };
}

// ==================== MAIN ====================
async function main() {
  const config = parseArgs();
  if (config.help) {
    console.log(`
Usage:
  node pay_on_delivery.js [options]

Options:
  --confirm-place-order, --confirm   Actually place the order (confirm final payment)
  --email <email>                     Specify Amazon email
  --min-price <number>                Set minimum allowed price check
  --max-price <number>                Set maximum allowed price check
  --start-url <url>                   Set initial affiliate start url
  --browser, --force-browser          Run checkout entirely in Puppeteer browser window
  --help, -h                          Show help
`);
    process.exit(0);
  }

  const email = cookiesHelper.getActiveEmail(config.email);
  if (!email) {
    console.error("❌ Error: Active email could not be determined. Set in credentials.json or pass --email.");
    process.exit(1);
  }

  // Set overrides
  minPriceOverride = config.minPrice;
  maxPriceOverride = config.maxPrice;
  startUrl = config.startUrl;

  if (minPriceOverride !== null || maxPriceOverride !== null) {
    console.log(`💰 Price Limits Configured -> Min: ₹${minPriceOverride || 0}, Max: ₹${maxPriceOverride || 'No Limit'}`);
  }

  try {
    let result;
    if (config.browser) {
      result = await runFullBrowserCheckout(email, config.confirm, minPriceOverride, maxPriceOverride, config.headless);
    } else {
      try {
        result = await runPayOnDeliveryCheckout(email, config.confirm, config.headless);
      } catch (apiErr) {
        if (apiErr.message.includes("PRICE_CHECK_FAILED") || apiErr.message === "COD_DISABLED") {
          throw apiErr;
        }
        console.warn(`⚠️ API checkout encountered an error: ${apiErr.message}. Falling back to Puppeteer browser...`);
        result = await runFullBrowserCheckout(email, config.confirm, minPriceOverride, maxPriceOverride, config.headless);
      }
      if (!result || !result.success) {
        console.warn("⚠️ API checkout returned failure. Falling back to Puppeteer browser...");
        result = await runFullBrowserCheckout(email, config.confirm, minPriceOverride, maxPriceOverride, config.headless);
      }
    }

    if (!result || !result.success) {
      console.error("\x1b[31m❌ Checkout failed.\x1b[0m");
      const errorMsg = result ? result.error || 'Unknown error' : 'Checkout returned empty';
      await googleSheets.updateAccountStatus(email, 'FAILED', errorMsg);
      process.exit(1);
    }

    // Success path: Log to Google Sheets
    if (config.confirm && result.orderId && result.orderId !== 'SIMULATION') {
      // 1. Get products from cart_input.json
      let productsStr = '';
      const cartInputPath = path.join(__dirname, 'cart_input.json');
      if (fs.existsSync(cartInputPath)) {
        try {
          const cartInput = JSON.parse(fs.readFileSync(cartInputPath, 'utf8'));
          if (cartInput.products && Array.isArray(cartInput.products)) {
            productsStr = cartInput.products.map(p => {
              const asinMatch = p.asin.match(/\/dp\/([A-Z0-9]{10})\b/i) || p.asin.match(/\/d\/([A-Z0-9]{10})\b/i);
              const asin = asinMatch ? asinMatch[1] : p.asin;
              return `${asin} (Qty: ${p.quantity})`;
            }).join(', ');
          }
        } catch (e) {}
      }

      // 2. Fetch current public IP address
      let currentIp = 'UNKNOWN';
      try {
        const ipRes = await axios.get('https://api.ipify.org?format=json', { timeout: 3000 });
        currentIp = ipRes.data.ip || 'UNKNOWN';
      } catch (_) {}

      // 3. Log to sheet
      await googleSheets.appendOrderRow(email, 'SUCCESS', result.orderId, result.orderTotal || 'UNKNOWN', productsStr, '', currentIp);
    }

    process.exit(0);
  } catch (err) {
    let finalStatus = 'FAILED';
    let reason = err.message;
    
    if (err.message.includes("PRICE_CHECK_FAILED")) {
      console.error("\x1b[31m❌ Checkout Aborted: Price check validation failed.\x1b[0m");
      finalStatus = 'PRICE_CHECK_FAILED';
    } else if (err.message === "COD_DISABLED") {
      console.error("\x1b[31m❌ Checkout Aborted: Cash on Delivery is disabled or unavailable.\x1b[0m");
      finalStatus = 'NO_COD';
      await handleCodUnavailable(email, config.userId);
    } else {
      console.error(`\x1b[31m❌ Checkout error: ${err.message}\x1b[0m`);
    }

    // Log failure to sheet
    await googleSheets.updateAccountStatus(email, finalStatus, reason);
    process.exit(1);
  }
}

main();
