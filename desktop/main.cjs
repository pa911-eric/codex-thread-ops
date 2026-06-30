const path = require("path");
const { app, dialog, Menu, shell, Tray } = require("electron");
const { startAgentQueueServer } = require("../server");
const { createLogger } = require("./logging.cjs");
const { readDesktopSettings, writeDesktopSettings, getStartAtLogin, setStartAtLogin } = require("./startup.cjs");
const { createDashboardWindow } = require("./windows.cjs");
const { createTrayController } = require("./tray.cjs");

let serverHandle = null;
let mainWindow = null;
let trayController = null;
let logger = null;
let settings = null;

function appIconPath() {
  return path.join(__dirname, "assets", "app.png");
}

function saveSettings(nextSettings) {
  settings = nextSettings;
  writeDesktopSettings(app, settings);
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/health", baseUrl));
      if (response.ok) return true;
      lastError = new Error(`Health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error("AgentQueue health check timed out");
}

function createWindow(route = "/") {
  mainWindow = createDashboardWindow({
    app,
    shell,
    baseUrl: serverHandle.url,
    route,
    settings,
    saveSettings,
    iconPath: appIconPath(),
    logger,
  });
  return mainWindow;
}

async function startDesktopApp() {
  logger = createLogger(app);
  settings = readDesktopSettings(app);
  setStartAtLogin(app, Boolean(settings.startAtLogin));

  serverHandle = await startAgentQueueServer({
    host: "127.0.0.1",
    openOnStart: false,
    log: (message) => logger.info(message),
  });
  await waitForHealth(serverHandle.url);
  logger.info("AgentQueue desktop server is healthy", { url: serverHandle.url });

  trayController = createTrayController({
    app,
    Menu,
    Tray,
    shell,
    iconPath: appIconPath(),
    baseUrl: serverHandle.url,
    getWindow: () => mainWindow,
    createWindow,
    settings,
    saveSettings,
    getStartAtLogin,
    setStartAtLogin,
    logsDir: logger.logsDir,
    logger,
    quit: () => {
      app.isQuitting = true;
      app.quit();
    },
  });
  trayController.openWindow("/");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (trayController) trayController.openWindow("/");
    else if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on("before-quit", async (event) => {
    if (app.isQuittingFinished) return;
    app.isQuitting = true;
    if (!serverHandle) return;
    event.preventDefault();
    try {
      await serverHandle.close();
    } catch (error) {
      logger?.error("Failed to close AgentQueue server", error);
    } finally {
      app.isQuittingFinished = true;
      app.quit();
    }
  });

  app.whenReady().then(startDesktopApp).catch((error) => {
    logger?.error("AgentQueue desktop failed to start", error);
    dialog.showErrorBox("AgentQueue failed to start", error.stack || error.message);
    app.quit();
  });

  app.on("activate", () => {
    if (trayController) trayController.openWindow("/");
  });
}
