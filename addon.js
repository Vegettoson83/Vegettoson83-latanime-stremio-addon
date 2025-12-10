const { addonBuilder } = require("stremio-addon-sdk");
const manifest = require("./lib/manifest");
const { defineHandlers } = require("./lib/handlers");

const builder = new addonBuilder(manifest);
defineHandlers(builder);

module.exports = builder.getInterface();
