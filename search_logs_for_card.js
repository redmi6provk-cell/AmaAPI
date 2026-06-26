const fs = require("fs");
const path = require("path");

const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  console.error("Logs directory not found.");
  process.exit(1);
}

const files = fs.readdirSync(logsDir).filter(f => f.startsWith("pipeline_") && f.endsWith(".log"));
console.log(`Scanning ${files.length} log files for card-related keywords...`);

for (const file of files) {
  const filePath = path.join(logsDir, file);
  const buffer = fs.readFileSync(filePath);
  
  // Try decoding as UTF-16LE first, then fallback to UTF-8
  let content = buffer.toString("utf16le");
  if (!content.includes("STARTING") && !content.includes("Step")) {
    content = buffer.toString("utf8");
  }
  
  if (content.toLowerCase().includes("card") || content.toLowerCase().includes("selectpayment") || content.toLowerCase().includes("instrumentid")) {
    console.log(`\n📄 Matches in: ${file}`);
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes("card") || line.toLowerCase().includes("payment") || line.toLowerCase().includes("instrumentid")) {
        console.log(`  [Line ${idx + 1}]: ${line.trim()}`);
      }
    });
  }
}
