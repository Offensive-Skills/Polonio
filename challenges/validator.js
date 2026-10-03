'use strict';

const { Logger } = require('../utils/logger');

const logger = new Logger('validator');

/**
 * Validator — Automatic challenge completion verification.
 * Checks on-chain state to determine if a challenge has been solved.
 * 
 * Validation types:
 * - balance_check: Contract balance matches condition
 * - owner_changed: Contract owner has changed
 * - storage_check: Storage slot matches expected value
 * - event_emitted: Specific event was emitted
 * - contract_destroyed: Contract code is empty (selfdestruct)
 * - custom_call: Method call returns expected value
 * - token_balance: ERC20 token balance check
 */
class Validator {
  constructor(web3Provider, storageService) {
    this.web3Provider = web3Provider;
    this.storageService = storageService;
  }

  /**
   * Validate a challenge by checking its validation rules.
   * @param {string} challengeName
   * @returns {{ success, passed, message, details }}
   */
  async validateChallenge(challengeName) {
    const challenge = await this.storageService.getActiveChallenge(challengeName);
    if (!challenge) {
      return { success: false, passed: false, message: 'Challenge not active' };
    }

    // If no validation rules, we can't auto-validate
    if (!challenge.validation) {
      return {
        success: true,
        passed: null,
        message: 'No automatic validation available for this challenge',
      };
    }

    const validation = challenge.validation;
    const results = [];

    // Support single or multiple validation rules
    const rules = Array.isArray(validation) ? validation : [validation];

    for (const rule of rules) {
      const result = await this._evaluateRule(rule, challenge.contracts);
      results.push(result);
    }

    const allPassed = results.every((r) => r.passed);

    return {
      success: true,
      passed: allPassed,
      message: allPassed ? '¡Challenge completado!' : 'El reto aún no está resuelto',
      details: results,
    };
  }

  // ─── Rule Evaluators ───────────────────────────────────────────────────────

  async _evaluateRule(rule, contracts) {
    const targetContract = contracts.find((c) => c.name === rule.target);
    if (!targetContract) {
      return { passed: false, rule: rule.type, message: `Target "${rule.target}" not found` };
    }

    try {
      switch (rule.type) {
        case 'balance_check':
          return await this._checkBalance(targetContract.address, rule.condition);

        case 'owner_changed':
          return await this._checkOwnerChanged(targetContract, rule);

        case 'storage_check':
          return await this._checkStorage(targetContract.address, rule.slot, rule.expected);

        case 'event_emitted':
          return await this._checkEventEmitted(targetContract, rule.eventName);

        case 'contract_destroyed':
          return await this._checkDestroyed(targetContract.address);

        case 'custom_call':
          return await this._checkCustomCall(targetContract, rule.method, rule.args, rule.expected);

        case 'token_balance':
          return await this._checkTokenBalance(targetContract, rule);

        default:
          return { passed: false, rule: rule.type, message: `Unknown validation type: ${rule.type}` };
      }
    } catch (err) {
      logger.error(`Validation error for rule ${rule.type}:`, err);
      return { passed: false, rule: rule.type, message: err.message };
    }
  }

  async _checkBalance(address, condition) {
    const web3 = this.web3Provider.getWeb3();
    const balanceWei = BigInt(await web3.eth.getBalance(address));
    const balanceEth = web3.utils.fromWei(balanceWei.toString(), 'ether');

    let passed = false;
    const { operator, value } = this._parseCondition(condition);
    // Compare in wei to avoid floating point issues
    const expectedWei = BigInt(web3.utils.toWei(String(value), 'ether'));

    switch (operator) {
      case '==': passed = balanceWei === expectedWei; break;
      case '!=': passed = balanceWei !== expectedWei; break;
      case '>=': passed = balanceWei >= expectedWei; break;
      case '<=': passed = balanceWei <= expectedWei; break;
      case '>':  passed = balanceWei > expectedWei; break;
      case '<':  passed = balanceWei < expectedWei; break;
      default:   passed = false;
    }

    return {
      passed,
      rule: 'balance_check',
      message: passed
        ? `Balance is ${balanceEth} ETH (condition met)`
        : `Balance is ${balanceEth} ETH (condition: ${condition})`,
    };
  }

