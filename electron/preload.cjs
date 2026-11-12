const { contextBridge, ipcRenderer } = require("electron");

/**
 * Ponte segura (contextIsolation). No web, window.notasDesktop não existe —
 * esses recursos ficam só no desktop:
 *   - onTabCommand: atalhos de aba do menu nativo (Ctrl+N/W/Tab)
 *   - syncNow: dispara um ciclo de sync imediato
 *   - onSyncStatus: status do laço de sync (30s + backoff) — alimenta o
 *     indicador e recarrega a lista quando o pull traz mudanças
 */
contextBridge.exposeInMainWorld("notasDesktop", {
  onTabCommand: (callback) => {
    ipcRenderer.on("tabs-command", (_event, cmd) => callback(cmd));
  },
  syncNow: () => ipcRenderer.invoke("sync-now"),
  onSyncStatus: (callback) => {
    ipcRenderer.on("sync-status", (_event, status) => callback(status));
  },
});
