module.exports = {
  apps: [
    {
      name: 'bot-wasaf',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};