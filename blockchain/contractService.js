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
      deployer,
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

    // The source is snapshotted with the deployment: the editor (and the file
    // on disk) are overwritten by later deployments, but the player must be
    // able to review exactly what is running at this address.
    await this.storageService.addUserContract({
      title,
      contractName: result.contractName,
      fileName: safeFileName,
      address: result.address,
      abi: result.abi,
      source,
      deployer: result.deployer,
      transactionHash: result.transactionHash,
    });

    return result;
  }

  /**
   * Interact with a registered contract.
   * The ABI is taken from the local registry and the function is selected by
   * its canonical signature, so overloaded functions are supported.
   * Read-only functions are executed with eth_call, the rest as transactions.
   *
   * @param {object} data
   * @param {string} data.address - Contract address
   * @param {string} data.signature - Canonical signature, e.g. "transfer(address,uint256)"
   * @param {any[]} data.args - One value per function input (strings are coerced by type)
   * @param {number} data.accountIndex - Account index to send from
   * @param {string} data.value - ETH value to send (payable functions only)
   */
  async interact(data) {
    const { address, signature, args = [], accountIndex = 1, value = '0' } = data || {};

    const record = await this.storageService.getContractByAddress(address);
    if (!record || !Array.isArray(record.abi)) {
      throw new Error(`No hay ningún contrato registrado en ${address}`);
    }

    const fragment = record.abi.find(
      (item) => item.type === 'function' && functionSignature(item) === signature
    );
    if (!fragment) {
      throw new Error(`La función "${signature}" no existe en el ABI de ${record.contractName || address}`);
    }

    const inputs = fragment.inputs || [];
    if (!Array.isArray(args) || args.length !== inputs.length) {
      throw new Error(`${signature} espera ${inputs.length} argumento(s), recibidos ${Array.isArray(args) ? args.length : 0}`);
    }
    const coercedArgs = inputs.map((input, i) => coerceArg(input, args[i], i));

    const web3 = this.web3Provider.getWeb3();
    if (!web3) throw new Error('Blockchain no conectada');
    const caller = await this._account(accountIndex);
    const contract = new web3.eth.Contract(record.abi, record.address);

    // web3 indexes methods by canonical signature as well as by bare name.
    const methodFn = contract.methods[signature] || contract.methods[fragment.name];
    const method = methodFn(...coercedArgs);

    const isReadOnly = fragment.stateMutability === 'view' || fragment.stateMutability === 'pure';
    if (isReadOnly) {
      const result = await method.call({ from: caller });
      return {
        success: true,
        type: 'call',
        signature,
        outputs: formatOutputs(fragment.outputs || [], result),
      };
    }

    const isPayable = fragment.stateMutability === 'payable' || fragment.payable === true;
    const valueWei = web3.utils.toWei(String(value || '0'), 'ether');
    if (!isPayable && BigInt(valueWei) !== 0n) {
      throw new Error(`${signature} no es payable: no se puede enviar ETH`);
    }

    const gasEstimate = await method.estimateGas({ from: caller, value: valueWei });
    const receipt = await method.send({
      from: caller,
      gas: Math.floor(Number(gasEstimate) * 1.3),
      value: valueWei,
    });

    return {
      success: true,
      type: 'send',
      signature,
      result: this._serializeReceipt(receipt),
    };
  }

  /**
   * Send a raw transaction (arbitrary calldata and/or ETH) to any address.
   * Reaches fallback()/receive() and functions that are not in the ABI.
   *
   * @param {object} data
   * @param {string} data.to - Destination address
   * @param {string} data.data - Hex calldata ("0x" or empty for a plain transfer)
   * @param {string} data.value - ETH to send
   * @param {number} data.accountIndex - Account index to send from
   */
  async sendRaw(data) {
    const { to, data: calldata = '', value = '0', accountIndex = 1 } = data || {};
    const web3 = this.web3Provider.getWeb3();
    if (!web3) throw new Error('Blockchain no conectada');

    if (!web3.utils.isAddress(String(to || ''))) {
      throw new Error(`Dirección de destino inválida: "${to}"`);
    }
    const hexData = String(calldata || '').trim() || '0x';
    if (!/^0x([0-9a-fA-F]{2})*$/.test(hexData)) {
      throw new Error('Calldata inválido: debe ser hexadecimal con prefijo 0x y número par de dígitos');
    }

    const from = await this._account(accountIndex);
    const tx = { from, to, data: hexData, value: web3.utils.toWei(String(value || '0'), 'ether') };
    const gasEstimate = await web3.eth.estimateGas(tx);
    const receipt = await web3.eth.sendTransaction({ ...tx, gas: Math.floor(Number(gasEstimate) * 1.3) });

    return { success: true, type: 'send', result: this._serializeReceipt(receipt) };
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

  async _account(accountIndex) {
    const accounts = await this.web3Provider.getAccounts();
    const index = Number(accountIndex);
    const account = Number.isInteger(index) ? accounts[index] : undefined;
    if (!account) throw new Error(`La cuenta ${accountIndex} no existe`);
    return account;
  }

  /**
   * Receipt fields relevant to the player, IPC/JSON safe
   * (web3 v4 returns BigInt for numeric fields).
   */
  _serializeReceipt(receipt) {
    return {
      transactionHash: receipt.transactionHash,
      blockNumber: Number(receipt.blockNumber),
      status: receipt.status != null ? Number(receipt.status) : 0,
      from: receipt.from,
      to: receipt.to,
      gasUsed: receipt.gasUsed != null ? receipt.gasUsed.toString() : null,
      events: this._serializeEvents(receipt.events),
    };
  }

  _serializeEvents(events) {
    if (!events) return {};
    const serialized = {};
    for (const [name, event] of Object.entries(events)) {
      if (event && event.returnValues) {
        serialized[name] = {
          returnValues: serializeDecoded(event.returnValues),
          event: event.event,
          logIndex: event.logIndex != null ? Number(event.logIndex) : null,
        };
      }
    }
    return serialized;
  }
}

