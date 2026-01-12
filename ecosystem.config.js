module.exports = {
  apps: [
    {
      name: 'addon',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 10000,
        BRIDGE_URL: 'http://localhost:3001',
      },
    },
    {
      name: 'bridge',
      script: 'bridge-server.js',
      env: {
        NODE_ENV: 'production',
        BRIDGE_PORT: 3001,
      },
    },
  ],
};