  /**
   * Parse a condition string like "== 0", "> 5", "<= 1" into operator and value.
   */
  _parseCondition(condition) {
    if (!condition) return { operator: '==', value: '0' };
    const trimmed = condition.trim();

    // Handle shorthand: "0" or "balance == 0"
    if (trimmed === '0' || trimmed === 'balance == 0') {
      return { operator: '==', value: '0' };
    }

    // Match operator and value: supports ==, !=, >=, <=, >, <
    const match = trimmed.match(/^(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (match) {
      return { operator: match[1], value: match[2].trim() };
    }

    // Fallback: try to extract just a number (assume == 0)
    return { operator: '==', value: '0' };
  }

  async _checkOwnerChanged(targetContract, rule) {
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(targetContract.abi, targetContract.address);

    try {
      const currentOwner = await contract.methods.owner().call();
      const accounts = await this.web3Provider.getAccounts();
      const deployer = accounts[0];

      // Owner has changed if it's no longer the deployer
      const changed = currentOwner.toLowerCase() !== deployer.toLowerCase();
      
      // If a specific newOwner is required
      let passed = changed;
      if (rule.newOwner) {
        if (rule.newOwner === 'attacker' || rule.newOwner === 'player') {
          // Player account is typically accounts[1]
          passed = currentOwner.toLowerCase() === accounts[1].toLowerCase();
        } else {
          passed = currentOwner.toLowerCase() === rule.newOwner.toLowerCase();
        }
      }

      return {
        passed,
        rule: 'owner_changed',
        message: passed
          ? `Ownership transferred to ${currentOwner}`
          : `Owner is still ${currentOwner}`,
      };
    } catch (err) {
      return { passed: false, rule: 'owner_changed', message: `Cannot read owner: ${err.message}` };
    }
  }

  async _checkStorage(address, slot, expected) {
    const web3 = this.web3Provider.getWeb3();
    const value = await web3.eth.getStorageAt(address, slot);
    const passed = value.toLowerCase() === expected.toLowerCase();

    return {
      passed,
      rule: 'storage_check',
      message: passed
        ? `Storage slot ${slot} matches expected value`
        : `Storage slot ${slot} is ${value}, expected ${expected}`,
    };
  }

  async _checkEventEmitted(targetContract, eventName) {
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(targetContract.abi, targetContract.address);

    try {
      const events = await contract.getPastEvents(eventName, {
        fromBlock: 0,
        toBlock: 'latest',
      });
      const passed = events.length > 0;

      return {
        passed,
        rule: 'event_emitted',
        message: passed
          ? `Event "${eventName}" was emitted ${events.length} time(s)`
          : `Event "${eventName}" has not been emitted`,
      };
    } catch {
      return { passed: false, rule: 'event_emitted', message: `Event "${eventName}" not found in ABI` };
    }
  }

  async _checkDestroyed(address) {
    const web3 = this.web3Provider.getWeb3();
    const code = await web3.eth.getCode(address);
    const passed = code === '0x' || code === '0x0';

    return {
      passed,
      rule: 'contract_destroyed',
      message: passed
        ? 'Contract has been destroyed'
        : 'Contract is still alive',
    };
  }

  async _checkCustomCall(targetContract, method, args = [], expected) {
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(targetContract.abi, targetContract.address);
    const accounts = await this.web3Provider.getAccounts();

    const result = await contract.methods[method](...(args || [])).call({ from: accounts[1] });
    const resultStr = String(result).toLowerCase();
    const expectedStr = String(expected).toLowerCase();
    const passed = resultStr === expectedStr;

    return {
      passed,
      rule: 'custom_call',
      message: passed
        ? `${method}() returned expected value: ${result}`
        : `${method}() returned ${result}, expected ${expected}`,
    };
  }

  async _checkTokenBalance(targetContract, rule) {
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(targetContract.abi, targetContract.address);
    const accounts = await this.web3Provider.getAccounts();

    const targetAddress = rule.holder === 'player' ? accounts[1] : rule.holder;
    const balance = await contract.methods.balanceOf(targetAddress).call();
    const balanceBig = BigInt(balance.toString());

    const { operator, value } = this._parseCondition(rule.condition);
    const expectedBig = BigInt(value);

    let passed = false;
    switch (operator) {
      case '==': passed = balanceBig === expectedBig; break;
      case '!=': passed = balanceBig !== expectedBig; break;
      case '>=': passed = balanceBig >= expectedBig; break;
      case '<=': passed = balanceBig <= expectedBig; break;
      case '>':  passed = balanceBig > expectedBig; break;
      case '<':  passed = balanceBig < expectedBig; break;
      default:   passed = false;
    }

    return {
      passed,
      rule: 'token_balance',
      message: passed
        ? `Token balance of ${targetAddress}: ${balance} (condition met)`
        : `Token balance of ${targetAddress}: ${balance} (condition: ${rule.condition})`,
    };
  }
}

module.exports = { Validator };
