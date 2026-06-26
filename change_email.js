const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const scriptPath = path.join(__dirname, 'src', 'change_amazon_email.js');

console.log(`🚀 Starting Amazon Email Domain Conversion Automation...`);
console.log(`Running script: ${scriptPath}`);
console.log(`Arguments passed: ${args.join(' ')}\n`);

const child = spawn('node', [scriptPath, ...args], {
  shell: false,
  stdio: 'inherit'
});

child.on('close', (code) => {
  console.log(`\n🏁 Execution finished with exit code ${code}`);
});
