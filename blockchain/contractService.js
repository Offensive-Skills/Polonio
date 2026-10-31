'use strict';

const fs = require('fs');
const path = require('path');
const { CompileService } = require('../compiler/compileService');
const { Logger } = require('../utils/logger');

const logger = new Logger('contracts');

/**
 * ContractService — Unified contract compilation, deployment, and interaction.
 * Eliminates previous code duplication between deployContract and deployUserContract.
 */
class ContractService {
  constructor(web3Provider, storageService) {
    this.web3Provider = web3Provider;
    this.storageService = storageService;
    this.compiler = new CompileService();
  }

  /**
   * Deploy a contract from a file path.
   * Used for both challenge contracts and user contracts.
   * 
   * @param {object} options
   * @param {string} options.filePath - Absolute path to .sol file
   * @param {string} options.contractName - Name of the contract to deploy (optional, first found)
   * @param {any[]} options.constructorArgs - Constructor arguments
   * @param {number} options.accountIndex - Account index to deploy from (default: 0)
   * @param {string} options.value - ETH to send with deployment (optional)
   * @returns {{ success, contractName, address, abi, transactionHash }}
   */
  async deploy(options) {
    const {
      filePath,
      contractName = null,
      constructorArgs = [],
      accountIndex = 0,
      value = '0',
    } = options;

    if (!fs.existsSync(filePath)) {
      throw new Error(`Contract file not found: ${filePath}`);
    }

    // Compile
    const compileResult = await this.compiler.compileFile(filePath);
    if (!compileResult.success) {
      const errorMsg = compileResult.errors.map((e) => e.message).join('\n');
      throw new Error(`Compilation failed:\n${errorMsg}`);
    }

    // Select contract: by explicit name, or the default one from the main file
    const contracts = compileResult.contracts;
    const contractNames = Object.keys(contracts);
    if (contractNames.length === 0) {
      throw new Error('No contracts found in compilation output');
    }

    const targetName = contractName || this._defaultContractName(filePath, contracts);
    const compiled = contracts[targetName];
    if (!compiled) {
      throw new Error(`Contract "${targetName}" not found. Available: ${contractNames.join(', ')}`);
    }

    if (!compiled.bytecode || compiled.bytecode.length === 0) {
      throw new Error(`Empty bytecode for "${targetName}". Is it an interface or abstract contract?`);
    }

    // Deploy
    const web3 = this.web3Provider.getWeb3();
    const accounts = await this.web3Provider.getAccounts();
    const deployer = accounts[accountIndex] || accounts[0];

    const contract = new web3.eth.Contract(compiled.abi);
    const deployTx = contract.deploy({
      data: '0x' + compiled.bytecode,
      arguments: constructorArgs,
    });

    const estimatedGas = await deployTx.estimateGas({ from: deployer, value: web3.utils.toWei(value, 'ether') });
    const gasLimit = Math.floor(Number(estimatedGas) * 1.3);

    const deployed = await deployTx.send({
      from: deployer,
      gas: gasLimit,
      value: web3.utils.toWei(value, 'ether'),
    });

    return {
      success: true,
      contractName: targetName,
      address: deployed.options.address,
      abi: compiled.abi,
      transactionHash: deployed.transactionHash || null,
    };
  }

  /**
   * Deploy a challenge contract (from challenge directory).
   * The contract is always selected by name, never by compilation order.
   */
  async deployChallenge(challengeName, contractFileName, contractName, constructorArgs = [], value = '0') {
    const challengeDir = this.storageService.getChallengeDir(challengeName);
    const filePath = path.join(challengeDir, contractFileName);

    const result = await this.deploy({ filePath, contractName, constructorArgs, value });

    await this.storageService.addDeployedContract({
      contractName: result.contractName,
      challengeName,
      fileName: contractFileName,
      address: result.address,
      abi: result.abi,
    });

    return result;
  }

  /**
   * Deploy a user contract (from the console editor).
   * @param {object} data
   * @param {string} data.source - Solidity source
   * @param {string} data.contractName - Contract to deploy (optional, defaults to the last one declared)
   * @param {any[]} data.constructorArgs - Constructor arguments
   * @param {string} data.value - ETH to send with the deployment
   * @param {number} data.accountIndex - Deployer account (defaults to the player, accounts[1])
   */
  async deployUserContract(data) {
    const {
      title,
      source,
      fileName,
      contractName = null,
      constructorArgs = [],
      value = '0',
      accountIndex = 1,
    } = data;

    // basename() prevents the renderer-supplied fileName from escaping the dir.
    const userDir = this.storageService.getUserContractsDir();
    const safeFileName = path.basename(String(fileName || 'Contract.sol'));
    const filePath = path.join(userDir, safeFileName);
    fs.writeFileSync(filePath, source, 'utf-8');

    const index = Number.isInteger(Number(accountIndex)) ? Number(accountIndex) : 1;
    const result = await this.deploy({
      filePath,
      contractName: contractName || null,
      constructorArgs,
      value: String(value || '0'),
      accountIndex: index,
    });

    await this.storageService.addUserContract({
      title,
      contractName: result.contractName,
      fileName: safeFileName,
      address: result.address,
      abi: result.abi,
    });

    return result;
  }

