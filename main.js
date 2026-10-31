'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const path = require('path');

// ─── Services ────────────────────────────────────────────────────────────────
const { AnvilService } = require('./forge/anvilService');
const { AuthController } = require('./controllers/authController');
const { ContractService } = require('./blockchain/contractService');
const { ChallengeEngine } = require('./challenges/challengeEngine');
const { Validator } = require('./challenges/validator');
const { StorageService } = require('./blockchain/storageService');
const { AccountService } = require('./blockchain/accountService');
const { EventListener } = require('./blockchain/eventListener');
const { TransactionLogger } = require('./blockchain/transactionLogger');
const { Inspector } = require('./blockchain/inspector');
const { CompileService } = require('./compiler/compileService');
const { Web3Provider } = require('./blockchain/web3Provider');
const { Logger } = require('./utils/logger');

const logger = new Logger('main');

let mainWindow;
let anvilService;
let authController;
let contractService;
let challengeEngine;
let storageService;
let accountService;
let eventListener;
let transactionLogger;
let inspector;
let compileService;
let web3Provider;

// ─── Window Creation ─────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Polonio',
    backgroundColor: '#0d0d1a',
    icon: path.join(__dirname, 'assets', 'images', 'logo_polonio.png'),
    titleBarStyle: 'hiddenInset',
    frame: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.setMenu(null);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'views', 'app.html'));

  if (process.argv.includes('--dev') || process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error('Render process gone', details);
  });
}

// ─── Initialize Services ─────────────────────────────────────────────────────

