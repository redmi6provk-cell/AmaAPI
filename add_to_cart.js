const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const axios = require("axios");
const cookiesHelper = require("./cookies");

function extractAsin(input) {
  if (!input) return null;
  const match = input.match(/\/dp\/([A-Z0-9]{10})/i) || 
                input.match(/\/gp\/product\/([A-Z0-9]{10})/i) ||
                input.match(/\/gp\/aw\/d\/([A-Z0-9]{10})/i) ||
                input.match(/\/asin\/([A-Z0-9]{10})/i) ||
                input.match(/\/d\/([A-Z0-9]{10})/i) ||
                input.match(/^([A-Z0-9]{10})$/i);
  if (match) return match[1].toUpperCase();

  // Fallback: search for any 10-character word starting with B
  const fallback = input.match(/\b(B[A-Z0-9]{9})\b/i);
  return fallback ? fallback[1].toUpperCase() : null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    asinOrUrl: null,
    quantity: "1",
    email: null,
    headless: false,
    help: false
  };

  // Positional arguments
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--headless") {
      config.headless = true;
    } else if (args[i] === "--email") {
      config.email = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      config.help = true;
    } else {
      positionals.push(args[i]);
    }
  }

  if (positionals.length > 0) {
    config.asinOrUrl = positionals[0];
  }
  if (positionals.length > 1) {
    config.quantity = positionals[1];
  }

  return config;
}

