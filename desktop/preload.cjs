const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("agentQueueDesktop", {
  isDesktop: true,
});
