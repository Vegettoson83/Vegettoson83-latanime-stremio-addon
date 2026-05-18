module.exports = {
  apps: [
    {
      name: 'addon',
      script: 'dist/server.js',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3000,
        BRIDGE_URL: `http://localhost:3001`,
        BRIDGE_TOKEN: process.env.BRIDGE_TOKEN
      }
    },
    {
      name: 'bridge',
      script: 'bridge-server.js',
      env: {
        NODE_ENV: 'production',
        PORT_BRIDGE: 3001,
        BRIDGE_TOKEN: process.env.BRIDGE_TOKEN
      }
    }
  ]
};