async function syncCartResponse(email, cookieString) {
  const cartApiUrl = "https://www.amazon.in/cart/add-to-cart/get-cart-items?clientName=SiteWideActionExecutor&_=1779954926131";
  const safeEmail = email.replace(/[^a-zA-Z0-9]/g, "_");
  try {
    const response = await axios.get(cartApiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        "Cookie": cookieString,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    if (typeof response.data === "object" && response.data !== null) {
      fs.writeFileSync(path.join(__dirname, `cart_response_${safeEmail}.json`), JSON.stringify(response.data, null, 2), "utf8");
      fs.writeFileSync(path.join(__dirname, "cart_response.json"), JSON.stringify(response.data, null, 2), "utf8");
    }
  } catch (error) {
    console.error(`Failed to sync cart_response_${safeEmail}.json:`, error.message);
  }
}

async function main() {
  const config = parseArgs();
  
  if (config.help || !config.asinOrUrl) {
    console.log(`
Usage:
  node add_to_cart.js <ASIN or Product URL> [Quantity] [options]

Options:
  --email <email>     Specify Amazon email
  --headless          Run Puppeteer in headless mode
  --help, -h          Show help

Examples:
  node add_to_cart.js B0C3ZYFZ77 2
  node add_to_cart.js https://www.amazon.in/dp/B0C3ZYFZ77 3
`);
    process.exit(config.help ? 0 : 1);
  }

  const email = cookiesHelper.getActiveEmail(config.email);
  if (!email) {
    console.error("❌ Error: Active email could not be determined. Set in credentials.json or pass --email.");
    process.exit(1);
  }

  let productUrl = config.asinOrUrl.trim();
  const asin = extractAsin(productUrl);
  if (!asin) {
    console.error(`❌ Error: Invalid ASIN or URL: ${config.asinOrUrl}`);
    process.exit(1);
  }

  if (!productUrl.startsWith("http")) {
    productUrl = `https://www.amazon.in/dp/${asin}`;
  }

  // Inject Affiliate Tag if configured
  if (fs.existsSync(path.join(__dirname, "settings.json"))) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(__dirname, "settings.json"), "utf8"));
      if (settings.affiliateTag) {
        productUrl += (productUrl.includes("?") ? "&" : "?") + "tag=" + settings.affiliateTag;
      }
    } catch(e) {}
  }

  console.log(`Adding ASIN ${asin} (Qty: ${config.quantity}) to cart via browser...`);
  console.log(`Product URL: ${productUrl}`);

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: null,
    args: ["--start-maximized"]
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36");

    const cookies = await cookiesHelper.readCookies(email);
    if (cookies && cookies.length > 0) {
      await page.setCookie(...cookies);
      console.log("Injected session cookies.");
    }

    console.log("Navigating to product page...");
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    console.log("Waiting for product page layout to load...");
    
    // Check for Buy Box Accordion (Fresh vs Standard/One-time Purchase)
    const hasAccordion = await page.$("#buyBoxAccordion");
    if (hasAccordion) {
      console.log("Buy Box Accordion detected. Checking for regular (non-Fresh) buying option...");
      const toggled = await page.evaluate(() => {
        const activeRow = document.querySelector("#buyBoxAccordion .a-accordion-active, #buyBoxAccordion [class*='accordion-active']");
        if (activeRow && (activeRow.id === "almAccordionRow" || activeRow.textContent.toLowerCase().includes("fresh"))) {
          console.log("Amazon Fresh option is currently selected. Toggling to regular (One-time purchase) option...");
          
          const headers = Array.from(document.querySelectorAll("#buyBoxAccordion .accordion-header, #buyBoxAccordion .a-accordion-row"));
          const targetHeader = headers.find(h => {
            const text = h.textContent.toLowerCase();
            return (h.getAttribute("data-csa-c-slot-id") && h.getAttribute("data-csa-c-slot-id").startsWith("newAccordionRow")) ||
                   text.includes("one-time purchase") ||
                   text.includes("standard") ||
                   text.includes("ships from: amazon");
          });
          
          if (targetHeader) {
            targetHeader.click();
            return { clicked: true, target: targetHeader.textContent.trim().substring(0, 50) };
          }
        }
        return { clicked: false };
      });
      
      if (toggled && toggled.clicked) {
        console.log(`Toggled to regular buybox option: "${toggled.target}". Waiting 2.5s for page to update...`);
        await new Promise(r => setTimeout(r, 2500));
      } else {
        console.log("Regular buying option is already selected or target header not found.");
      }
    }

    // Check if quantity selector is present and select quantity if > 1
    const qtyInt = parseInt(config.quantity, 10) || 1;
    if (qtyInt > 1) {
      console.log(`Setting quantity to ${qtyInt}...`);
      
      const qtySetSuccess = await page.evaluate(async (targetQty) => {
        const changeLink = document.querySelector("a[id*='qs-widget-quantity-changelink']");
        if (changeLink) {
          changeLink.click();
          await new Promise(r => setTimeout(r, 1500));
          
          const items = Array.from(document.querySelectorAll("li.qs-widget-dropdown-item, [id*='qs-widget-dropdown-item']"));
          if (items.length > 0) {
            const optionsMap = [];
            items.forEach(item => {
              const textVal = parseInt(item.textContent.trim(), 10);
              if (!isNaN(textVal)) {
                optionsMap.push({ element: item, val: textVal });
              }
            });
            
            if (optionsMap.length > 0) {
              optionsMap.sort((a, b) => a.val - b.val);
              const maxOption = optionsMap[optionsMap.length - 1];
              
              let targetOption = optionsMap.find(opt => opt.val === targetQty);
              if (!targetOption) {
                targetOption = maxOption;
                console.log(`Target quantity ${targetQty} not available. Using max available: ${maxOption.val}`);
              }
              
              targetOption.element.click();
              return { success: true, method: "ALM", qty: targetOption.val };
            }
          }
        }
        return { success: false };
      }, qtyInt).catch(() => ({ success: false }));

      if (qtySetSuccess && qtySetSuccess.success) {
        console.log(`Set quantity to ${qtySetSuccess.qty} via ALM widget.`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        const qtySelector = await Promise.any([
          page.waitForSelector("#quantity", { timeout: 4000 }).then(() => "#quantity"),
          page.waitForSelector("select[name='quantity']", { timeout: 4000 }).then(() => "select[name='quantity']")
        ]).catch(() => null);

        if (qtySelector) {
          const selectedQty = await page.evaluate((sel, targetQty) => {
            const selectEl = document.querySelector(sel);
            if (!selectEl) return 1;
            
            const options = Array.from(selectEl.options).map(opt => parseInt(opt.value, 10)).filter(v => !isNaN(v));
            if (options.length > 0) {
              options.sort((a, b) => a - b);
              const maxVal = options[options.length - 1];
              
              const finalQty = options.includes(targetQty) ? targetQty : maxVal;
              selectEl.value = String(finalQty);
              
              const event = new Event('change', { bubbles: true });
              selectEl.dispatchEvent(event);
              
              return finalQty;
            }
            return 1;
          }, qtySelector, qtyInt).catch(() => 1);
          
          console.log(`Set quantity to ${selectedQty} in browser select (Target: ${qtyInt}).`);
        } else {
          console.log("No quantity selector found on the page.");
        }
      }
    }

    // Wait for Add to Cart button
    const addBtnSelector = await Promise.any([
      page.waitForSelector("#add-to-cart-button", { timeout: 10000 }).then(() => "#add-to-cart-button"),
      page.waitForSelector("input[name='submit.add-to-cart']", { timeout: 10000 }).then(() => "input[name='submit.add-to-cart']"),
      page.waitForSelector("#addToCart input[type='submit']", { timeout: 10000 }).then(() => "#addToCart input[type='submit']"),
      page.waitForSelector("#freshAddToCartButton input", { timeout: 10000 }).then(() => "#freshAddToCartButton input"),
      page.waitForSelector("#freshAddToCartButton", { timeout: 10000 }).then(() => "#freshAddToCartButton")
    ]).catch(() => null);

    if (!addBtnSelector) {
      console.error("\x1b[31mError: Add to Cart button not found. Please check the browser window.\x1b[0m");
      if (!config.headless) {
        console.log("Waiting 30 seconds for manual interaction if needed...");
        await new Promise(r => setTimeout(r, 30000));
      }
      try { await browser.close(); } catch(e) {}
      process.exit(1);
    }

    console.log("Clicking Add to Cart button in browser...");
    const clickResult = await page.evaluate(() => {
      const selectors = [
        "#add-to-cart-button",
        "input[name='submit.add-to-cart']",
        "#addToCart input[type='submit']",
        "#freshAddToCartButton input",
        "#freshAddToCartButton"
      ];

      const isVisible = el => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;
      };

      for (const selector of selectors) {
        const buttons = Array.from(document.querySelectorAll(selector));
        const button = buttons.find(isVisible);
        if (button) {
          button.scrollIntoView({ block: "center", inline: "center" });
          button.click();
          return { clicked: true, selector };
        }
      }
      return { clicked: false };
    });

    if (!clickResult.clicked) {
      await page.click(addBtnSelector);
    } else {
      console.log(`Clicked visible Add to Cart button: ${clickResult.selector}`);
    }

    console.log("Waiting for cart confirmation...");
    await Promise.any([
      page.waitForSelector("#NATC_SMART_WAGON_CONF_MSG_SUCCESS", { timeout: 12000 }),
      page.waitForSelector(".a-alert-success", { timeout: 12000 }),
      page.waitForSelector("#attach-added-to-cart-message", { timeout: 12000 }),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 12000 })
    ]).catch(() => {});

    console.log("Saving updated cookies...");
    const updatedCookies = await page.cookies();
    await cookiesHelper.saveCookies(email, updatedCookies);
    
    await syncCartResponse(email, await cookiesHelper.getCookieString(email));
    console.log(`\n\x1b[32m✅ Success! ASIN ${asin} added to cart.\x1b[0m\n`);
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error("❌ Cart add failed:", error.message);
    try { await browser.close(); } catch(e) {}
    process.exit(1);
  }
}

main();
