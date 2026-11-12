const { contextBridge, ipcRenderer } = require("electron");

/**
 * Ponte segura (contextIsolation): expõe apenas o canal de comandos de aba.
 * No web, window.notasDesktop não existe — os atalhos ficam só no desktop.
 */
contextBridge.exposeInMainWorld("notasDesktop", {
  onTabCommand: (callback) => {
    ipcRenderer.on("tabs-command", (_event, cmd) => callback(cmd));
  },
});
