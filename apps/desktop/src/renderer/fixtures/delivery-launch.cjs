const { app, BrowserWindow, session } = require("electron");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

if (
  !process.env.MOODCODE_DESKTOP_USER_DATA ||
  process.env.MOODCODE_DESKTOP_TEST !== "1"
)
  throw new Error("The renderer fixture requires an isolated test profile.");
BrowserWindow.prototype.show = function () {};
globalThis.rendererDeliveryNetworkAttempts = 0;
globalThis.rendererDelivery = { files: [], hold: null, pending: [] };
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "file://*/*"] },
    (details, callback) => {
      if (!details.url.startsWith("file:")) {
        globalThis.rendererDeliveryNetworkAttempts++;
        callback({ cancel: true });
        return;
      }
      const file = new URL(details.url).pathname.split("/").at(-1);
      if (file?.endsWith(".js") || file?.endsWith(".css"))
        globalThis.rendererDelivery.files.push(file);
      if (
        globalThis.rendererDelivery.hold &&
        file?.startsWith(globalThis.rendererDelivery.hold)
      ) {
        globalThis.rendererDelivery.pending.push({ file, callback });
        return;
      }
      callback({});
    },
  );
});
void import(
  pathToFileURL(resolve(__dirname, "../../../dist/main/index.js")).href
);