function initializeServices() {
  web3Provider = new Web3Provider();
  anvilService = new AnvilService();
  authController = new AuthController();
  storageService = new StorageService();
  accountService = new AccountService(web3Provider);
  contractService = new ContractService(web3Provider, storageService);
  compileService = new CompileService();
  eventListener = new EventListener(web3Provider, mainWindow);
  transactionLogger = new TransactionLogger(mainWindow);
  inspector = new Inspector(web3Provider);
  challengeEngine = new ChallengeEngine(contractService, storageService, authController);
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  // ─── Auth ────────────────────────────────────────────────────────────────
  ipcMain.handle('auth:login', async (_event, username, apiToken, remember) => {
    try {
      return await authController.login(username, apiToken, remember);
    } catch (err) {
      logger.error('auth:login', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    return authController.logout();
  });

  ipcMain.handle('auth:get-session', async () => {
    return await authController.getSession();
  });

  // ─── Blockchain ──────────────────────────────────────────────────────────
  ipcMain.handle('blockchain:start', async () => {
    try {
      await anvilService.start();
      await web3Provider.connect();
      return { success: true };
    } catch (err) {
      logger.error('blockchain:start', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('blockchain:stop', async () => {
    try {
      // Each cleanup step runs independently to avoid one failure blocking the rest
      try { eventListener.unsubscribeAll(); } catch (e) { logger.error('stop: unsubscribe failed', e); }
      try { await anvilService.stop(); } catch (e) { logger.error('stop: anvil stop failed', e); }
      try { web3Provider.disconnect(); } catch (e) { logger.error('stop: disconnect failed', e); }
      storageService.clearAll();
      transactionLogger.clear();
      return { success: true };
    } catch (err) {
      logger.error('blockchain:stop', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('blockchain:restart', async () => {
    try {
      // Cleanup (resilient — each step independent)
      try { eventListener.unsubscribeAll(); } catch (e) { logger.error('restart: unsubscribe failed', e); }
      try { await anvilService.stop(); } catch (e) { logger.error('restart: anvil stop failed', e); }
      try { web3Provider.disconnect(); } catch (e) { logger.error('restart: disconnect failed', e); }
      storageService.clearAll();
      transactionLogger.clear();

      // Restart
      await anvilService.start();
      await web3Provider.connect();
      return { success: true };
    } catch (err) {
      logger.error('blockchain:restart', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('blockchain:status', async () => {
    if (!anvilService.isRunning()) return { running: false };
    // Verify actual connectivity (detect crashed nodes)
    const alive = await web3Provider.checkHealth();
    if (!alive) {
      // Node died — clean up state
      anvilService.stop().catch(() => {});
      storageService.clearAll();
      return { running: false, error: 'Node disconnected unexpectedly' };
    }
    return { running: true };
  });

  ipcMain.handle('blockchain:info', async () => {
    try {
      if (!anvilService.isRunning()) {
        return { running: false };
      }
      const accounts = await accountService.getAccountsWithBalance();
      return {
        running: true,
        chainId: anvilService.getChainId(),
        blockNumber: await web3Provider.getBlockNumber(),
        accounts,
        mnemonic: anvilService.getMnemonic(),
      };
    } catch (err) {
      logger.error('blockchain:info', err);
      return { running: false, error: err.message };
    }
  });

  ipcMain.handle('blockchain:accounts', async () => {
    try {
      return await accountService.getAccountsWithBalance();
    } catch (err) {
      logger.error('blockchain:accounts', err);
      return [];
    }
  });

  // ─── Challenges ──────────────────────────────────────────────────────────
  ipcMain.handle('challenges:list', async (_event, level) => {
    try {
      const token = authController.getToken();
      return await challengeEngine.listChallenges(level, token);
    } catch (err) {
      logger.error('challenges:list', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('challenges:image', async (_event, challengeName) => {
    try {
      const token = authController.getToken();
      return await challengeEngine.getChallengeImage(challengeName, token);
    } catch (err) {
      logger.error('challenges:image', err);
      return null;
    }
  });

  ipcMain.handle('challenges:smartcontracts', async (_event, challengeName) => {
    try {
      const token = authController.getToken();
      return await challengeEngine.getSmartcontracts(challengeName, token);
    } catch (err) {
      logger.error('challenges:smartcontracts', err);
      return [];
    }
  });

  ipcMain.handle('challenges:activate', async (_event, challengeName) => {
    try {
      const token = authController.getToken();
      return await challengeEngine.activateChallenge(challengeName, token);
    } catch (err) {
      logger.error('challenges:activate', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('challenges:validate', async (_event, challengeName) => {
    try {
      const validator = new Validator(web3Provider, storageService);
      return await validator.validateChallenge(challengeName);
    } catch (err) {
      logger.error('challenges:validate', err);
      return { success: false, passed: false, error: err.message };
    }
  });

  ipcMain.handle('challenges:complete', async (_event, challengeName, complete) => {
    try {
      const token = authController.getToken();
      return await challengeEngine.completeChallenge(challengeName, complete, token);
    } catch (err) {
      logger.error('challenges:complete', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('challenges:writeup', async (_event, challengeName) => {
    try {
      const token = authController.getToken();
      return await challengeEngine.getWriteup(challengeName, token);
    } catch (err) {
      logger.error('challenges:writeup', err);
      return { content: '' };
    }
  });

  ipcMain.handle('challenges:hints', async (_event, challengeName) => {
    try {
      return challengeEngine.getHints(challengeName);
    } catch (err) {
      logger.error('challenges:hints', err);
      return [];
    }
  });

  ipcMain.handle('challenges:reveal-hint', async (_event, challengeName) => {
    try {
      return challengeEngine.revealNextHint(challengeName);
    } catch (err) {
      logger.error('challenges:reveal-hint', err);
      return { hints: [], totalAvailable: 0, revealed: 0 };
    }
  });

  ipcMain.handle('challenges:get-active', async () => {
    try {
      return await storageService.getActiveChallenges();
    } catch (err) {
      logger.error('challenges:get-active', err);
      return [];
    }
  });

  // ─── Contracts ───────────────────────────────────────────────────────────
  ipcMain.handle('contracts:interact', async (_event, data) => {
    try {
      const result = await contractService.interact(data);
      transactionLogger.log(data, result);
      return result;
    } catch (err) {
      logger.error('contracts:interact', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('contracts:code', async (_event, challengeName, scName) => {
    try {
      const token = authController.getToken();
      return await challengeEngine.getContractCode(challengeName, scName, token);
    } catch (err) {
      logger.error('contracts:code', err);
      return { contract: '' };
    }
  });

  ipcMain.handle('contracts:abi', async (_event, contractName) => {
    try {
      return await storageService.getContractAbi(contractName);
    } catch (err) {
      logger.error('contracts:abi', err);
      return null;
    }
  });

  ipcMain.handle('contracts:deploy-user', async (_event, data) => {
    try {
      const result = await contractService.deployUserContract(data);
      transactionLogger.logDeploy(data, result);
      return result;
    } catch (err) {
      logger.error('contracts:deploy-user', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('contracts:user-list', async () => {
    try {
      return await storageService.getUserContracts();
    } catch (err) {
      logger.error('contracts:user-list', err);
      return [];
    }
  });

  ipcMain.handle('contracts:deployed-list', async () => {
    try {
      return await storageService.getDeployedContracts();
    } catch (err) {
      logger.error('contracts:deployed-list', err);
      return [];
    }
  });

  // ─── Inspector ───────────────────────────────────────────────────────────
  ipcMain.handle('inspector:read-storage', async (_event, address, slot) => {
    try {
      return await inspector.readStorageSlot(address, slot);
    } catch (err) {
      logger.error('inspector:read-storage', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('inspector:balance', async (_event, address) => {
    try {
      return await inspector.getBalance(address);
    } catch (err) {
      logger.error('inspector:balance', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('inspector:code', async (_event, address) => {
    try {
      return await inspector.getCode(address);
    } catch (err) {
      logger.error('inspector:code', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('inspector:tx-receipt', async (_event, txHash) => {
    try {
      return await inspector.getTransactionReceipt(txHash);
    } catch (err) {
      logger.error('inspector:tx-receipt', err);
      return { error: err.message };
    }
  });

  // ─── Events ──────────────────────────────────────────────────────────────
  ipcMain.handle('events:subscribe', async (_event, address, abi) => {
    try {
      return await eventListener.subscribe(address, abi);
    } catch (err) {
      logger.error('events:subscribe', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('events:unsubscribe', async (_event, subscriptionId) => {
    try {
      eventListener.unsubscribe(subscriptionId);
      return { success: true };
    } catch (err) {
      logger.error('events:unsubscribe', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('events:history', async () => {
    return eventListener.getHistory();
  });

  // ─── Transactions ────────────────────────────────────────────────────────
  ipcMain.handle('transactions:history', async () => {
    return transactionLogger.getHistory();
  });

  ipcMain.handle('transactions:clear', async () => {
    transactionLogger.clear();
    return { success: true };
  });

  // ─── Compiler ────────────────────────────────────────────────────────────
  ipcMain.handle('compiler:compile', async (_event, source, version) => {
    try {
      return await compileService.compile(source, version);
    } catch (err) {
      logger.error('compiler:compile', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('compiler:versions', async () => {
    return compileService.getAvailableVersions();
  });

  // ─── Script Execution (JS with web3 context) ─────────────────────────────
  ipcMain.handle('script:execute', async (_event, code) => {
    try {
      const web3 = web3Provider.getWeb3();
      if (!web3) return { success: false, error: 'Blockchain no conectada' };

      const allAccounts = await web3.eth.getAccounts();
      // Skip account[0] (deployer/admin) — user gets accounts starting from index 1
      const accounts = allAccounts.slice(1);
      const deployed = await storageService.getDeployedContracts();
      const userContracts = await storageService.getUserContracts();

      // Contract map: the player's own contracts first (latest deployment wins)
      // and challenge contracts last, so a name clash never hides a challenge contract.
      const contracts = {};
      for (const c of [...(userContracts || []), ...(deployed || [])]) {
        const name = c.contractName || c.title || c.fileName;
        if (name && c.abi && c.address) {
          contracts[name] = new web3.eth.Contract(c.abi, c.address);
        }
      }

      // Helper: create contract with ABI auto-fix (adds missing 'name' fields)
      function getContract(abi, address) {
        const fixedAbi = abi.map(item => {
          const fixed = { ...item };
          if (fixed.inputs) fixed.inputs = fixed.inputs.map(i => ({ name: '', ...i }));
          if (fixed.outputs) fixed.outputs = fixed.outputs.map(o => ({ name: '', ...o }));
          return fixed;
        });
        return new web3.eth.Contract(fixedAbi, address);
      }

      // Capture console.log output
      const logs = [];
      const mockConsole = {
        log: (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' ')),
        error: (...args) => logs.push('ERROR: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
        warn: (...args) => logs.push('WARN: ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
      };

      // Execute in async function with context
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFunction('web3', 'accounts', 'contracts', 'console', 'getContract', code);
      const result = await fn(web3, accounts, contracts, mockConsole, getContract);

      return { success: true, output: logs.join('\n'), result: result !== undefined ? String(result) : null };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  // ─── Navigation ──────────────────────────────────────────────────────────
  ipcMain.handle('navigation:go', async (_event, view) => {
    // SPA navigation handled in renderer; this is a fallback
    return { success: true, view };
  });

  // ─── System ──────────────────────────────────────────────────────────────
  ipcMain.handle('system:version', async () => {
    return app.getVersion();
  });

  ipcMain.handle('system:open-external', async (_event, url) => {
    // Only allow http/https URLs
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
    }
    return { success: true };
  });

  ipcMain.handle('system:clipboard-write', async (_event, text) => {
    clipboard.writeText(text);
    return { success: true };
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  initializeServices();
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (anvilService && anvilService.isRunning()) {
    anvilService.stop().catch(() => {});
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async () => {
  if (anvilService && anvilService.isRunning()) {
    await anvilService.stop().catch(() => {});
  }
});
