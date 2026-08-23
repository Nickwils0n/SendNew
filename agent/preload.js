const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sendnew", {
  login: (username, password) => ipcRenderer.invoke("auth:login", { username, password }),
  checkPermissions: () => ipcRenderer.invoke("permissions:check"),
  openFullDiskAccessSettings: () => ipcRenderer.invoke("permissions:openFullDiskAccess"),
  openAutomationSettings: () => ipcRenderer.invoke("permissions:openAutomation"),
  getStatus: () => ipcRenderer.invoke("status:get"),
  onStatusUpdate: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("status:update", handler);
    return () => ipcRenderer.removeListener("status:update", handler);
  },
  onTraffic: (callback) => {
    const handler = (_event, entry) => callback(entry);
    ipcRenderer.on("status:traffic", handler);
    return () => ipcRenderer.removeListener("status:traffic", handler);
  },
});
