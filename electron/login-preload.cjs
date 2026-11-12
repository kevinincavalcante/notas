const { contextBridge, ipcRenderer } = require("electron");

// Janela de login do desktop: só o envio do formulário passa por aqui.
contextBridge.exposeInMainWorld("notasLogin", {
  submit: (data) => ipcRenderer.invoke("login-submit", data),
});
