'use strict';

const { spawn } = require('child_process');
const { Logger } = require('../utils/logger');

const logger = new Logger('anvil');

/**
 * AnvilService — Manages a local Anvil (Foundry) Ethereum node.
 * Replaces Ganache with a modern, actively maintained alternative.
 */
class AnvilService {
  constructor(options = {}) {
    this.port = options.port || 8545;
    this.chainId = options.chainId || 31337;
    this.accounts = options.accounts || 10;
    this.balance = options.balance || 10000; // ETH per account
    this.blockTime = options.blockTime || 0; // 0 = instant mining
    this.mnemonic = options.mnemonic || 'candy maple cake sugar pudding cream honey rich smooth crumble sweet treat';
    this.forkUrl = options.forkUrl || null;
    this.forkBlockNumber = options.forkBlockNumber || null;

    this._process = null;
    this._running = false;
    this._ready = false;
  }

  /**
   * Start the Anvil node.
   * First tries native `anvil` binary, then falls back to Docker.
   */
  async start() {
    if (this._running) {
      logger.warn('Anvil is already running');
      return;
    }

    const args = this._buildArgs();

    try {
      // Try native anvil binary first
      await this._startNative(args);
    } catch (_nativeErr) {
      logger.info('Native anvil not found, falling back to Docker');
      await this._startDocker(args);
    }

    // Wait for Anvil to be ready
    await this._waitForReady();
    this._running = true;
    this._ready = true;
    logger.info(`Anvil started on port ${this.port} (chainId: ${this.chainId})`);
  }

  /**
   * Stop the Anvil node.
   */
  async stop() {
    if (!this._running) return;

    if (this._process) {
      // Native mode — SIGTERM with SIGKILL fallback
      await this._killProcess(this._process);
      this._process = null;
    } else {
      // Docker mode — stop container
      await this._execCommand('docker', ['stop', '-t', '5', 'polonio-anvil']).catch(() => {});
      await this._execCommand('docker', ['rm', '-f', 'polonio-anvil']).catch(() => {});
    }

    this._running = false;
    this._ready = false;
    logger.info('Anvil stopped');
  }

  /**
   * Kill a child process gracefully (SIGTERM), with SIGKILL fallback after timeout.
   */
  _killProcess(proc, timeoutMs = 5000) {
    return new Promise((resolve) => {
      if (!proc || proc.killed) { resolve(); return; }

      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      proc.on('exit', done);
      proc.on('error', done);

      proc.kill('SIGTERM');

      setTimeout(() => {
        if (!resolved && !proc.killed) {
          logger.warn('Anvil did not stop gracefully, sending SIGKILL');
          proc.kill('SIGKILL');
        }
        done();
      }, timeoutMs);
    });
  }

  /**
   * Check if Anvil is running.
   */
  isRunning() {
    return this._running && this._ready;
  }

  /**
   * Get the chain ID.
   */
  getChainId() {
    return this.chainId;
  }

  /**
   * Get the mnemonic used for account generation.
   */
  getMnemonic() {
    return this.mnemonic;
  }

  /**
   * Get the RPC URL.
   */
  getRpcUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  // ─── Private Methods ───────────────────────────────────────────────────────

  _buildArgs() {
    const args = [
      '--port', String(this.port),
      '--chain-id', String(this.chainId),
      '--accounts', String(this.accounts),
      '--balance', String(this.balance),
      '--mnemonic', this.mnemonic,
      // Bind to loopback only — this is a local training node and must not be
      // reachable from other hosts on the network.
      '--host', '127.0.0.1',
    ];

    if (this.blockTime > 0) {
      args.push('--block-time', String(this.blockTime));
    }

    if (this.forkUrl) {
      args.push('--fork-url', this.forkUrl);
      if (this.forkBlockNumber) {
        args.push('--fork-block-number', String(this.forkBlockNumber));
      }
    }

    return args;
  }

  _startNative(args) {
    return new Promise((resolve, reject) => {
      try {
        this._process = spawn('anvil', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        this._process.on('error', (err) => {
          this._process = null;
          reject(err);
        });

        // Give it a moment to see if it starts
        setTimeout(() => {
          if (this._process && !this._process.killed) {
            resolve();
          } else {
            reject(new Error('Anvil process exited immediately'));
          }
        }, 500);

        this._process.stderr.on('data', (data) => {
          const msg = data.toString();
          if (msg.includes('error') || msg.includes('Error')) {
            logger.error('Anvil stderr:', msg);
          }
        });

        this._process.on('exit', (code) => {
          if (this._running) {
            logger.warn(`Anvil exited unexpectedly with code ${code}`);
            this._running = false;
            this._ready = false;
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async _startDocker(args) {
    // Remove existing container if any
    await this._execCommand('docker', ['rm', '-f', 'polonio-anvil']).catch(() => {});

    // Build the anvil command with proper quoting for the mnemonic
    // The foundry image uses /bin/sh -c as entrypoint
    const anvilParts = [
      '--port', String(this.port),
      '--chain-id', String(this.chainId),
      '--accounts', String(this.accounts),
      '--balance', String(this.balance),
      '--host', '0.0.0.0',
    ];

    if (this.blockTime > 0) {
      anvilParts.push('--block-time', String(this.blockTime));
    }

    if (this.forkUrl) {
      anvilParts.push('--fork-url', this.forkUrl);
      if (this.forkBlockNumber) {
        anvilParts.push('--fork-block-number', String(this.forkBlockNumber));
      }
    }

    // Quote the mnemonic to avoid shell word splitting
    const anvilCmd = `anvil ${anvilParts.join(' ')} --mnemonic "${this.mnemonic}"`;

    // Publish the port on the host loopback only. Anvil inside the container
    // still binds 0.0.0.0 (required for Docker's port forwarding to work), but
    // the node is never exposed beyond 127.0.0.1 on the host.
    const dockerArgs = [
      'run', '-d',
      '--name', 'polonio-anvil',
      '-p', `127.0.0.1:${this.port}:${this.port}`,
      'ghcr.io/foundry-rs/foundry:latest',
      anvilCmd,
    ];

    await this._execCommand('docker', dockerArgs);
  }

  _waitForReady(maxAttempts = 30, intervalMs = 500) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const http = require('http');

      const check = () => {
        attempts++;
        const postData = JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id: 1,
        });

        const options = {
          hostname: '127.0.0.1',
          port: this.port,
          path: '/',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 2000,
        };

        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.result) {
                resolve();
              } else if (attempts < maxAttempts) {
                setTimeout(check, intervalMs);
              } else {
                reject(new Error('Anvil did not return valid chain ID'));
              }
            } catch {
              if (attempts < maxAttempts) {
                setTimeout(check, intervalMs);
              } else {
                reject(new Error('Anvil returned invalid JSON'));
              }
            }
          });
        });

        req.on('error', () => {
          if (attempts < maxAttempts) {
            setTimeout(check, intervalMs);
          } else {
            reject(new Error(`Anvil not ready after ${maxAttempts} attempts`));
          }
        });

        req.on('timeout', () => {
          req.destroy();
          if (attempts < maxAttempts) {
            setTimeout(check, intervalMs);
          } else {
            reject(new Error('Anvil connection timed out'));
          }
        });

        req.write(postData);
        req.end();
      };

      check();
    });
  }

  _execCommand(command, args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`${command} exited with ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });
  }
}

module.exports = { AnvilService };
