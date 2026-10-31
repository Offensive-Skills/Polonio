'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Logger } = require('../utils/logger');
const { createResolver } = require('./references');

const logger = new Logger('challenge-engine');

// API Base URL
const API_BASE = 'https://polonio.offs.es';

/**
 * ChallengeEngine — Orchestrates the full lifecycle of challenges:
 * - Fetching challenge data from API
 * - Downloading contract sources
 * - Deploying multi-contract challenges in order
 * - Managing challenge state
 * - Providing hints
 */
class ChallengeEngine {
  constructor(contractService, storageService, authController) {
    this.contractService = contractService;
    this.storageService = storageService;
    this.authController = authController;
  }

  /**
   * List challenges by difficulty level.
   */
  async listChallenges(level, token) {
    const response = await this._apiPost('/getChallenges', { token, level });
    return response;
  }

  /**
   * Get challenge image as base64.
   */
  async getChallengeImage(challengeName, token) {
    const response = await fetch(`${API_BASE}/getImageChallenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, challenge_name: challengeName }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get image: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const contentType = response.headers.get('content-type') || 'image/png';
    return `data:${contentType};base64,${base64}`;
  }

  /**
   * Get smartcontracts list for a challenge.
   */
  async getSmartcontracts(challengeName, token) {
    return this._apiPost('/getSmartcontracts', { token, challenge_name: challengeName });
  }

  /**
   * Get contract source code.
   */
  async getContractCode(challengeName, scName, token) {
    return this._apiPost('/getSmartContract', {
      token,
      challenge_name: challengeName,
      smartcontract_name: scName,
    });
  }

  /**
   * Get writeup content.
   */
  async getWriteup(challengeName, token) {
    return this._apiPost('/getWriteup', { token, challenge_name: challengeName });
  }

  /**
   * Mark/unmark challenge as complete via API.
   */
  async completeChallenge(challengeName, complete, token) {
    return this._apiPost('/completeChallenge', {
      token,
      challenge_name: challengeName,
      complete,
    });
  }

  /**
   * Activate a challenge: download sources and metadata, deploy contracts in
   * order and run the setup actions from metadata.json.
   * If anything fails, the contracts deployed by this activation are removed
   * from the registry and the challenge is not marked as active.
   */
  async activateChallenge(challengeName, token) {
    logger.info(`Activating challenge: ${challengeName}`);

    // 1. Fetch smartcontract definitions from API
    const smartContracts = await this.getSmartcontracts(challengeName, token);
    if (!Array.isArray(smartContracts) || smartContracts.length === 0) {
      throw new Error('No smartcontracts found for this challenge');
    }

    // A new activation replaces any previous deployment of the same challenge
    this.storageService.removeDeployedContractsForChallenge(challengeName);

    // 2. Download each contract source
    const challengeDir = this.storageService.getChallengeDir(challengeName);
    for (const sc of smartContracts) {
      const codeResponse = await this.getContractCode(challengeName, sc.name, token);
      const code = codeResponse.contract;
      // basename() keeps the contract name as a single path component.
      const filePath = path.join(challengeDir, `${path.basename(String(sc.name))}.sol`);
      fs.writeFileSync(filePath, code, 'utf-8');
    }

    // 2b. Download metadata (deploy values, setup, hints, validation).
    // A stale copy from a previous activation must never be reused.
    const metadataPath = path.join(challengeDir, 'metadata.json');
    if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
    try {
      const metadataRes = await this._apiPost('/getMetadata', { token, challenge_name: challengeName });
      if (metadataRes && Object.keys(metadataRes).length > 0) {
        fs.writeFileSync(metadataPath, JSON.stringify(metadataRes, null, 2), 'utf-8');
      }
    } catch (err) {
      logger.warn(`No metadata for ${challengeName}: ${err.message}`);
    }

    // 3. Sort by deploy_order
    smartContracts.sort((a, b) => a.deploy_order - b.deploy_order);

    // 4. Deploy each contract in order, then run the setup actions
    const deployedContracts = [];
    const metadata = this._getChallengeMetadata(challengeName) || {};
    const deployValues = metadata.deploy_values || {};

    try {
      for (const sc of smartContracts) {
        const contractName = path.basename(String(sc.name));
        const contractFileName = `${contractName}.sol`;
        const constructorArgs = this._buildConstructorArgs(
          sc.constructor_params || [],
          deployedContracts
        );
        const value = deployValues[sc.name] || '0';

        try {
          const result = await this.contractService.deployChallenge(
            challengeName,
            contractFileName,
            contractName,
            constructorArgs,
            value
          );

          deployedContracts.push({
            name: sc.name,
            address: result.address,
            abi: result.abi,
            fileName: contractFileName,
          });

          logger.info(`Deployed ${sc.name} at ${result.address}`);
        } catch (deployErr) {
          throw new Error(`Failed to deploy "${sc.name}": ${deployErr.message}`);
        }
      }

      await this._runSetup(metadata.setup || [], deployedContracts);
    } catch (err) {
      logger.error(`Activation of ${challengeName} failed, rolling back`, err);
      this.storageService.removeDeployedContractsForChallenge(challengeName);
      throw new Error(
        `${err.message}. Rollback: ${deployedContracts.length} deployed contract(s) removed from registry.`
      );
    }

    // 5. Store challenge state (include validation rules from metadata)
    await this.storageService.addActiveChallenge({
      challengeName,
      active: true,
      contracts: deployedContracts,
      activatedAt: new Date().toISOString(),
      validation: metadata.validation || null,
    });

    return {
      success: true,
      message: `Challenge "${challengeName}" activated with ${deployedContracts.length} contracts`,
      contracts: deployedContracts,
    };
  }

  /**
   * Get hints for a challenge (progressive reveal).
   */
  getHints(challengeName) {
    const hintsUsed = this.storageService.getHintsUsed(challengeName);
    const challenge = this._getChallengeMetadata(challengeName);
    
    if (!challenge || !challenge.hints) {
      return { hints: [], totalAvailable: 0, revealed: 0 };
    }

    // Reveal hints up to the number used
    const revealed = challenge.hints.slice(0, hintsUsed);
    return {
      hints: revealed,
      totalAvailable: challenge.hints.length,
      revealed: hintsUsed,
      canRevealMore: hintsUsed < challenge.hints.length,
    };
  }

  /**
   * Reveal the next hint for a challenge.
   */
  revealNextHint(challengeName) {
    const newCount = this.storageService.incrementHintsUsed(challengeName);
    return this.getHints(challengeName);
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  /**
   * Build constructor arguments, resolving references to deployed contracts.
   */
  _buildConstructorArgs(constructorParams, deployedContracts) {
    const args = [];

    for (const param of constructorParams) {
      const { param_type, param_value } = param;

      switch (param_type) {
        case 'literal': {
          if (param_value === 'true') {
            args.push(true);
          } else if (param_value === 'false') {
            args.push(false);
          } else if (!isNaN(param_value) && param_value !== '') {
            // Keep as string for large numbers (uint256 safe), web3 handles conversion
            const num = Number(param_value);
            args.push(Number.isSafeInteger(num) ? num : param_value);
          } else {
            args.push(param_value);
          }
          break;
        }
        case 'address': {
          if (param_value.startsWith('0x')) {
            args.push(param_value);
          } else {
            // Resolve to a previously deployed contract
            const found = deployedContracts.find((dc) => dc.name === param_value);
            if (!found) {
              throw new Error(
                `Cannot resolve address for "${param_value}". Not yet deployed.`
              );
            }
            args.push(found.address);
          }
          break;
        }
        case 'uint256':
        case 'uint': {
          args.push(param_value);
          break;
        }
        case 'bytes32': {
          const web3 = this.contractService.web3Provider.getWeb3();
          args.push(web3.utils.asciiToHex(param_value).padEnd(66, '0'));
          break;
        }
        case 'string': {
          args.push(param_value);
          break;
        }
        case 'array': {
          // JSON-encoded array
          try {
            args.push(JSON.parse(param_value));
          } catch {
            args.push(param_value.split(',').map((v) => v.trim()));
          }
          break;
        }
        case 'address_array': {
          // Array of addresses, some may be references
          const addresses = param_value.split(',').map((v) => {
            const trimmed = v.trim();
            if (trimmed.startsWith('0x')) return trimmed;
            const found = deployedContracts.find((dc) => dc.name === trimmed);
            if (!found) throw new Error(`Cannot resolve address for "${trimmed}"`);
            return found.address;
          });
          args.push(addresses);
          break;
        }
        default:
          logger.warn(`Unknown param_type: ${param_type}, using raw value`);
          args.push(param_value);
      }
    }

    return args;
  }

  /**
   * Run the setup actions declared in metadata.json after every contract is
   * deployed. Supported actions:
   *   { "action": "call", "target": "<contract>", "method": "<fn>", "args": [...],
   *     "from": "<ref>", "value": "<ether>" }
   *   { "action": "fund", "to": "<ref or address>", "amount": "<ether>", "from": "<ref>" }
   * Arguments accept the references described in references.js. "from"
   * defaults to "$deployer". Any failure aborts the activation.
   */
  async _runSetup(actions, deployedContracts) {
    if (!Array.isArray(actions) || actions.length === 0) return;

    const web3 = this.contractService.web3Provider.getWeb3();
    const accounts = await this.contractService.web3Provider.getAccounts();
    const resolve = createResolver({ web3, accounts, contracts: deployedContracts });

    for (const [i, action] of actions.entries()) {
      const label = `setup[${i}] ${action.action}`;
      const from = resolve(action.from || '$deployer');

      try {
        switch (action.action) {
          case 'call': {
            const target = deployedContracts.find((c) => c.name === action.target);
            if (!target) throw new Error(`target "${action.target}" not deployed`);
            const contract = new web3.eth.Contract(target.abi, target.address);
            if (typeof contract.methods[action.method] !== 'function') {
              throw new Error(`method "${action.method}" not found in ${action.target}`);
            }
            const method = contract.methods[action.method](...resolve(action.args || []));
            const value = web3.utils.toWei(String(action.value || '0'), 'ether');
            const gas = await method.estimateGas({ from, value });
            await method.send({ from, value, gas: Math.floor(Number(gas) * 1.3) });
            logger.info(`${label}: ${action.target}.${action.method}() OK`);
            break;
          }
          case 'fund': {
            const to = resolve(action.to);
            const value = web3.utils.toWei(String(action.amount || '0'), 'ether');
            await web3.eth.sendTransaction({ from, to, value });
            logger.info(`${label}: ${action.amount} ETH -> ${to} OK`);
            break;
          }
          default:
            throw new Error(`unknown action "${action.action}"`);
        }
      } catch (err) {
        throw new Error(`Setup failed at ${label}: ${err.message}`);
      }
    }
  }

  /**
   * Get challenge metadata from local storage (if available).
   */
  _getChallengeMetadata(challengeName) {
    const metadataPath = path.join(
      this.storageService.getChallengeDir(challengeName),
      'metadata.json'
    );
    if (fs.existsSync(metadataPath)) {
      try {
        return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Make a POST request to the Polonio API with timeout.
   */
  async _apiPost(endpoint, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `API error: ${response.status}`);
      }

      return response.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('API no responde (timeout 15s). ¿Está el contenedor Docker activo?');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

module.exports = { ChallengeEngine };
