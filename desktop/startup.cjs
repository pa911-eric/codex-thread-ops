const fs = require("fs");
const path = require("path");

function settingsPath(app) {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

function readDesktopSettings(app) {
  try {
    return {
      startAtLogin: false,
      windowBounds: null,
      ...JSON.parse(fs.readFileSync(settingsPath(app), "utf8")),
    };
  } catch {
    return { startAtLogin: false, windowBounds: null };
  }
}

function writeDesktopSettings(app, settings) {
  const target = settingsPath(app);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
}

function loginItemArgs(app) {
  return app.isPackaged ? [] : [app.getAppPath()];
}

function getStartAtLogin(app) {
  return Boolean(app.getLoginItemSettings({ path: process.execPath, args: loginItemArgs(app) }).openAtLogin);
}

function setStartAtLogin(app, enabled) {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: loginItemArgs(app),
  });
}

module.exports = {
  readDesktopSettings,
  writeDesktopSettings,
  getStartAtLogin,
  setStartAtLogin,
};
