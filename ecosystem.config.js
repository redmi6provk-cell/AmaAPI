module.exports = {
  apps: [
    {
      name: "imap-scanner",          // PM2 process name
      script: "imap_search.js",      // File to run
      args: "--loop",                // Enable loop mode
      cwd: "./",                     // Working directory (same folder)
      instances: 1,                  // Only 1 instance
      autorestart: true,             // Restart if crashes
      watch: false,                  // Don't watch for file changes
      max_memory_restart: "200M",    // Restart if memory > 200MB

      // Environment variables
      env: {
        NODE_ENV: "production",
        IMAP_LOOP: "true",
        IMAP_POLL_INTERVAL_MS: "1800000"  // 30 minutes = 1800000 ms
      }
    }
  ]
};
