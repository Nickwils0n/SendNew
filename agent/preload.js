const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sendnew", {
  login: (username, password) => ipcRenderer.invoke("auth:login", { username, password }),
  checkPermissions: () => ipcRenderer.invoke("permissions:check"),
});
