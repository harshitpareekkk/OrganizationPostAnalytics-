export const LOG_LEVELS = {
    INFO: "info",
    ERROR: "error",
    DEBUG: "debug",
    WARN: "warn"
  };

  function formatMessage(level, message) {
  const timestamp = new Date().toISOString();
  if (typeof message == "object") {
    message = JSON.stringify(message, null, 2);
  }
  return `[${timestamp}] [${level.toUpperCase()}]: ${message}`;
}

export const logger = {
  info: (msg) => {
    console.info(formatMessage(LOG_LEVELS.INFO, msg));
  },
  error: (msg) => {
    console.error(formatMessage(LOG_LEVELS.ERROR, msg));
  },
  debug: (msg) => {
    console.debug(formatMessage(LOG_LEVELS.DEBUG, msg));
  },
  warn: (msg) => {
    console.warn(formatMessage(LOG_LEVELS.WARN, msg));
  },
};