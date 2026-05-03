module.exports = {
  apps: [
    {
      name: "addon",
      script: "./dist/server.js",
      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
