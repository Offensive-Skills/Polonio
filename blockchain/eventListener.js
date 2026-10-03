'use strict';

const { Logger } = require('../utils/logger');

const logger = new Logger('events');

/**
 * EventListener — Subscribes to smart contract events in real-time.
 * Forwards events to the renderer via IPC.
 */
class EventListener {
  constructor(web3Provider, mainWindow) {
    this.web3Provider = web3Provider;
    this.mainWindow = mainWindow;
    this._subscriptions = new Map();
    this._history = [];
    this._seenKeys = new Set();
    this._maxHistory = 500;
    this._nextId = 1;
  }

  /**
   * Subscribe to all events from a contract.
   * @param {string} address - Contract address
   * @param {any[]} abi - Contract ABI
   * @returns {{ subscriptionId }}
   */
  async subscribe(address, abi) {
    const web3 = this.web3Provider.getWeb3();
    const contract = new web3.eth.Contract(abi, address);
    const subscriptionId = `sub_${this._nextId++}`;

    // Start tracking from current block
    let lastCheckedBlock = Number(await web3.eth.getBlockNumber());

    // For HTTP provider, we use polling
    const pollInterval = setInterval(async () => {
      try {
        const latestBlock = Number(await web3.eth.getBlockNumber());
        if (latestBlock <= lastCheckedBlock) return; // No new blocks

        const fromBlock = lastCheckedBlock + 1;

        const events = await contract.getPastEvents('allEvents', {
          fromBlock,
          toBlock: latestBlock,
        });

        // Update tracker before processing to avoid re-processing on error
        lastCheckedBlock = latestBlock;

        for (const event of events) {
          const eventData = {
            subscriptionId,
            address,
            eventName: event.event,
            returnValues: this._serializeReturnValues(event.returnValues),
            blockNumber: event.blockNumber != null ? Number(event.blockNumber) : null,
            transactionHash: event.transactionHash,
            logIndex: event.logIndex != null ? Number(event.logIndex) : null,
            timestamp: new Date().toISOString(),
          };

          // Deduplicate by tx hash + log index
          const key = `${event.transactionHash}-${event.logIndex}`;
          if (!this._seenKeys.has(key)) {
            this._seenKeys.add(key);
            this._history.push(eventData);
            if (this._history.length > this._maxHistory) {
              this._history.shift();
            }

            // Send to renderer
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('events:new-event', eventData);
            }
          }
        }
      } catch (err) {
        // Silently fail on poll errors (blockchain might be restarting)
      }
    }, 3000);

    this._subscriptions.set(subscriptionId, {
      address,
      interval: pollInterval,
    });

    logger.info(`Subscribed to events on ${address} (${subscriptionId})`);
    return { subscriptionId };
  }

  /**
   * Unsubscribe from a specific subscription.
   */
  unsubscribe(subscriptionId) {
    const sub = this._subscriptions.get(subscriptionId);
    if (sub) {
      clearInterval(sub.interval);
      this._subscriptions.delete(subscriptionId);
      logger.info(`Unsubscribed ${subscriptionId}`);
    }
  }

  /**
   * Unsubscribe from all subscriptions.
   */
  unsubscribeAll() {
    for (const [id, sub] of this._subscriptions) {
      clearInterval(sub.interval);
    }
    this._subscriptions.clear();
    this._seenKeys.clear();
    logger.info('All subscriptions cleared');
  }

  /**
   * Get event history.
   */
  getHistory() {
    return this._history;
  }

  /**
   * Clear event history.
   */
  clearHistory() {
    this._history = [];
    this._seenKeys.clear();
  }

  _serializeReturnValues(returnValues) {
    if (!returnValues) return {};
    const result = {};
    for (const [key, value] of Object.entries(returnValues)) {
      if (!isNaN(key)) continue;
      result[key] = typeof value === 'bigint' ? value.toString() : value;
    }
    return result;
  }
}

module.exports = { EventListener };
