'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Logger } = require('../utils/logger');

const logger = new Logger('storage');

/**
 * StorageService — Unified local data persistence.
 * All data is stored in ~/.local/share/polonio/
 */
class StorageService {
  constructor() {
    this.baseDir = path.join(os.homedir(), '.local', 'share', 'polonio');
    this._ensureDir(this.baseDir);
    this._dataPath = path.join(this.baseDir, 'polonioData.json');
  }

  // ─── Core Read/Write ─────────────────────────────────────────────────────

  _readData() {
    if (!fs.existsSync(this._dataPath)) {
      return this._defaultData();
    }
    try {
      const content = fs.readFileSync(this._dataPath, 'utf-8');
      const data = JSON.parse(content);
      return { ...this._defaultData(), ...data };
    } catch (err) {
      logger.error('Corrupted data file, resetting', err);
      return this._defaultData();
    }
  }

  _writeData(data) {
    fs.writeFileSync(this._dataPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  _defaultData() {
    return {
      deployedContracts: [],
      activeChallenges: [],
      userContracts: [],
      hintsUsed: {},
    };
  }

  // ─── Deployed Contracts ──────────────────────────────────────────────────

  async getDeployedContracts() {
    return this._readData().deployedContracts;
  }

  async addDeployedContract(contractData) {
    const data = this._readData();
    data.deployedContracts.push({
      ...contractData,
      deployedAt: new Date().toISOString(),
    });
    this._writeData(data);
  }

  clearDeployedContracts() {
    const data = this._readData();
    data.deployedContracts = [];
    this._writeData(data);
  }

  /**
   * Remove all deployed contracts associated with a specific challenge.
   * Used for rollback on partial deployment failure.
   */
  removeDeployedContractsForChallenge(challengeName) {
    const data = this._readData();
    data.deployedContracts = data.deployedContracts.filter(
      (c) => c.challengeName !== challengeName
    );
    this._writeData(data);
  }

  // ─── Active Challenges ───────────────────────────────────────────────────

  async getActiveChallenges() {
    return this._readData().activeChallenges;
  }

  async getActiveChallenge(challengeName) {
    const challenges = await this.getActiveChallenges();
    return challenges.find((c) => c.challengeName === challengeName) || null;
  }

  async addActiveChallenge(challengeData) {
    const data = this._readData();
    const index = data.activeChallenges.findIndex(
      (c) => c.challengeName === challengeData.challengeName
    );
    if (index >= 0) {
      data.activeChallenges[index] = challengeData;
    } else {
      data.activeChallenges.push(challengeData);
    }
    this._writeData(data);
  }

  clearActiveChallenges() {
    const data = this._readData();
    data.activeChallenges = [];
    this._writeData(data);
  }

  // ─── User Contracts ──────────────────────────────────────────────────────

  async getUserContracts() {
    return this._readData().userContracts;
  }

  async addUserContract(contractData) {
    const data = this._readData();
    data.userContracts.push({
      ...contractData,
      deployedAt: new Date().toISOString(),
    });
    this._writeData(data);
  }

  clearUserContracts() {
    const data = this._readData();
    data.userContracts = [];
    this._writeData(data);
  }

  // ─── Contract Registry ───────────────────────────────────────────────────

  /**
   * Every contract deployed in the current chain session, challenge contracts
   * first and then the player's own deployments (newest first). Heavy fields
   * (ABI, source) are left out; use getContractByAddress() to fetch them.
   */
  async getContractRegistry() {
    const data = this._readData();
    const challenge = data.deployedContracts.map((c) => ({
      kind: 'challenge',
      name: c.contractName || (c.fileName ? path.parse(c.fileName).name : ''),
      address: c.address,
      challengeName: c.challengeName || null,
      fileName: c.fileName || null,
      deployedAt: c.deployedAt || null,
      hasSource: Boolean(c.challengeName && c.fileName),
    }));
    const user = [...data.userContracts].reverse().map((c) => ({
      kind: 'user',
      name: c.contractName || c.title || '',
      address: c.address,
      fileName: c.fileName || null,
      deployer: c.deployer || null,
      deployedAt: c.deployedAt || null,
      hasSource: typeof c.source === 'string' && c.source.length > 0,
    }));
    return [...challenge, ...user];
  }

  /**
   * Full record (ABI and, for user contracts, the deployed source) of the
   * contract at `address`, or null if it is not registered.
   * Challenge contracts take precedence; among user deployments the most
   * recent one wins (an address is unique per chain session anyway).
   */
  async getContractByAddress(address) {
    if (typeof address !== 'string' || !address) return null;
    const target = address.toLowerCase();
    const data = this._readData();

    const deployed = data.deployedContracts.find(
      (c) => typeof c.address === 'string' && c.address.toLowerCase() === target
    );
    if (deployed) return { kind: 'challenge', ...deployed };

    const user = [...data.userContracts].reverse().find(
      (c) => typeof c.address === 'string' && c.address.toLowerCase() === target
    );
    if (user) return { kind: 'user', ...user };

    return null;
  }

  // ─── Hints ───────────────────────────────────────────────────────────────

  getHintsUsed(challengeName) {
    const data = this._readData();
    return data.hintsUsed[challengeName] || 0;
  }

  incrementHintsUsed(challengeName) {
    const data = this._readData();
    if (!data.hintsUsed) data.hintsUsed = {};
    data.hintsUsed[challengeName] = (data.hintsUsed[challengeName] || 0) + 1;
    this._writeData(data);
    return data.hintsUsed[challengeName];
  }

  // ─── Clear All ───────────────────────────────────────────────────────────

  clearAll() {
    const data = this._readData();
    data.deployedContracts = [];
    data.activeChallenges = [];
    data.userContracts = [];
    data.hintsUsed = {};
    this._writeData(data);
  }

  // ─── Challenge Directory ─────────────────────────────────────────────────

  getChallengeDir(challengeName) {
    const dir = path.join(this.baseDir, this._safeComponent(challengeName));
    this._ensureDir(dir);
    return dir;
  }

  /**
   * Reduce an untrusted name to a single safe path component.
   * Prevents path traversal (../, absolute paths, separators) when the value
   * is used to build a filesystem path.
   */
  _safeComponent(name) {
    const base = path.basename(String(name || ''));
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
    if (!cleaned) {
      throw new Error(`Invalid name: "${name}"`);
    }
    return cleaned;
  }

  getUserContractsDir() {
    const dir = path.join(this.baseDir, 'my_contracts');
    this._ensureDir(dir);
    return dir;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}

module.exports = { StorageService };
