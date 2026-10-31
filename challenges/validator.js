'use strict';

const { Logger } = require('../utils/logger');
const { createResolver } = require('./references');

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
 * - call_reverts: Simulated transaction reverts (e.g. a denial of service)
 *
 * Arguments, accounts and expected values accept the references described in
 * references.js ("$player", "$contract:Name", "$ether:1", ...).
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

    const web3 = this.web3Provider.getWeb3();
    const accounts = await this.web3Provider.getAccounts();
    const resolve = createResolver({ web3, accounts, contracts: challenge.contracts });

    for (const rule of rules) {
      const result = await this._evaluateRule(rule, challenge.contracts, resolve);
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

  async _evaluateRule(rule, contracts, resolve) {
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
          return await this._checkCustomCall(targetContract, rule, resolve);

        case 'token_balance':
          return await this._checkTokenBalance(targetContract, rule, resolve);

        case 'call_reverts':
          return await this._checkCallReverts(targetContract, rule, resolve);

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

  async _checkCustomCall(targetContract, rule, resolve) {
    const { method } = rule;
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(targetContract.abi, targetContract.address);
    if (typeof contract.methods[method] !== 'function') {
      return { passed: false, rule: 'custom_call', message: `Method "${method}" not found` };
    }

    const args = resolve(rule.args || []);
    const from = resolve(rule.from || '$player');
    const expected = resolve(rule.expected);

    const result = await contract.methods[method](...args).call({ from });
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

  /**
   * Passes when simulating the transaction reverts. Rule fields:
   *   method, args, from (default "$player") and value, which is either an
   *   ether amount ("1", "$ether:1") or { "view": "<fn>", "add": "<wei>" } to
   *   use the result of a view function of the target plus an offset in wei.
   * The sender's balance is overridden in the simulation, so only an EVM
   * revert counts as success (never a lack of funds or an RPC failure).
   */
  async _checkCallReverts(targetContract, rule, resolve) {
    const { method } = rule;
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(targetContract.abi, targetContract.address);
    if (typeof contract.methods[method] !== 'function') {
      return { passed: false, rule: 'call_reverts', message: `Method "${method}" not found` };
    }

    const from = resolve(rule.from || '$player');
    const data = contract.methods[method](...resolve(rule.args || [])).encodeABI();

    let valueWei = 0n;
    if (rule.value && typeof rule.value === 'object') {
      const base = await contract.methods[rule.value.view]().call();
      valueWei = BigInt(base) + BigInt(rule.value.add || 0);
    } else if (rule.value !== undefined) {
      const resolved = resolve(String(rule.value));
      valueWei = String(rule.value).startsWith('$')
        ? BigInt(resolved)
        : BigInt(web3.utils.toWei(String(rule.value), 'ether'));
    }

    const tx = {
      from,
      to: targetContract.address,
      data,
      value: '0x' + valueWei.toString(16),
    };
    const overrides = { [from]: { balance: '0x' + (valueWei + 10n ** 24n).toString(16) } };

    try {
      await web3.requestManager.send({ method: 'eth_call', params: [tx, 'latest', overrides] });
    } catch (err) {
      if (this._isRevert(err)) {
        return {
          passed: true,
          rule: 'call_reverts',
          message: `${method}() reverts as expected`,
        };
      }
      throw err;
    }

    return {
      passed: false,
      rule: 'call_reverts',
      message: `${method}() still succeeds`,
    };
  }

  _isRevert(err) {
    const inner = (err && (err.innerError || err.error || err.data)) || {};
    const code = err.code ?? inner.code;
    const message = `${err.message || ''} ${inner.message || ''}`;
    return code === 3 || /revert/i.test(message);
  }

  async _checkTokenBalance(targetContract, rule, resolve) {
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(targetContract.abi, targetContract.address);

    // "player" is kept for backwards compatibility with older metadata
    const targetAddress = rule.holder === 'player' ? resolve('$player') : resolve(rule.holder);
    const balance = await contract.methods.balanceOf(targetAddress).call();
    const balanceBig = BigInt(balance.toString());

    const { operator, value } = this._parseCondition(rule.condition);
    const expectedBig = BigInt(resolve(value));

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