// ─── ABI helpers ─────────────────────────────────────────────────────────────

/** Canonical ABI type of a parameter (tuples expanded: "(uint256,address)[]"). */
function canonicalType(param) {
  const type = String(param.type || '');
  if (type.startsWith('tuple')) {
    const inner = (param.components || []).map(canonicalType).join(',');
    return `(${inner})${type.slice('tuple'.length)}`;
  }
  return type;
}

/** Canonical function signature, e.g. "transfer(address,uint256)". */
function functionSignature(fragment) {
  return `${fragment.name}(${(fragment.inputs || []).map(canonicalType).join(',')})`;
}

/**
 * Convert a value typed by the player into what web3 expects for `param`.
 * Arrays and tuples are given as JSON, bools as true/false; numbers, addresses,
 * bytes and strings are passed through and validated by web3's ABI encoder.
 */
function coerceArg(param, raw, index) {
  const type = String(param.type || '');
  const label = `Argumento ${index + 1} (${canonicalType(param)}${param.name ? ' ' + param.name : ''})`;

  if (type.endsWith(']') || type.startsWith('tuple')) {
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${label}: debe ser JSON válido, p. ej. ${type.startsWith('tuple') ? '["0x...", 1]' : '[1, 2, 3]'}`);
    }
  }

  if (type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const text = String(raw).trim().toLowerCase();
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
    throw new Error(`${label}: debe ser true o false`);
  }

  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' && type !== 'string') {
    throw new Error(`${label}: valor requerido`);
  }
  return type === 'string' ? raw : text;
}

/**
 * Pair each declared output with its decoded value.
 * web3 returns a single output as a bare value and several outputs as an
 * object with positional keys (unnamed outputs only exist positionally).
 */
function formatOutputs(outputs, result) {
  if (outputs.length === 0) return [];
  if (outputs.length === 1) {
    return [{ name: outputs[0].name || '', type: canonicalType(outputs[0]), value: serializeDecoded(result) }];
  }
  return outputs.map((output, i) => ({
    name: output.name || '',
    type: canonicalType(output),
    value: serializeDecoded(result ? result[i] : undefined),
  }));
}

/**
 * Make a web3-decoded value JSON safe: BigInt to decimal string, and decoded
 * structs/tuples (objects with positional keys + __length__) to their named
 * fields, or to a plain array when the fields are unnamed.
 */
function serializeDecoded(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeDecoded);
  if (typeof value !== 'object') return value;

  const keys = Object.keys(value).filter((k) => k !== '__length__');
  const named = keys.filter((k) => isNaN(Number(k)));
  if (named.length > 0) {
    const out = {};
    for (const k of named) out[k] = serializeDecoded(value[k]);
    return out;
  }
  if ('__length__' in value) {
    return Array.from({ length: Number(value.__length__) }, (_, i) => serializeDecoded(value[i]));
  }
  const out = {};
  for (const k of keys) out[k] = serializeDecoded(value[k]);
  return out;
}

module.exports = { ContractService, functionSignature, canonicalType };
