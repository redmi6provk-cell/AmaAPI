const puppeteer = require("puppeteer");

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36");
    
    const url = "https://www.amazon.in/dp/B086T4WGRY";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    
    const buttons = await page.evaluate(() => {
      const results = [];
      const elements = Array.from(document.querySelectorAll("input[type='submit'], input[type='button'], button, a.a-button-text, span.a-button"));
      for (const el of elements) {
        const text = el.textContent.trim() || el.value || "";
        const id = el.id || "";
        const name = el.getAttribute("name") || "";
        const className = el.className || "";
        
        if (text.toLowerCase().includes("add") || text.toLowerCase().includes("cart") || id.toLowerCase().includes("add") || name.toLowerCase().includes("add")) {
          // Check if visible
          const rect = el.getBoundingClientRect();
          const isVisible = rect.width > 0 && rect.height > 0;
          
          results.push({
            tagName: el.tagName,
            id,
            name,
            className,
            text: text.substring(0, 100),
            isVisible,
            html: el.outerHTML.substring(0, 300)
          });
        }
      }
      return results;
    });
    
    console.log("Visible Add/Cart elements:");
    console.log(JSON.stringify(buttons.filter(b => b.isVisible), null, 2));
    
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await browser.close();
  }
}

main();
