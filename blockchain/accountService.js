'use strict';

const { Logger } = require('../utils/logger');

const logger = new Logger('accounts');

/**
 * AccountService — Provides account-related operations.
 */
class AccountService {
  constructor(web3Provider) {
    this.web3Provider = web3Provider;
  }

  /**
   * Get all accounts.
   */
  async getAccounts() {
    return this.web3Provider.getAccounts();
  }

  /**
   * Get balance of a specific account in ETH.
   */
  async getBalance(address) {
    return this.web3Provider.getBalance(address);
  }

  /**
   * Get all accounts with their balances.
   */
  async getAccountsWithBalance() {
    const accounts = await this.getAccounts();
    const result = [];
    for (const address of accounts) {
      const balance = await this.getBalance(address);
      result.push({ address, balance });
    }
    return result;
  }

  /**
   * Get account at specific index.
   */
  async getAccountByIndex(index) {
    const accounts = await this.getAccounts();
    if (index >= accounts.length) {
      throw new Error(`Account index ${index} out of range (${accounts.length} accounts available)`);
    }
    return accounts[index];
  }
}

module.exports = { AccountService };
