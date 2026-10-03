'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Logger — Simple structured logger with levels and file output.
 */
class Logger {
  constructor(module) {
    this.module = module;
    this._logDir = path.join(os.homedir(), '.local', 'share', 'polonio', 'logs');
    this._ensureDir(this._logDir);
  }

  info(message, data = null) {
    this._log('INFO', message, data);
  }

  warn(message, data = null) {
    this._log('WARN', message, data);
  }

  error(message, data = null) {
    this._log('ERROR', message, data);
  }

  debug(message, data = null) {
    if (process.env.NODE_ENV === 'development') {
      this._log('DEBUG', message, data);
    }
  }

  _log(level, message, data) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.module}]`;
    const logMessage = data
      ? `${prefix} ${message} ${JSON.stringify(data, this._replacer)}`
      : `${prefix} ${message}`;

    // Console output
    switch (level) {
      case 'ERROR':
        console.error(logMessage);
        break;
      case 'WARN':
        console.warn(logMessage);
        break;
      default:
        console.log(logMessage);
    }

    // File output
    this._writeToFile(logMessage);
  }

  _writeToFile(message) {
    try {
      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(this._logDir, `polonio-${date}.log`);
      fs.appendFileSync(logFile, message + '\n', 'utf-8');
    } catch {
      // Silently fail file logging
    }
  }

  _replacer(key, value) {
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack };
    }
    return value;
  }

  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

module.exports = { Logger };
