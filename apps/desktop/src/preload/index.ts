import { contextBridge, ipcRenderer } from 'electron';
import { createDesktopApi } from './api.js';

contextBridge.exposeInMainWorld('moodcode', createDesktopApi({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
}));
