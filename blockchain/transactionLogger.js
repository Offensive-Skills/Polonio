'use strict';

const { Logger } = require('../utils/logger');

const logger = new Logger('transactions');

/**
 * TransactionLogger — Records all transactions for the session.
 * Provides history and real-time notifications to the renderer.
 */
class TransactionLogger {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this._history = [];
    this._maxHistory = 1000;
  }

  /**
   * Log a contract interaction.
   */
  log(request, response) {
    const entry = {
      id: this._history.length + 1,
      timestamp: new Date().toISOString(),
      type: response.type || 'unknown',
      method: request.signature || request.methodName,
      contractAddress: request.address,
      args: request.args || request.argsArray || [],
      accountIndex: request.accountIndex != null ? request.accountIndex : 1,
      success: response.success !== false,
      result: response.result || null,
      error: response.error || null,
    };

    this._addEntry(entry);
  }

  /**
   * Log a deployment.
   */
  logDeploy(request, response) {
    const entry = {
      id: this._history.length + 1,
      timestamp: new Date().toISOString(),
      type: 'deploy',
      contractName: response.contractName || request.title,
      contractAddress: response.address,
      success: response.success !== false,
      transactionHash: response.transactionHash || null,
      error: response.error || null,
    };

    this._addEntry(entry);
  }

  /**
   * Get transaction history.
   */
  getHistory() {
    return this._history;
  }

  /**
   * Clear transaction history.
   */
  clear() {
    this._history = [];
  }

  _addEntry(entry) {
    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    // Notify renderer
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('transactions:new', entry);
    }
  }
}

module.exports = { TransactionLogger };
