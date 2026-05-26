module.exports = {
  apps: [
    {
      name: 'greenmail-manager',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        TCP_PORT: 3888,
        DATA_DIR: './data',
        TZ: 'Asia/Shanghai',
      },
    },
  ],
};
