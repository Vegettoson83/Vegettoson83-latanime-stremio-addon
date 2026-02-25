module.exports = {
  apps: [
    {
      name: 'addon',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 10000,
        BRIDGE_URL: 'http://localhost:3001',
        SB_API_KEY: 'NH2KPNLILIPE8RX3VZUPAK3EDO78TQIGZUYG6U4WHHHUOHZSGP02AMNZY1WS00B01HJTCQFIEM2LN0B5',
      },
    },
    {
      name: 'bridge',
      script: 'bridge-server.js',
      env: {
        NODE_ENV: 'production',
        BRIDGE_PORT: 3001,
        PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
      },
    },
  ],
};
