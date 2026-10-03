'use strict';

const { Web3 } = require('web3');
const { Logger } = require('../utils/logger');

const logger = new Logger('web3');

/**
 * Web3Provider — Manages the Web3 instance and connection to the blockchain node.
 * Handles reconnection and instance lifecycle.
 */
class Web3Provider {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl || 'http://127.0.0.1:8545';
    this.timeout = options.timeout || 30000;
    this._web3 = null;
    this._connected = false;
  }

  /**
   * Connect to the blockchain node.
   */
  async connect(rpcUrl = null) {
    if (rpcUrl) this.rpcUrl = rpcUrl;

    // web3 v4: HttpProvider takes the URL; request options are passed under
    // `providerOptions`. The connect() retry loop below handles slow startup.
    const provider = new Web3.providers.HttpProvider(this.rpcUrl);
    this._web3 = new Web3(provider);

    // Verify connection
    let attempts = 0;
    const maxAttempts = 10;
    while (attempts < maxAttempts) {
      try {
        await this._web3.eth.getChainId();
        this._connected = true;
        logger.info(`Connected to ${this.rpcUrl}`);
        return;
      } catch (err) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error(`Cannot connect to ${this.rpcUrl} after ${maxAttempts} attempts`);
        }
        await this._sleep(1000);
      }
    }
  }

  /**
   * Disconnect and invalidate the instance.
   */
  disconnect() {
    // web3 v4's HttpProvider exposes disconnect() but throws
    // MethodNotImplementedError when called (it is stateless HTTP, nothing to
    // close). Attempt it only for providers that actually support it.
    const provider = this._web3 && this._web3.currentProvider;
    if (provider && typeof provider.disconnect === 'function') {
      try {
        provider.disconnect();
      } catch (_err) {
        // HTTP provider — no persistent connection to tear down.
      }
    }
    this._web3 = null;
    this._connected = false;
    logger.info('Disconnected');
  }

  /**
   * Get the Web3 instance. Throws if not connected.
   */
  getWeb3() {
    if (!this._web3 || !this._connected) {
      throw new Error('Web3 not connected. Start the blockchain first.');
    }
    return this._web3;
  }

  /**
   * Check if connected (with optional live check).
   */
  isConnected() {
    return this._connected && this._web3 !== null;
  }

  /**
   * Verify the connection is still alive by making a lightweight RPC call.
   * Marks as disconnected if the node is unreachable.
   * @returns {boolean} true if alive, false if disconnected
   */
  async checkHealth() {
    if (!this._web3 || !this._connected) return false;
    try {
      await this._web3.eth.getChainId();
      return true;
    } catch {
      this._connected = false;
      logger.warn('Health check failed — node unreachable, marking as disconnected');
      return false;
    }
  }

  /**
   * Get current block number.
   */
  async getBlockNumber() {
    const web3 = this.getWeb3();
    // web3 v4 returns a BigInt — normalize to Number for display/IPC.
    return Number(await web3.eth.getBlockNumber());
  }

  /**
   * Get accounts.
   */
  async getAccounts() {
    const web3 = this.getWeb3();
    return web3.eth.getAccounts();
  }

  /**
   * Get balance in ETH.
   */
  async getBalance(address) {
    const web3 = this.getWeb3();
    const balanceWei = await web3.eth.getBalance(address);
    return web3.utils.fromWei(balanceWei.toString(), 'ether');
  }

  /**
   * Get storage at slot.
   */
  async getStorageAt(address, slot) {
    const web3 = this.getWeb3();
    return web3.eth.getStorageAt(address, slot);
  }

  /**
   * Get code at address.
   */
  async getCode(address) {
    const web3 = this.getWeb3();
    return web3.eth.getCode(address);
  }

  /**
   * Get transaction receipt.
   */
  async getTransactionReceipt(txHash) {
    const web3 = this.getWeb3();
    return web3.eth.getTransactionReceipt(txHash);
  }

  /**
   * Send ETH from one account to another.
   */
  async sendEth(from, to, amountEth) {
    const web3 = this.getWeb3();
    const amountWei = web3.utils.toWei(String(amountEth), 'ether');
    return web3.eth.sendTransaction({ from, to, value: amountWei });
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { Web3Provider };
