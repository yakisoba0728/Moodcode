const { app, BrowserWindow, session } = require('electron');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

if (process.env.MOODCODE_DESKTOP_TEST !== '1' || !process.env.MOODCODE_DESKTOP_USER_DATA || !process.env.CODEX_HOME)
  throw new Error('Anthropic fixture requires an isolated profile and Codex home.');
BrowserWindow.prototype.show = function () {};
globalThis.anthropicRendererNetworkAttempts = 0;
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
    globalThis.anthropicRendererNetworkAttempts++;
    callback({ cancel: true });
  },
));
void import(pathToFileURL(resolve(__dirname, '../../../dist/main/index.js')).href);
