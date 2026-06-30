const path = require("path");
const { BrowserWindow } = require("electron");

function isLocalHttpUrl(value, baseUrl) {
  try {
    const url = new URL(value);
    const base = new URL(baseUrl);
    return url.protocol === base.protocol && url.host === base.host;
  } catch {
    return false;
  }
}

function shouldOpenExternally(value, baseUrl) {
  if (!value) return false;
  if (isLocalHttpUrl(value, baseUrl)) return false;
  return /^(https?:|file:|codex:|mailto:)/i.test(value);
}

function cleanBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 720 || height < 480) return null;
  return {
    x: Number.isFinite(Number(bounds.x)) ? Number(bounds.x) : undefined,
    y: Number.isFinite(Number(bounds.y)) ? Number(bounds.y) : undefined,
    width,
    height,
  };
}

function createDashboardWindow({ app, shell, baseUrl, route = "/", settings, saveSettings, iconPath, logger }) {
  const bounds = cleanBounds(settings.windowBounds);
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: "#0f172a",
    icon: iconPath,
    ...(bounds || {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  let saveTimer = null;
  function scheduleBoundsSave() {
    if (window.isDestroyed() || window.isMinimized()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      settings.windowBounds = window.getBounds();
      saveSettings(settings);
    }, 400);
  }

  window.on("resize", scheduleBoundsSave);
  window.on("move", scheduleBoundsSave);
  window.on("close", (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    window.hide();
  });
  window.once("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocalHttpUrl(url, baseUrl)) return { action: "allow" };
    shell.openExternal(url).catch((error) => logger?.error("Failed to open external URL", error));
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!shouldOpenExternally(url, baseUrl)) return;
    event.preventDefault();
    shell.openExternal(url).catch((error) => logger?.error("Failed to open navigation URL", error));
  });

  window.loadURL(new URL(route, baseUrl).toString());
  return window;
}

module.exports = { createDashboardWindow };
