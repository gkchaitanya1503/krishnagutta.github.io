module.exports = {
  apps: [
    {
      name: 'workday-mcp',
      script: 'server.mjs',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT ?? 4000,
        ADMIN_KEY: process.env.ADMIN_KEY ?? 'change-this-to-a-secret',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/server-out.log',
      error_file: './logs/server-err.log',
      merge_logs: true,
    },
  ],
};