  /**
   * Interact with a deployed contract.
   * Automatically detects read (call) vs write (send) methods.
   * 
   * @param {object} data
   * @param {string} data.address - Contract address
   * @param {any[]} data.abi - Contract ABI
   * @param {string} data.methodName - Method to call
   * @param {any[]} data.args - Method arguments
   * @param {number} data.accountIndex - Account index to send from
   * @param {string} data.value - ETH value to send (optional)
   */
  async interact(data) {
    const { address, abi, methodName, args = [], accountIndex = 0, value = '0' } = data;

    const web3 = this.web3Provider.getWeb3();
    const accounts = await this.web3Provider.getAccounts();
    const caller = accounts[accountIndex] || accounts[0];

    const contract = new web3.eth.Contract(abi, address);

    // Find the method in ABI
    const methodAbi = abi.find(
      (item) => item.type === 'function' && item.name === methodName
    );

    if (!methodAbi) {
      throw new Error(`Method "${methodName}" not found in contract ABI`);
    }

    const method = contract.methods[methodName](...args);

    // Determine if it's a read or write operation
    const isReadOnly = methodAbi.stateMutability === 'view' || methodAbi.stateMutability === 'pure';

    if (isReadOnly) {
      const result = await method.call({ from: caller });
      return {
        success: true,
        type: 'call',
        result: this._serializeResult(result),
      };
    } else {
      const valueWei = web3.utils.toWei(value, 'ether');
      const gasEstimate = await method.estimateGas({ from: caller, value: valueWei });
      const gasLimit = Math.floor(Number(gasEstimate) * 1.3);

      const receipt = await method.send({
        from: caller,
        gas: gasLimit,
        value: valueWei,
      });

      return {
        success: true,
        type: 'send',
        result: {
          transactionHash: receipt.transactionHash,
          // web3 v4 returns BigInt for numeric fields — normalize for IPC/JSON.
          blockNumber: Number(receipt.blockNumber),
          status: receipt.status ? Number(receipt.status) : 0,
          from: receipt.from,
          to: receipt.to,
          gasUsed: receipt.gasUsed != null ? receipt.gasUsed.toString() : null,
          events: this._serializeEvents(receipt.events),
        },
      };
    }
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  /**
   * Default contract to deploy when no name is given: among the deployable
   * contracts declared in the main file (imports excluded), the last one
   * declared, which is where the entry contract usually lives.
   */
  _defaultContractName(filePath, contracts) {
    const mainFile = path.basename(filePath);
    const deployable = Object.entries(contracts)
      .filter(([, c]) => c.sourceFile === mainFile && c.bytecode && c.bytecode.length > 0)
      .map(([name]) => name);

    if (deployable.length === 0) {
      throw new Error('No deployable contract found (only interfaces, libraries or abstract contracts)');
    }
    if (deployable.length === 1) return deployable[0];

    const source = fs.readFileSync(filePath, 'utf-8');
    const position = (name) => {
      const m = new RegExp(`\\bcontract\\s+${name}\\b`).exec(source);
      return m ? m.index : -1;
    };
    return deployable.sort((a, b) => position(a) - position(b))[deployable.length - 1];
  }

  /**
   * Serialize BigInt and complex results for IPC transport.
   */
  _serializeResult(result) {
    if (result === null || result === undefined) return null;
    if (typeof result === 'bigint') return result.toString();
    if (typeof result !== 'object') return result;
    if (Array.isArray(result)) return result.map((r) => this._serializeResult(r));

    const serialized = {};
    for (const [key, value] of Object.entries(result)) {
      // Skip numeric keys from tuples
      if (!isNaN(key)) continue;
      serialized[key] = this._serializeResult(value);
    }
    return serialized;
  }

  _serializeEvents(events) {
    if (!events) return {};
    const serialized = {};
    for (const [name, event] of Object.entries(events)) {
      if (event && event.returnValues) {
        serialized[name] = {
          returnValues: this._serializeResult(event.returnValues),
          event: event.event,
          logIndex: event.logIndex != null ? Number(event.logIndex) : null,
        };
      }
    }
    return serialized;
  }
}

module.exports = { ContractService };
