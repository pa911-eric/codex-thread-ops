const fs = require("fs");
const path = require("path");

function createLogger(app) {
  const logsDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `agentqueue-desktop-${new Date().toISOString().slice(0, 10)}.log`);

  function write(level, message, details = null) {
    const line = {
      at: new Date().toISOString(),
      level,
      message,
      details: details instanceof Error ? { message: details.message, stack: details.stack } : details,
    };
    fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`, "utf8");
  }

  return {
    logsDir,
    logPath,
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}

module.exports = { createLogger };
