'use strict';

const { Logger } = require('../utils/logger');

const logger = new Logger('inspector');

/**
 * Inspector — Low-level blockchain inspection tools.
 * Allows reading storage slots, contract code, balances, etc.
 */
class Inspector {
  constructor(web3Provider) {
    this.web3Provider = web3Provider;
  }

  /**
   * Read a storage slot from a contract.
   * @param {string} address - Contract address
   * @param {number|string} slot - Storage slot index
   * @returns {{ raw, asAddress, asUint256, asBytes32, asString }}
   */
  async readStorageSlot(address, slot) {
    const web3 = this.web3Provider.getWeb3();
    const raw = await web3.eth.getStorageAt(address, slot);

    return {
      slot: typeof slot === 'number' ? slot : parseInt(slot),
      raw,
      interpretations: {
        asUint256: BigInt(raw).toString(),
        asAddress: '0x' + raw.slice(26).toLowerCase(),
        asBytes32: raw,
        asBool: raw === '0x0000000000000000000000000000000000000000000000000000000000000001',
        asInt256: this._toSignedInt256(raw),
      },
    };
  }

  /**
   * Read multiple consecutive storage slots.
   */
  async readStorageRange(address, startSlot, count = 10) {
    const results = [];
    for (let i = 0; i < count; i++) {
      const slot = startSlot + i;
      const result = await this.readStorageSlot(address, slot);
      results.push(result);
    }
    return results;
  }

  /**
   * Get balance in ETH and Wei.
   */
  async getBalance(address) {
    const web3 = this.web3Provider.getWeb3();
    const balanceWei = await web3.eth.getBalance(address);
    return {
      address,
      wei: balanceWei.toString(),
      ether: web3.utils.fromWei(balanceWei.toString(), 'ether'),
    };
  }

  /**
   * Get deployed bytecode at address.
   */
  async getCode(address) {
    const web3 = this.web3Provider.getWeb3();
    const code = await web3.eth.getCode(address);
    return {
      address,
      code,
      isEmpty: code === '0x' || code === '0x0',
      size: code === '0x' ? 0 : (code.length - 2) / 2, // bytes
    };
  }

  /**
   * Get full transaction receipt with decoded logs.
   */
  async getTransactionReceipt(txHash) {
    const web3 = this.web3Provider.getWeb3();
    const receipt = await web3.eth.getTransactionReceipt(txHash);
    if (!receipt) {
      return { error: 'Transaction not found' };
    }

    // web3 v4 returns BigInt for numeric fields — normalize so the result
    // survives JSON.stringify() in the renderer.
    return {
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber != null ? Number(receipt.blockNumber) : null,
      from: receipt.from,
      to: receipt.to,
      status: receipt.status != null ? Number(receipt.status) : null,
      gasUsed: receipt.gasUsed?.toString(),
      contractAddress: receipt.contractAddress,
      logs: (receipt.logs || []).map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        logIndex: log.logIndex != null ? Number(log.logIndex) : null,
      })),
    };
  }

  /**
   * Get transaction details.
   */
  async getTransaction(txHash) {
    const web3 = this.web3Provider.getWeb3();
    const tx = await web3.eth.getTransaction(txHash);
    if (!tx) {
      return { error: 'Transaction not found' };
    }

    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: web3.utils.fromWei(tx.value?.toString() || '0', 'ether'),
      gas: tx.gas?.toString(),
      gasPrice: tx.gasPrice?.toString(),
      input: tx.input,
      nonce: tx.nonce != null ? Number(tx.nonce) : null,
      blockNumber: tx.blockNumber != null ? Number(tx.blockNumber) : null,
    };
  }

  _toSignedInt256(hex) {
    const bn = BigInt(hex);
    const max = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    if (bn > max) {
      return (bn - BigInt('0x10000000000000000000000000000000000000000000000000000000000000000')).toString();
    }
    return bn.toString();
  }
}

module.exports = { Inspector };
