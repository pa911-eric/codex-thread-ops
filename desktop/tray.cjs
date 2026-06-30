const path = require("path");
const { clipboard, nativeImage } = require("electron");

function createTrayController({
  app,
  Menu,
  Tray,
  shell,
  iconPath,
  baseUrl,
  getWindow,
  createWindow,
  settings,
  saveSettings,
  getStartAtLogin,
  setStartAtLogin,
  logsDir,
  logger,
  quit,
}) {
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("AgentQueue");

  function openWindow(route = "/") {
    let window = getWindow();
    if (!window || window.isDestroyed()) window = createWindow(route);
    else window.loadURL(new URL(route, baseUrl).toString());
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  function rebuildMenu() {
    const startAtLogin = getStartAtLogin(app);
    const menu = Menu.buildFromTemplate([
      { label: "Open AgentQueue", click: () => openWindow("/") },
      { type: "separator" },
      {
        label: "Start at login",
        type: "checkbox",
        checked: startAtLogin,
        click: (item) => {
          setStartAtLogin(app, item.checked);
          settings.startAtLogin = item.checked;
          saveSettings(settings);
          rebuildMenu();
        },
      },
      { label: "Open in browser", click: () => shell.openExternal(baseUrl) },
      { label: "Diagnostics", click: () => shell.openExternal(new URL("/health", baseUrl).toString()) },
      { label: "Open logs folder", click: () => shell.openPath(logsDir).then((error) => error && logger?.warn("Failed to open logs folder", error)) },
      { label: "Copy local URL", click: () => clipboard.writeText(baseUrl) },
      { type: "separator" },
      { label: "Quit", click: quit },
    ]);
    tray.setContextMenu(menu);
  }

  tray.on("click", () => openWindow("/"));
  tray.on("double-click", () => openWindow("/"));
  rebuildMenu();

  return { tray, openWindow, rebuildMenu };
}

module.exports = { createTrayController };
