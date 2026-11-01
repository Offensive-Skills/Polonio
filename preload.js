'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script — Bridge seguro entre el renderer process y el main process.
 * Expone SOLO las APIs necesarias vía contextBridge.
 * El renderer NO tiene acceso a Node.js, fs, child_process, etc.
 */

contextBridge.exposeInMainWorld('polonio', {
  // ─── Autenticación ─────────────────────────────────────────────
  auth: {
    login: (username, apiToken, remember) => ipcRenderer.invoke('auth:login', username, apiToken, remember),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getSession: () => ipcRenderer.invoke('auth:get-session'),
  },

  // ─── Blockchain Management ────────────────────────────────────
  blockchain: {
    start: () => ipcRenderer.invoke('blockchain:start'),
    stop: () => ipcRenderer.invoke('blockchain:stop'),
    restart: () => ipcRenderer.invoke('blockchain:restart'),
    getStatus: () => ipcRenderer.invoke('blockchain:status'),
    getInfo: () => ipcRenderer.invoke('blockchain:info'),
    getAccounts: () => ipcRenderer.invoke('blockchain:accounts'),
  },

  // ─── Challenges ───────────────────────────────────────────────
  challenges: {
    list: (level) => ipcRenderer.invoke('challenges:list', level),
    getImage: (challengeName) => ipcRenderer.invoke('challenges:image', challengeName),
    getSmartcontracts: (challengeName) => ipcRenderer.invoke('challenges:smartcontracts', challengeName),
    activate: (challengeName) => ipcRenderer.invoke('challenges:activate', challengeName),
    validate: (challengeName) => ipcRenderer.invoke('challenges:validate', challengeName),
    complete: (challengeName, complete) => ipcRenderer.invoke('challenges:complete', challengeName, complete),
    getWriteup: (challengeName) => ipcRenderer.invoke('challenges:writeup', challengeName),
    getHints: (challengeName) => ipcRenderer.invoke('challenges:hints', challengeName),
    revealHint: (challengeName) => ipcRenderer.invoke('challenges:reveal-hint', challengeName),
    getActive: () => ipcRenderer.invoke('challenges:get-active'),
  },

  // ─── Contracts ────────────────────────────────────────────────
  contracts: {
    interact: (data) => ipcRenderer.invoke('contracts:interact', data),
    sendRaw: (data) => ipcRenderer.invoke('contracts:send-raw', data),
    getCode: (challengeName, scName) => ipcRenderer.invoke('contracts:code', challengeName, scName),
    getRegistry: () => ipcRenderer.invoke('contracts:registry'),
    getAbi: (address) => ipcRenderer.invoke('contracts:abi', address),
    getSource: (address) => ipcRenderer.invoke('contracts:source', address),
    deployUser: (data) => ipcRenderer.invoke('contracts:deploy-user', data),
  },

  // ─── Storage Inspector ────────────────────────────────────────
  inspector: {
    readStorage: (address, slot) => ipcRenderer.invoke('inspector:read-storage', address, slot),
    getBalance: (address) => ipcRenderer.invoke('inspector:balance', address),
    getCode: (address) => ipcRenderer.invoke('inspector:code', address),
    getTransactionReceipt: (txHash) => ipcRenderer.invoke('inspector:tx-receipt', txHash),
  },

  // ─── Event Listener ───────────────────────────────────────────
  events: {
    subscribe: (address, abi) => ipcRenderer.invoke('events:subscribe', address, abi),
    unsubscribe: (subscriptionId) => ipcRenderer.invoke('events:unsubscribe', subscriptionId),
    getHistory: () => ipcRenderer.invoke('events:history'),
    onNewEvent: (callback) => {
      const channel = 'events:new-event';
      const subscription = (_event, data) => callback(data);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    },
  },

  // ─── Transaction Logger ───────────────────────────────────────
  transactions: {
    getHistory: () => ipcRenderer.invoke('transactions:history'),
    clear: () => ipcRenderer.invoke('transactions:clear'),
    onNewTransaction: (callback) => {
      const channel = 'transactions:new';
      const subscription = (_event, data) => callback(data);
      ipcRenderer.on(channel, subscription);
      return () => ipcRenderer.removeListener(channel, subscription);
    },
  },

  // ─── Navigation ───────────────────────────────────────────────
  navigation: {
    navigate: (view) => ipcRenderer.invoke('navigation:go', view),
  },

  // ─── Compiler ─────────────────────────────────────────────────
  compiler: {
    compile: (source, version) => ipcRenderer.invoke('compiler:compile', source, version),
    getVersions: () => ipcRenderer.invoke('compiler:versions'),
  },

  // ─── Script Execution ─────────────────────────────────────────
  script: {
    execute: (code) => ipcRenderer.invoke('script:execute', code),
  },

  // ─── System ───────────────────────────────────────────────────
  system: {
    getVersion: () => ipcRenderer.invoke('system:version'),
    openExternal: (url) => ipcRenderer.invoke('system:open-external', url),
    copyToClipboard: (text) => ipcRenderer.invoke('system:clipboard-write', text),
  },
});
