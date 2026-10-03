'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeStorage } = require('electron');
const { Logger } = require('../utils/logger');

const logger = new Logger('auth');

const API_BASE = 'https://polonio.offs.es';

/**
 * AuthController — Handles user authentication.
 * Uses the API token for authenticating requests, stored securely.
 */
class AuthController {
  constructor() {
    this._session = null;
    this._credentialsPath = path.join(
      os.homedir(), '.local', 'share', 'polonio', 'credentials.enc'
    );
    this._loadSavedSession();
  }

  /**
   * Login with username and API token.
   * Validates against the Polonio API.
   */
  async login(username, apiToken, remember = false) {
    if (!username || !apiToken) {
      return { success: false, error: 'Username and API token are required' };
    }

    // Validate token against the API by making a test request
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${API_BASE}/getChallenges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: apiToken, level: 'facil' }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        return { success: false, error: data.error || 'Invalid credentials' };
      }

      // Token is valid — store session
      this._session = {
        username,
        token: apiToken,
        loginTime: new Date().toISOString(),
      };

      // "Remember me" — persist encrypted via safeStorage, or forget any
      // previously stored credentials if the option is disabled.
      if (remember) {
        try {
          this.saveCredentials(username, apiToken);
        } catch (err) {
          logger.warn('No se pudieron guardar las credenciales', err);
        }
      } else {
        this._clearSavedSession();
      }

      logger.info(`User "${username}" logged in successfully`);
      return { success: true, username };
    } catch (err) {
      logger.error('Login failed', err);
      if (err.name === 'AbortError') {
        return { success: false, error: 'La API de Polonio no responde (timeout). Comprueba tu conexión.' };
      }
      return { success: false, error: 'No se puede conectar con la API de Polonio. Comprueba tu conexión.' };
    }
  }

  /**
   * Logout — clear session.
   */
  logout() {
    this._session = null;
    this._clearSavedSession();
    logger.info('User logged out');
    return { success: true };
  }

  /**
   * Get current session info (without exposing the raw token).
   * Triggers revalidation of saved sessions.
   */
  async getSession() {
    if (!this._session) {
      return { authenticated: false };
    }

    // Revalidate saved sessions against the API
    if (this._session.needsRevalidation) {
      const valid = await this.revalidateSession();
      if (!valid) {
        return { authenticated: false, error: 'Token expirado, inicia sesión de nuevo' };
      }
    }

    return {
      authenticated: true,
      username: this._session.username,
      loginTime: this._session.loginTime,
    };
  }

  /**
   * Get the current API token (for internal use only).
   */
  getToken() {
    if (!this._session) {
      throw new Error('Not authenticated');
    }
    return this._session.token;
  }

  /**
   * Check if user is authenticated.
   */
  isAuthenticated() {
    return this._session !== null;
  }

  /**
   * Save credentials encrypted (for "remember me" functionality).
   * Uses Electron's safeStorage, which is backed by the OS keychain
   * (libsecret/Keychain/DPAPI) — the key never lives in the app.
   * @returns {boolean} true if credentials were persisted.
   */
  saveCredentials(username, apiToken) {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn('safeStorage no disponible en este sistema — no se guardan credenciales en disco');
      return false;
    }

    const data = JSON.stringify({ username, apiToken });
    const encrypted = safeStorage.encryptString(data);

    const dir = path.dirname(this._credentialsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this._credentialsPath, encrypted);
    fs.chmodSync(this._credentialsPath, 0o600);
    return true;
  }

  /**
   * Load saved credentials, decrypting via safeStorage.
   * Returns null if nothing is stored, the OS keychain is unavailable, or the
   * stored blob cannot be decrypted (e.g. a file from another machine/profile).
   */
  loadCredentials() {
    if (!fs.existsSync(this._credentialsPath)) {
      return null;
    }
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return null;
      }
      const encrypted = fs.readFileSync(this._credentialsPath);
      const decrypted = safeStorage.decryptString(encrypted);
      return JSON.parse(decrypted);
    } catch (err) {
      logger.warn('Failed to load saved credentials', err);
      return null;
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _loadSavedSession() {
    const creds = this.loadCredentials();
    if (creds) {
      this._session = {
        username: creds.username,
        token: creds.apiToken,
        loginTime: null, // Not a fresh login — will be revalidated on first API call
        needsRevalidation: true,
      };
    }
  }

  /**
   * Revalidate the stored token against the API.
   * Called lazily on first getToken() usage after loading saved session.
   * If token is invalid, clears the session so the user is prompted to re-login.
   */
  async revalidateSession() {
    if (!this._session || !this._session.needsRevalidation) return true;

    try {
      const response = await fetch(`${API_BASE}/getChallenges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: this._session.token, level: 'facil' }),
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        this._session.needsRevalidation = false;
        return true;
      } else {
        logger.warn('Saved token is no longer valid, clearing session');
        this._session = null;
        this._clearSavedSession();
        return false;
      }
    } catch (err) {
      // API unreachable — keep session but don't mark as validated
      // (will try again next time)
      logger.warn('Cannot revalidate token (API unreachable)', err.message);
      return true; // Allow offline usage, will fail on actual API calls
    }
  }

  _clearSavedSession() {
    if (fs.existsSync(this._credentialsPath)) {
      fs.unlinkSync(this._credentialsPath);
    }
  }
}

module.exports = { AuthController };
