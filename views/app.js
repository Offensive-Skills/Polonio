'use strict';

const LEVELS = ['facil', 'medio', 'dificil'];
const EDITOR_STORAGE_KEY = 'polonio.editor.source';
const INDENT = '    ';
const RAW_TX = '__raw__';

const state = {
  authenticated: false,
  blockchainRunning: false,
  currentView: 'dashboard',
  selectedChallenge: null,
  selectedContractName: null,

  // Challenges: full catalog, filtered client-side so filters and search
  // survive navigation and apply instantly.
  catalog: [],
  activeChallengeNames: new Set(),
  challengeFilters: { level: 'all', query: '' },

  // Contracts deployed in the current chain session (challenge + player's).
  registry: [],
  accounts: [], // player accounts: [{ index, address, balance }]

  // Quick interaction: ABI info of the selected contract.
  interact: { address: '', functions: [], hasFallback: false, hasReceive: false },
  sourceView: null,
  detailSource: '',
};

// Monotonic ids to discard responses of superseded async requests.
const requests = { challenges: 0, detail: 0, code: 0, abi: 0, source: 0 };

// ─── DOM helpers ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

/** Create an element. `props` supports className, dataset, text and attributes. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function shortAddress(address) {
  const a = String(address || '');
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}

/** Clickable chip that copies an address (handled by the global [data-copy] listener). */
function addressChip(address, { short = false } = {}) {
  return el('span', {
    className: 'address-chip',
    role: 'button',
    tabindex: '0',
    title: `${address}\nClick para copiar`,
    dataset: { copy: address },
    text: short ? shortAddress(address) : address,
  });
}

async function copyText(text, message = 'Copiado al portapapeles') {
  if (!text) return;
  await window.polonio.system.copyToClipboard(String(text));
  showToast(message, 'success', 1800);
}

/**
 * Escape `text` and turn addresses / hashes into copyable spans.
 * The regex runs on already-escaped text and only matches hex characters.
 */
function linkifyHex(text) {
  return esc(text).replace(/\b0x[0-9a-fA-F]{64}\b|\b0x[0-9a-fA-F]{40}\b/g,
    (hex) => `<span class="hex-copy" data-copy="${hex}" title="Click para copiar">${hex}</span>`);
}

function normalizeSearch(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ─── Feedback ────────────────────────────────────────────────────────────────

function showToast(msg, type = 'info', duration = 3500) {
  const c = $('toast-container');
  const t = el('div', { className: `toast toast-${type}`, text: msg });
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
}

function terminalLog(msg, type = 'info') {
  const c = $('terminal-content');
  const e = document.createElement('div');
  e.className = 'terminal-entry';
  const ts = new Date().toLocaleTimeString('es-ES', { hour12: false });
  e.innerHTML = `<span class="terminal-timestamp">[${ts}]</span> <span class="terminal-message ${esc(type)}">${linkifyHex(msg)}</span>`;
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
}

function consoleOutput(msg, type = 'info') {
  const c = $('console-output');
  const e = document.createElement('div');
  e.className = `console-line console-${type}`;
  e.innerHTML = linkifyHex(typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2));
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
}

function formatValue(value) {
  if (value === null || value === undefined) return String(value);
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function navigateTo(viewId) {
  document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
  const target = $(`view-${viewId}`);
  if (target) target.classList.add('active');
  const navView = viewId === 'challenge-detail' ? 'challenges' : viewId;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === navView));
  const titles = { dashboard: 'Dashboard', challenges: 'Retos', 'challenge-detail': 'Detalle', console: 'Consola', inspector: 'Inspector', settings: 'Configuracion' };
  $('view-title').textContent = titles[viewId] || 'Polonio';
  state.currentView = viewId;
}

/** Navigate to a view and refresh the data it shows. */
async function showView(viewId) {
  navigateTo(viewId);
  switch (viewId) {
    case 'challenges': return loadChallenges();
    case 'dashboard': return loadDashboard();
    case 'console':
    case 'inspector':
      return Promise.all([refreshContracts(), refreshAccounts()]);
    default: return undefined;
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────────

function enterApp(username) {
  state.authenticated = true;
  $('login-view').style.display = 'none';
  $('app-shell').style.display = 'flex';
  $('settings-username').textContent = username;
  loadDashboard();
}

async function handleLogin(e) {
  e.preventDefault();
  const user = $('login-username').value.trim();
  const token = $('login-token').value.trim();
  const remember = $('login-remember').checked;
  const errEl = $('login-error');
  const spin = $('login-spinner');
  const txt = $('login-btn-text');
  errEl.classList.remove('visible');
  spin.style.display = 'block'; txt.style.display = 'none';

  const res = await window.polonio.auth.login(user, token, remember);
  spin.style.display = 'none'; txt.style.display = 'inline';

  if (res.success) {
    terminalLog(`Sesion iniciada: ${user}`);
    enterApp(user);
  } else {
    errEl.textContent = res.error || 'Credenciales invalidas';
    errEl.classList.add('visible');
  }
}

async function handleLogout() {
  await window.polonio.auth.logout();
  state.authenticated = false;
  state.catalog = [];
  state.activeChallengeNames = new Set();
  $('app-shell').style.display = 'none';
  $('login-view').style.display = 'flex';
}

// ─── Blockchain ──────────────────────────────────────────────────────────────

async function startBlockchain() {
  terminalLog('Iniciando nodo Anvil...');
  const res = await window.polonio.blockchain.start();
  if (res.success) {
    state.blockchainRunning = true;
    updateBlockchainUI(true);
    terminalLog('Nodo activo en http://127.0.0.1:8545', 'success');
    loadDashboard();
  } else {
    terminalLog(`Error: ${res.error}`, 'error');
    showToast(res.error, 'error');
  }
}

async function stopBlockchain() {
  const res = await window.polonio.blockchain.stop();
  if (res.success) {
    state.blockchainRunning = false;
    updateBlockchainUI(false);
    terminalLog('Nodo detenido');
    onChainStateLost();
  }
}

async function resetBlockchain() {
  if (!state.blockchainRunning) return;
  terminalLog('Reiniciando blockchain... Se eliminaran todos los contratos y se resetearan los saldos.', 'warning');
  const res = await window.polonio.blockchain.restart();
  if (res.success) {
    showToast('Blockchain reiniciada', 'success');
    terminalLog('Blockchain reiniciada correctamente', 'success');
    onChainStateLost();
    loadDashboard();
  } else {
    showToast(`Error: ${res.error}`, 'error');
    terminalLog(`Error al reiniciar: ${res.error}`, 'error');
  }
}

/** Every deployment is gone (node stopped, restarted or crashed). */
function onChainStateLost() {
  state.activeChallengeNames = new Set();
  refreshContracts();
  refreshAccounts();
  if (state.currentView === 'challenges') renderChallenges();
  if (state.currentView === 'challenge-detail' && state.selectedChallenge) openChallengeDetail(state.selectedChallenge);
}

function updateBlockchainUI(running) {
  $('blockchain-dot').className = `status-dot status-dot-${running ? 'active' : 'inactive'}`;
  $('blockchain-status-text').textContent = running ? 'Conectado' : 'Desconectado';
  $('btn-start-blockchain').style.display = running ? 'none' : 'inline-flex';
  $('btn-stop-blockchain').style.display = running ? 'inline-flex' : 'none';
  $('btn-reset-blockchain').style.display = running ? 'inline-flex' : 'none';
  $('stat-status').textContent = running ? 'Activo' : 'Inactivo';
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function loadDashboard() {
  const status = await window.polonio.blockchain.getStatus();
  state.blockchainRunning = status.running;
  updateBlockchainUI(status.running);

  const listEl = $('accounts-list');
  if (!status.running) {
    $('stat-block').textContent = '--';
    listEl.replaceChildren(el('p', { className: 'text-muted', text: 'Inicia el nodo para ver las cuentas.' }));
    state.accounts = [];
    updateKnownAddresses();
    refreshContracts();
    return;
  }

  const info = await window.polonio.blockchain.getInfo();
  if (info.running) {
    $('stat-block').textContent = info.blockNumber || '0';
    $('stat-chain').textContent = info.chainId || '31337';
    if (Array.isArray(info.accounts) && info.accounts.length) {
      setAccounts(info.accounts);
      // Skip account[0] (deployer/admin)
      listEl.replaceChildren(...state.accounts.map((a, i) => el('div', { className: 'account-row' }, [
        el('span', { className: 'account-index', text: i }),
        addressChip(a.address),
        el('span', { className: 'account-balance', text: `${parseFloat(a.balance).toFixed(2)} ETH` }),
      ])));
    }
  }

  const [active] = await Promise.all([window.polonio.challenges.getActive(), refreshContracts()]);
  $('stat-challenges').textContent = active.length || '0';
}

// ─── Challenges ──────────────────────────────────────────────────────────────

/**
 * Fetch the catalog (every level) and the deployed challenges, then render
 * with the current filters. A cached catalog is rendered immediately so
 * returning to the view never flashes unfiltered or empty results.
 */
async function loadChallenges() {
  syncChallengeFilterControls();
  const grid = $('challenges-grid');
  if (!state.blockchainRunning) {
    grid.replaceChildren(el('p', { className: 'text-muted challenges-empty', text: 'Inicia el nodo para cargar los retos.' }));
    $('challenges-count').textContent = '';
    return;
  }

  const requestId = ++requests.challenges;
  if (state.catalog.length) {
    renderChallenges();
  } else {
    grid.replaceChildren(el('div', { className: 'spinner spinner-lg challenges-empty', style: 'margin:auto;' }));
  }

  try {
    const [lists, active] = await Promise.all([
      Promise.all(LEVELS.map(level => window.polonio.challenges.list(level))),
      window.polonio.challenges.getActive(),
    ]);
    if (requestId !== requests.challenges) return;

    const failed = lists.filter(res => !Array.isArray(res));
    if (failed.length === lists.length) {
      throw new Error((failed[0] && failed[0].error) || 'No se pudieron cargar los retos');
    }
    if (failed.length) {
      terminalLog(`Algunos niveles no se pudieron cargar: ${failed.map(f => f && f.error).filter(Boolean).join('; ')}`, 'error');
    }

    // Tag each challenge with the level it was listed under: filtering never
    // depends on how the API spells the level field.
    state.catalog = lists.flatMap((res, i) => (Array.isArray(res) ? res.map(ch => ({ ...ch, level: ch.level || LEVELS[i], _level: LEVELS[i] })) : []));
    state.activeChallengeNames = new Set((Array.isArray(active) ? active : []).map(a => a.challengeName));
    renderChallenges();
  } catch (err) {
    if (requestId !== requests.challenges) return;
    if (!state.catalog.length) {
      grid.replaceChildren(el('p', { className: 'text-error challenges-empty', text: err.message || String(err) }));
      $('challenges-count').textContent = '';
    } else {
      showToast(`No se pudo actualizar el listado: ${err.message || err}`, 'error');
    }
  }
}

function filteredChallenges() {
  const { level, query } = state.challengeFilters;
  const q = normalizeSearch(query.trim());
  return state.catalog.filter((ch) => {
    if (level === 'active' && !state.activeChallengeNames.has(ch.name)) return false;
    if (level !== 'all' && level !== 'active' && ch._level !== level) return false;
    return !q || normalizeSearch(ch.name).includes(q);
  });
}

function renderChallenges() {
  const grid = $('challenges-grid');
  const { level, query } = state.challengeFilters;
  const challenges = filteredChallenges();
  const total = state.catalog.length;

  $('challenges-count').textContent = challenges.length === total
    ? `${total} reto${total === 1 ? '' : 's'}`
    : `${challenges.length} de ${total} retos`;

  if (!challenges.length) {
    let message = 'No hay retos disponibles.';
    if (query.trim()) message = `Ningun reto coincide con "${query.trim()}"${level !== 'all' ? ' en este filtro' : ''}.`;
    else if (level === 'active') message = 'No tienes retos desplegados.';
    grid.replaceChildren(el('p', { className: 'text-muted challenges-empty', text: message }));
    return;
  }

  grid.replaceChildren(...challenges.map(ch => challengeCard(ch, query.trim())));
}

function challengeCard(ch, query) {
  const deployed = state.activeChallengeNames.has(ch.name);
  const open = () => openChallengeDetail(ch);
  return el('div', {
    className: 'challenge-card',
    role: 'button',
    tabindex: '0',
    dataset: { name: ch.name },
    onclick: open,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
  }, [
    el('div', { className: 'challenge-card-level', dataset: { level: ch._level }, text: levelLabel(ch.level) }),
    el('div', { className: 'challenge-card-title' }, highlightMatch(ch.name, query)),
    el('div', { className: 'challenge-card-desc', text: ch.description || '' }),
    el('div', { className: 'challenge-card-footer' }, [
      deployed ? el('span', { className: 'challenge-card-deployed', text: 'Desplegado' }) : el('span', { className: 'text-muted', style: 'font-size:11px;', text: levelLabel(ch.level) }),
      ch.completed ? el('span', { className: 'challenge-card-completed', text: 'Completado' }) : null,
    ]),
  ]);
}

/**
 * Nodes for `text` with the (accent/case-insensitive) match of `query` wrapped
 * in <mark>. Characters are normalized one by one to map positions back.
 */
function highlightMatch(text, query) {
  const source = String(text || '');
  const q = normalizeSearch(query);
  if (!q) return [source];

  let normalized = '';
  const origin = []; // normalized index -> original index
  Array.from(source).reduce((offset, char) => {
    const n = normalizeSearch(char);
    for (let k = 0; k < n.length; k++) origin.push(offset);
    normalized += n;
    return offset + char.length;
  }, 0);

  const at = normalized.indexOf(q);
  if (at < 0) return [source];
  const start = origin[at];
  const endNorm = at + q.length;
  const end = endNorm < origin.length ? origin[endNorm] : source.length;
  return [source.slice(0, start), el('mark', { text: source.slice(start, end) }), source.slice(end)];
}

function setChallengeLevel(level) {
  state.challengeFilters.level = level;
  syncChallengeFilterControls();
  renderChallenges();
}

function setChallengeQuery(query) {
  state.challengeFilters.query = query;
  syncChallengeFilterControls();
  renderChallenges();
}

/** Reflect the filter state in the controls (buttons + search box). */
function syncChallengeFilterControls() {
  const { level, query } = state.challengeFilters;
  document.querySelectorAll('.filter-btn[data-level]').forEach((btn) => {
    const active = btn.dataset.level === level;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const input = $('challenge-search');
  if (input.value !== query) input.value = query;
  $('challenge-search-clear').hidden = !query;
}

function levelLabel(l) {
  const m = { facil: 'BASICO', medio: 'INTERMEDIO', dificil: 'AVANZADO', insano: 'EXPERTO' };
  return m[l] || String(l || '').toUpperCase();
}

// ─── Challenge Detail ────────────────────────────────────────────────────────

async function openChallengeDetail(ch) {
  const sameChallenge = state.selectedChallenge && state.selectedChallenge.name === ch.name;
  state.selectedChallenge = ch;
  if (!sameChallenge) state.selectedContractName = null;
  const requestId = ++requests.detail;
  navigateTo('challenge-detail');
  $('detail-challenge-name').textContent = ch.name;
  $('detail-challenge-desc').textContent = ch.description || '';

  const [active, contracts] = await Promise.all([
    window.polonio.challenges.getActive(),
    window.polonio.challenges.getSmartcontracts(ch.name).catch(() => []),
  ]);
  if (requestId !== requests.detail) return;

  const activeEntry = (Array.isArray(active) ? active : []).find(c => c.challengeName === ch.name) || null;
  const isActive = Boolean(activeEntry);

  $('btn-activate-challenge').style.display = isActive ? 'none' : 'inline-flex';
  $('btn-validate-challenge').style.display = isActive ? 'inline-flex' : 'none';
  $('btn-writeup-challenge').style.display = isActive ? 'inline-flex' : 'none';
  $('btn-mark-completed').style.display = (isActive && !ch.completed) ? 'inline-flex' : 'none';
  $('detail-challenge-badge').replaceChildren(
    ch.completed ? el('span', { className: 'badge badge-completed', text: 'COMPLETADO' })
      : (isActive ? el('span', { className: 'badge badge-active', text: 'DESPLEGADO' }) : '')
  );

  const listEl = $('detail-contracts-list');
  if (!Array.isArray(contracts) || !contracts.length) {
    listEl.replaceChildren(el('p', { className: 'text-muted', text: 'Sin contratos definidos.' }));
    Render.codePlaceholder($('detail-code-display'), '// Sin contratos definidos.');
    state.detailSource = '';
    return;
  }

  const deployedByName = new Map(((activeEntry && activeEntry.contracts) || []).map(c => [c.name, c.address]));
  listEl.replaceChildren(...contracts.map((sc) => {
    const address = deployedByName.get(sc.name);
    return el('div', {
      className: 'contract-item',
      role: 'button',
      tabindex: '0',
      dataset: { sc: sc.name },
      onclick: (e) => { if (!e.target.closest('[data-copy]')) loadContractCode(ch.name, sc.name); },
      onkeydown: (e) => { if (e.key === 'Enter' && !e.target.closest('[data-copy]')) loadContractCode(ch.name, sc.name); },
    }, [
      el('span', { className: 'contract-item-name', text: `${sc.name}.sol` }),
      address ? addressChip(address, { short: true }) : null,
    ]);
  }));

  const initial = contracts.some(sc => sc.name === state.selectedContractName) ? state.selectedContractName : contracts[0].name;
  loadContractCode(ch.name, initial);
}

async function loadContractCode(challengeName, scName) {
  state.selectedContractName = scName;
  const requestId = ++requests.code;
  $('detail-code-title').textContent = `${scName}.sol`;
  document.querySelectorAll('#detail-contracts-list .contract-item').forEach(item =>
    item.classList.toggle('active', item.dataset.sc === scName));

  const display = $('detail-code-display');
  try {
    const res = await window.polonio.contracts.getCode(challengeName, scName);
    if (requestId !== requests.code) return;
    state.detailSource = (res && res.contract) || '';
    if (state.detailSource) Render.codeView(display, state.detailSource, 'solidity');
    else Render.codePlaceholder(display, '// Sin contenido');
  } catch {
    if (requestId !== requests.code) return;
    state.detailSource = '';
    Render.codePlaceholder(display, '// Error al cargar el codigo');
  }
}

async function activateChallenge() {
  if (!state.selectedChallenge) return;
  const name = state.selectedChallenge.name;
  const btn = $('btn-activate-challenge');
  btn.disabled = true;
  terminalLog(`Desplegando reto: ${name}...`);

  try {
    const res = await window.polonio.challenges.activate(name);
    if (res.success) {
      terminalLog(`Desplegado: ${res.contracts.length} contrato(s)`, 'success');
      res.contracts.forEach(c => terminalLog(`  ${c.name} => ${c.address}`));
      showToast('Reto desplegado correctamente', 'success');
      state.activeChallengeNames.add(name);
      openChallengeDetail(state.selectedChallenge);
      refreshContracts();
    } else {
      terminalLog(`Error: ${res.error}`, 'error');
      showToast(res.error, 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

async function validateChallenge() {
  if (!state.selectedChallenge) return;
  const res = await window.polonio.challenges.validate(state.selectedChallenge.name);
  if (res.passed) {
    showToast('Reto completado', 'success');
    terminalLog(`COMPLETADO: ${state.selectedChallenge.name}`, 'success');
    await window.polonio.challenges.complete(state.selectedChallenge.name, true);
    markChallengeCompletedLocally(state.selectedChallenge.name);
    openChallengeDetail(state.selectedChallenge);
  } else {
    showToast(res.message || 'Aun no resuelto', 'warning');
    terminalLog(`Validacion fallida: ${res.message || res.error || 'condiciones no cumplidas'}`, 'error');
  }
}

async function markCompleted() {
  if (!state.selectedChallenge) return;
  await window.polonio.challenges.complete(state.selectedChallenge.name, true);
  markChallengeCompletedLocally(state.selectedChallenge.name);
  showToast('Reto marcado como completado', 'success');
  terminalLog(`Marcado completado: ${state.selectedChallenge.name}`, 'success');
  openChallengeDetail(state.selectedChallenge);
}

function markChallengeCompletedLocally(name) {
  state.selectedChallenge.completed = true;
  state.catalog.forEach((ch) => { if (ch.name === name) ch.completed = true; });
}

// ─── Writeup Viewer ──────────────────────────────────────────────────────────

let writeupReturnFocus = null;

async function openWriteup() {
  if (!state.selectedChallenge) return;
  const modal = $('writeup-modal');
  const body = $('writeup-modal-body');

  writeupReturnFocus = document.activeElement;
  $('writeup-modal-title').textContent = `Writeup — ${state.selectedChallenge.name}`;
  body.replaceChildren(el('div', { className: 'spinner spinner-lg', style: 'margin:auto;' }));
  modal.style.display = 'flex';
  $('writeup-modal-close').focus();

  try {
    const res = await window.polonio.challenges.getWriteup(state.selectedChallenge.name);
    const md = typeof res === 'string' ? res : (res && typeof res.content === 'string' ? res.content : '');
    if (!md.trim()) {
      body.replaceChildren(el('p', { className: 'text-muted', text: 'Writeup no disponible para este reto.' }));
      return;
    }
    body.innerHTML = Render.markdown(md);
    body.scrollTop = 0;
  } catch (err) {
    body.replaceChildren(el('p', { className: 'text-error', text: `Error al cargar el writeup: ${err.message || err}` }));
  }
}

function closeWriteup() {
  const modal = $('writeup-modal');
  if (modal.style.display === 'none') return;
  modal.style.display = 'none';
  if (writeupReturnFocus && typeof writeupReturnFocus.focus === 'function') writeupReturnFocus.focus();
  writeupReturnFocus = null;
}

function onWriteupClick(e) {
  const btn = e.target.closest('.code-block-copy');
  if (!btn) return;
  const code = btn.closest('.code-block').querySelector('code');
  window.polonio.system.copyToClipboard(code ? code.textContent : '');
  btn.textContent = 'Copiado';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = 'Copiar'; btn.classList.remove('copied'); }, 1500);
}

// ─── Contracts registry ──────────────────────────────────────────────────────

/** Reload the deployed contracts and refresh every place that lists them. */
async function refreshContracts() {
  let registry = [];
  if (state.blockchainRunning) {
    const res = await window.polonio.contracts.getRegistry();
    registry = Array.isArray(res) ? res : [];
  }
  state.registry = registry;

  renderRegistry($('dashboard-contracts'), { short: false });
  renderRegistry($('console-registry'), { short: true });
  populateContractSelect($('console-contract-select'), '-- Seleccionar --', () => true);
  populateContractSelect($('source-contract-select'), '-- Contrato desplegado --', c => c.hasSource);
  updateKnownAddresses();

  // Keep dependent panels consistent with the (possibly changed) selection.
  if ($('console-contract-select').value !== state.interact.address) onInteractContractChange();
  if (!state.sourceView || $('source-contract-select').value !== state.sourceView.address) loadSourceCode();
}

function originLabel(c) {
  return c.kind === 'challenge' ? `Reto ${c.challengeName || ''}`.trim() : 'Tuyo';
}

function renderRegistry(container, { short }) {
  if (!state.registry.length) {
    container.replaceChildren(el('p', {
      className: 'text-muted',
      text: state.blockchainRunning ? 'No hay contratos desplegados.' : 'Inicia el nodo para ver los contratos.',
    }));
    return;
  }

  container.replaceChildren(...state.registry.map(c => el('div', { className: 'registry-item' }, [
    el('div', { className: 'registry-item-head' }, [
      el('span', { className: 'registry-item-name', text: c.name }),
      el('span', { className: `tag ${c.kind === 'challenge' ? 'tag-challenge' : 'tag-user'}`, text: originLabel(c) }),
    ]),
    el('div', { className: 'registry-item-body' }, [
      addressChip(c.address, { short }),
      el('span', { className: 'registry-item-actions' }, [
        c.hasSource ? el('button', {
          className: 'btn btn-ghost btn-sm',
          type: 'button',
          title: 'Ver el codigo fuente desplegado',
          text: 'Codigo',
          onclick: () => viewContractSource(c.address),
        }) : null,
        el('button', {
          className: 'btn btn-ghost btn-sm',
          type: 'button',
          title: 'Seleccionar en Interaccion rapida',
          text: 'Interactuar',
          onclick: () => useContractInConsole(c.address),
        }),
      ]),
    ]),
  ])));
}

function populateContractSelect(select, placeholder, include) {
  const previous = select.value;
  const groups = [
    ['Retos', state.registry.filter(c => c.kind === 'challenge' && include(c))],
    ['Tus contratos', state.registry.filter(c => c.kind === 'user' && include(c))],
  ];
  const options = [el('option', { value: '', text: placeholder })];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    options.push(el('optgroup', { label }, items.map(c => el('option', {
      value: c.address,
      text: c.kind === 'challenge'
        ? `${c.name} — ${c.challengeName} (${shortAddress(c.address)})`
        : `${c.name} (${shortAddress(c.address)})${c.deployedAt ? ' · ' + new Date(c.deployedAt).toLocaleTimeString('es-ES', { hour12: false }) : ''}`,
    }))));
  }
  select.replaceChildren(...options);
  select.value = state.registry.some(c => c.address === previous && include(c)) ? previous : '';
}

/** <datalist> shared by every address input: player accounts and contracts. */
function updateKnownAddresses() {
  const list = $('known-addresses');
  list.replaceChildren(
    ...state.accounts.map((a, i) => el('option', { value: a.address, label: `Cuenta ${i}` })),
    ...state.registry.map(c => el('option', { value: c.address, label: `${c.name} (${originLabel(c)})` })),
  );
}

async function viewContractSource(address) {
  if (state.currentView !== 'console') await showView('console');
  switchConsoleTab('source');
  $('source-contract-select').value = address;
  loadSourceCode();
}

async function useContractInConsole(address) {
  if (state.currentView !== 'console') await showView('console');
  const select = $('console-contract-select');
  select.value = address;
  await onInteractContractChange();
  const method = $('console-method-select');
  method.focus();
}

// ─── Accounts ────────────────────────────────────────────────────────────────

/** Store the player accounts (account[0] is the deployer/admin and is skipped). */
function setAccounts(allAccounts) {
  state.accounts = allAccounts.slice(1).map((a, i) => ({ index: i + 1, address: a.address, balance: a.balance }));
  updateKnownAddresses();
}

async function refreshAccounts() {
  const selects = [$('console-account-select'), $('deploy-account-select')];
  if (!state.blockchainRunning) {
    state.accounts = [];
    selects.forEach(s => s.replaceChildren());
    updateKnownAddresses();
    return;
  }
  try {
    const accs = await window.polonio.blockchain.getAccounts();
    setAccounts(Array.isArray(accs) ? accs : []);
    for (const select of selects) {
      const previous = select.value;
      select.replaceChildren(...state.accounts.map((a, i) => el('option', {
        value: String(a.index),
        text: `[${i}] ${shortAddress(a.address)} · ${parseFloat(a.balance).toFixed(4)} ETH`,
      })));
      if (state.accounts.some(a => String(a.index) === previous)) select.value = previous;
    }
  } catch { /* node unreachable: the periodic status check handles it */ }
}

// ─── Console: quick interaction ──────────────────────────────────────────────

async function onInteractContractChange() {
  const address = $('console-contract-select').value;
  const methodSelect = $('console-method-select');
  const chip = $('console-contract-address');
  const requestId = ++requests.abi;
  state.interact = { address, functions: [], hasFallback: false, hasReceive: false };

  chip.hidden = !address;
  if (address) { chip.textContent = address; chip.dataset.copy = address; chip.title = 'Click para copiar'; }

  if (!address) {
    methodSelect.replaceChildren(el('option', { value: '', text: '-- Selecciona un contrato --' }));
    methodSelect.disabled = true;
    renderMethodParams();
    return;
  }

  const info = await window.polonio.contracts.getAbi(address);
  if (requestId !== requests.abi) return;
  if (!info) {
    methodSelect.replaceChildren(el('option', { value: '', text: '-- ABI no disponible --' }));
    methodSelect.disabled = true;
    renderMethodParams();
    return;
  }

  state.interact = { address, functions: info.functions, hasFallback: info.hasFallback, hasReceive: info.hasReceive };
  const isRead = f => f.stateMutability === 'view' || f.stateMutability === 'pure';
  const option = f => el('option', {
    value: f.signature,
    text: `${f.name}(${f.inputs.map(i => `${canonicalType(i)}${i.name ? ' ' + i.name : ''}`).join(', ')})${f.stateMutability === 'payable' ? '  · payable' : ''}`,
  });
  const reads = info.functions.filter(isRead);
  const writes = info.functions.filter(f => !isRead(f));
  const rawLabel = info.hasFallback || info.hasReceive
    ? `Transaccion raw (${[info.hasReceive && 'receive', info.hasFallback && 'fallback'].filter(Boolean).join(' / ')})`
    : 'Transaccion raw (calldata / ETH)';

  methodSelect.replaceChildren(
    reads.length ? el('optgroup', { label: 'Lectura (view / pure)' }, reads.map(option)) : '',
    writes.length ? el('optgroup', { label: 'Escritura (transaccion)' }, writes.map(option)) : '',
    el('optgroup', { label: 'Avanzado' }, [el('option', { value: RAW_TX, text: rawLabel })]),
  );
  methodSelect.disabled = false;
  methodSelect.value = (reads[0] || writes[0] || { signature: RAW_TX }).signature;
  renderMethodParams();
}

function canonicalType(param) {
  const type = String(param.type || '');
  if (type.startsWith('tuple')) return `(${(param.components || []).map(canonicalType).join(',')})${type.slice(5)}`;
  return type;
}

function selectedFunction() {
  const signature = $('console-method-select').value;
  return state.interact.functions.find(f => f.signature === signature) || null;
}

function paramPlaceholder(param) {
  const type = canonicalType(param);
  if (type.endsWith(']')) {
    if (type.startsWith('(')) return '[["0x...", 1]]';
    if (type.startsWith('address') || type.startsWith('bytes')) return '["0x...", "0x..."]';
    if (type.startsWith('bool')) return '[true, false]';
    if (type.startsWith('string')) return '["a", "b"]';
    return '[1, 2, 3]';
  }
  if (type.startsWith('(')) return '["0x...", 1]';
  if (type === 'address') return '0x...';
  if (type === 'bool') return 'true / false';
  if (type.startsWith('uint') || type.startsWith('int')) return 'Ej: 1000000000000000000';
  if (type.startsWith('bytes')) return '0x...';
  return 'texto';
}

function renderMethodParams() {
  const container = $('console-method-params');
  const valueInput = $('console-value');
  const button = $('btn-console-invoke');
  const signature = $('console-method-select').value;

  if (!state.interact.address || !signature) {
    container.replaceChildren();
    button.disabled = true;
    button.textContent = 'Invocar';
    valueInput.disabled = true;
    return;
  }

  if (signature === RAW_TX) {
    container.replaceChildren(el('div', { className: 'form-group' }, [
      el('label', { className: 'form-label', for: 'console-raw-data' }, ['Calldata ', el('span', { className: 'param-type', text: 'hex, opcional' })]),
      el('input', { className: 'input input-code', id: 'console-raw-data', placeholder: '0x (vacio = transferencia de ETH)', spellcheck: 'false' }),
    ]));
    valueInput.disabled = false;
    button.disabled = false;
    button.textContent = 'Enviar transaccion';
    return;
  }

  const fn = selectedFunction();
  if (!fn) { container.replaceChildren(); button.disabled = true; return; }

  container.replaceChildren(...fn.inputs.map((input, i) => {
    const type = canonicalType(input);
    const id = `console-param-${i}`;
    const field = type === 'bool'
      ? el('select', { className: 'select select-code console-param', id, dataset: { type } }, [
        el('option', { value: 'false', text: 'false' }),
        el('option', { value: 'true', text: 'true' }),
      ])
      : el('input', {
        className: 'input input-code console-param',
        id,
        placeholder: paramPlaceholder(input),
        spellcheck: 'false',
        list: type === 'address' ? 'known-addresses' : undefined,
        dataset: { type },
      });
    return el('div', { className: 'form-group' }, [
      el('label', { className: 'form-label', for: id }, [
        input.name || `arg${i}`, ' ', el('span', { className: 'param-type', text: type }),
      ]),
      field,
    ]);
  }));

  const payable = fn.stateMutability === 'payable';
  valueInput.disabled = !payable;
  if (!payable) valueInput.value = '0';
  button.disabled = false;
  button.textContent = fn.stateMutability === 'view' || fn.stateMutability === 'pure' ? 'Consultar' : 'Enviar transaccion';
}

async function invokeFromConsole(e) {
  if (e) e.preventDefault();
  const { address } = state.interact;
  const signature = $('console-method-select').value;
  if (!address) { showToast('Selecciona un contrato', 'warning'); return; }
  if (!signature) { showToast('Selecciona una funcion', 'warning'); return; }

  const accountIndex = parseInt($('console-account-select').value, 10) || 1;
  const value = $('console-value').value.trim() || '0';
  const contract = state.registry.find(c => c.address === address);
  const contractName = contract ? contract.name : shortAddress(address);
  const button = $('btn-console-invoke');
  button.disabled = true;

  try {
    if (signature === RAW_TX) {
      const data = $('console-raw-data').value.trim();
      consoleOutput(`> raw -> ${contractName} data=${data || '0x'} value=${value} ETH`, 'info');
      const res = await window.polonio.contracts.sendRaw({ to: address, data, value, accountIndex });
      reportSendResult(res, `${contractName}.raw`);
      return;
    }

    const fn = selectedFunction();
    if (!fn) { showToast('Selecciona una funcion', 'warning'); return; }
    const args = Array.from(document.querySelectorAll('#console-method-params .console-param')).map(input => input.value);
    consoleOutput(`> ${contractName}.${fn.name}(${args.join(', ')})${value !== '0' ? ` {value: ${value} ETH}` : ''}`, 'info');

    const res = await window.polonio.contracts.interact({ address, signature, args, accountIndex, value });
    if (res.success && res.type === 'call') {
      if (!res.outputs.length) consoleOutput('OK (sin valores de retorno)', 'success');
      res.outputs.forEach((o, i) => consoleOutput(`${o.name || `[${i}]`} (${o.type}): ${formatValue(o.value)}`, 'success'));
      terminalLog(`${fn.name}() => OK`);
    } else {
      reportSendResult(res, `${contractName}.${fn.name}()`);
    }
  } finally {
    button.disabled = false;
  }
}

function reportSendResult(res, label) {
  if (!res.success) {
    consoleOutput(`Error: ${res.error}`, 'error');
    terminalLog(`${label} => FAILED: ${res.error}`, 'error');
    return;
  }
  const r = res.result;
  consoleOutput(`TX: ${r.transactionHash}`, 'success');
  consoleOutput(`Gas: ${r.gasUsed} | Block: ${r.blockNumber}`);
  Object.entries(r.events || {}).forEach(([name, ev]) => consoleOutput(`Evento ${ev.event || name}: ${formatValue(ev.returnValues)}`));
  terminalLog(`${label} => OK (${r.transactionHash})`);
  refreshAccounts();
}

// ─── Console: source viewer ──────────────────────────────────────────────────

function switchConsoleTab(tab) {
  document.querySelectorAll('.console-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('editor-wrapper').style.display = tab === 'editor' ? 'flex' : 'none';
  $('source-viewer').style.display = tab === 'editor' ? 'none' : 'flex';
}

async function loadSourceCode() {
  const address = $('source-contract-select').value;
  const display = $('source-code-display');
  const meta = $('source-viewer-meta');
  const requestId = ++requests.source;
  state.sourceView = null;

  if (!address) {
    meta.hidden = true;
    Render.codePlaceholder(display, state.registry.some(c => c.hasSource)
      ? '// Selecciona un contrato desplegado para ver su codigo'
      : '// Aun no hay contratos desplegados');
    return;
  }

  const res = await window.polonio.contracts.getSource(address);
  if (requestId !== requests.source) return;
  if (!res || !res.success) {
    meta.hidden = true;
    Render.codePlaceholder(display, `// ${(res && res.error) || 'Codigo fuente no disponible'}`);
    return;
  }

  state.sourceView = res;
  const chip = $('source-viewer-address');
  chip.textContent = res.address;
  chip.dataset.copy = res.address;
  $('source-viewer-origin').textContent = res.kind === 'challenge'
    ? `Reto ${res.challengeName} · ${res.fileName}`
    : 'Desplegado por ti · codigo exacto del despliegue';
  $('btn-source-to-editor').hidden = res.kind !== 'user';
  meta.hidden = false;
  Render.codeView(display, res.source, 'solidity');
}

/** Replace the editor content with the source being viewed (undoable). */
function openSourceInEditor() {
  if (!state.sourceView) return;
  switchConsoleTab('editor');
  const editor = $('script-editor');
  editor.focus();
  editor.select();
  editorInsert(editor, state.sourceView.source);
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
  onEditorChange();
  showToast('Codigo cargado en el editor (Ctrl+Z para deshacer)', 'info');
}

// ─── Console: editor ─────────────────────────────────────────────────────────

/** Insert text at the selection keeping the native undo history. */
function editorInsert(editor, text) {
  editor.focus();
  // execCommand is the only way to edit a textarea without wiping Ctrl+Z.
  const ok = document.execCommand && document.execCommand('insertText', false, text);
  if (!ok) {
    editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, 'end');
    onEditorChange();
  }
}

/** Indent (or outdent) the selected lines; with no selection, insert to the next tab stop. */
function editorIndent(editor, outdent) {
  const { selectionStart: start, selectionEnd: end, value } = editor;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;

  if (!outdent && start === end) {
    const column = start - lineStart;
    editorInsert(editor, ' '.repeat(INDENT.length - (column % INDENT.length)));
    return;
  }

  // A selection that ends right at the start of a line does not include it.
  const effectiveEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
  const nextBreak = value.indexOf('\n', effectiveEnd);
  const blockEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(lineStart, blockEnd).split('\n');
  const removedFirst = outdent ? (lines[0].match(/^( {1,4}|\t)/) || [''])[0].length : 0;
  const updated = lines.map(l => (outdent ? l.replace(/^( {1,4}|\t)/, '') : INDENT + l)).join('\n');
  if (updated === value.slice(lineStart, blockEnd)) return;

  editor.setSelectionRange(lineStart, blockEnd);
  editorInsert(editor, updated);

  if (start === end) {
    const caret = Math.max(lineStart, start - removedFirst);
    editor.setSelectionRange(caret, caret);
  } else {
    editor.setSelectionRange(lineStart, lineStart + updated.length);
  }
}

/** Enter keeps the current indentation (one level deeper after "{"). */
function editorNewline(editor) {
  const { selectionStart: start, value } = editor;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const before = value.slice(lineStart, start);
  const indent = (before.match(/^[ \t]*/) || [''])[0];
  const opensBlock = /[{([]\s*$/.test(before);
  const closesNext = /^\s*[})\]]/.test(value.slice(start, value.indexOf('\n', start) === -1 ? value.length : value.indexOf('\n', start)));

  if (opensBlock && closesNext) {
    editorInsert(editor, `\n${indent}${INDENT}\n${indent}`);
    const caret = editor.selectionStart - (indent.length + 1);
    editor.setSelectionRange(caret, caret);
  } else {
    editorInsert(editor, `\n${indent}${opensBlock ? INDENT : ''}`);
  }
}

function onEditorKeydown(e) {
  const editor = e.target;
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    editorIndent(editor, e.shiftKey);
  } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
    e.preventDefault();
    editorNewline(editor);
  }
}

let editorSaveTimer = null;
let editorLineCount = 0;

function onEditorChange() {
  const editor = $('script-editor');
  const lines = editor.value.split('\n').length;
  if (lines !== editorLineCount) {
    editorLineCount = lines;
    $('editor-gutter').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  }
  syncEditorGutter();
  clearTimeout(editorSaveTimer);
  editorSaveTimer = setTimeout(() => {
    try { localStorage.setItem(EDITOR_STORAGE_KEY, editor.value); } catch { /* storage unavailable */ }
  }, 400);
}

function syncEditorGutter() {
  $('editor-gutter').scrollTop = $('script-editor').scrollTop;
}

function initEditor() {
  const editor = $('script-editor');
  try {
    const saved = localStorage.getItem(EDITOR_STORAGE_KEY);
    if (saved) editor.value = saved;
  } catch { /* storage unavailable */ }
  editor.addEventListener('keydown', onEditorKeydown);
  editor.addEventListener('input', onEditorChange);
  editor.addEventListener('scroll', syncEditorGutter);
  onEditorChange();
}

// ─── Console: scripts, compile & deploy ──────────────────────────────────────

async function runScript() {
  const src = $('script-editor').value;
  if (!src.trim()) { showToast('Escribe un script', 'warning'); return; }
  consoleOutput('> Ejecutando script JS...', 'info');
  const res = await window.polonio.script.execute(src);
  if (res.success) {
    if (res.output) consoleOutput(res.output, 'success');
    if (res.result) consoleOutput(`Return: ${res.result}`, 'info');
    if (!res.output && !res.result) consoleOutput('OK (sin output)', 'success');
    refreshAccounts();
  } else {
    consoleOutput(`Error: ${res.error}`, 'error');
  }
}

/**
 * Parse an arguments field: a JSON array ("[1, \"a\", [2, 3]]") or a
 * comma-separated list ("1, a").
 */
function parseArgs(str) {
  const text = (str || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Los argumentos JSON deben ser un array');
    return parsed;
  }
  return text.split(',').map(a => a.trim());
}

/**
 * Deployable contracts of the editor source, in declaration order
 * (imported contracts, interfaces and abstract contracts are excluded).
 */
function deployableContracts(res, src) {
  const position = (name) => {
    const m = new RegExp(`\\bcontract\\s+${name}\\b`).exec(src);
    return m ? m.index : -1;
  };
  return Object.entries(res.contracts || {})
    .filter(([name, c]) => c.sourceFile === 'Contract.sol' && c.bytecode && c.bytecode.length > 0 && position(name) >= 0)
    .map(([name]) => name)
    .sort((a, b) => position(a) - position(b));
}

async function compileScript() {
  const src = $('script-editor').value;
  if (!src.trim()) { showToast('Escribe codigo Solidity', 'warning'); return null; }
  consoleOutput('> Compilando...', 'info');
  const res = await window.polonio.compiler.compile(src);
  if (res.success) {
    const names = deployableContracts(res, src);
    const sel = $('deploy-contract-select');
    sel.replaceChildren(...(names.length
      ? names.map(n => el('option', { value: n, text: n }))
      : [el('option', { value: '', text: '-- Sin contratos desplegables --' })]));
    if (names.length) sel.value = names[names.length - 1];
    consoleOutput(`OK: ${names.join(', ') || 'sin contratos desplegables'}`, 'success');
    return res;
  }
  (res.errors || [res.error]).forEach(e => consoleOutput((e && e.message) || e, 'error'));
  return null;
}

async function deployScript() {
  const src = $('script-editor').value;
  if (!src.trim()) { showToast('Escribe codigo Solidity', 'warning'); return; }

  let constructorArgs;
  try {
    constructorArgs = parseArgs($('deploy-args').value);
  } catch (err) {
    consoleOutput(`Args invalidos: ${err.message}`, 'error');
    return;
  }

  // Compile first so the contract selector always matches the current source
  const compiled = await compileScript();
  if (!compiled) return;
  const contractName = $('deploy-contract-select').value || null;
  const value = $('deploy-value').value.trim() || '0';
  const accountIndex = parseInt($('deploy-account-select').value, 10) || 1;

  consoleOutput(`> Desplegando ${contractName || ''}...`, 'info');
  const res = await window.polonio.contracts.deployUser({
    title: 'Script',
    source: src,
    fileName: 'Script.sol',
    contractName,
    constructorArgs,
    value,
    accountIndex,
  });
  if (res.success) {
    consoleOutput(`${res.contractName} desplegado en: ${res.address}`, 'success');
    terminalLog(`Deploy ${res.contractName} => ${res.address}`);
    await refreshContracts();
    // Ready to interact with the contract just deployed.
    $('console-contract-select').value = res.address;
    onInteractContractChange();
    refreshAccounts();
  } else {
    consoleOutput(`Error: ${res.error}`, 'error');
  }
}

// ─── Inspector ───────────────────────────────────────────────────────────────

function resultRows(container, rows) {
  container.style.display = 'block';
  container.replaceChildren(...rows.map(([label, value]) =>
    el('div', {}, [el('strong', { text: `${label}: ` }), String(value)])));
}

function resultError(container, message) {
  container.style.display = 'block';
  container.replaceChildren(el('span', { className: 'text-error', text: message }));
}

async function readStorage() {
  const addr = $('inspector-address').value.trim();
  const slot = $('inspector-slot').value.trim();
  if (!addr) { showToast('Introduce una direccion', 'warning'); return; }
  const res = await window.polonio.inspector.readStorage(addr, parseInt(slot, 10));
  const out = $('storage-result');
  if (res.error) { resultError(out, res.error); return; }
  resultRows(out, [
    ['Raw', res.raw],
    ['uint256', res.interpretations.asUint256],
    ['address', res.interpretations.asAddress],
    ['bool', res.interpretations.asBool],
  ]);
}

async function inspectAddress() {
  const addr = $('inspector-info-address').value.trim();
  if (!addr) return;
  const [balance, code] = await Promise.all([
    window.polonio.inspector.getBalance(addr),
    window.polonio.inspector.getCode(addr),
  ]);
  const out = $('address-info-result');
  if (balance.error || code.error) { resultError(out, balance.error || code.error); return; }
  resultRows(out, [
    ['Balance', `${balance.ether} ETH`],
    ['Code', !code.isEmpty ? `${code.size} bytes` : 'EOA (sin codigo)'],
  ]);
}

async function inspectTx() {
  const hash = $('inspector-tx-hash').value.trim();
  if (!hash) return;
  const res = await window.polonio.inspector.getTransactionReceipt(hash);
  const out = $('tx-result');
  if (res.error) { resultError(out, res.error); return; }
  out.style.display = 'block';
  out.replaceChildren(el('pre', { text: JSON.stringify(res, null, 2) }));
}

// ─── Background ──────────────────────────────────────────────────────────────

function initBackground() {
  const canvas = $('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let particles = [];
  const N = 40;
  const MAX_D = 120;

  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; init(); }
  function init() { particles = Array.from({ length: N }, () => ({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, r: Math.random() + 0.5 })); }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(168,85,247,0.5)'; ctx.fill();
    });
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < MAX_D) { ctx.strokeStyle = `rgba(168,85,247,${(1 - d / MAX_D) * 0.2})`; ctx.lineWidth = 0.5; ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y); ctx.stroke(); }
    }
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize', resize);
  resize(); draw();
}

// ─── Global shortcuts ────────────────────────────────────────────────────────

function onGlobalKeydown(e) {
  if (e.key === 'Escape' && $('writeup-modal').style.display !== 'none') {
    e.preventDefault();
    closeWriteup();
    return;
  }
  if (state.currentView !== 'challenges') return;

  const search = $('challenge-search');
  const typing = e.target instanceof HTMLElement && e.target.matches('input, textarea, select, [contenteditable]');
  if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing)) {
    e.preventDefault();
    search.focus();
    search.select();
  }
}

/** Any element with data-copy copies its value on click / Enter. */
function onCopyActivate(e) {
  if (!(e.target instanceof Element)) return;
  const target = e.target.closest('[data-copy]');
  if (!target) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  e.stopPropagation();
  copyText(target.dataset.copy);
}

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initBackground();
  initEditor();
  Render.codePlaceholder($('detail-code-display'), '// Selecciona un contrato del listado para ver su codigo fuente.');
  Render.codePlaceholder($('source-code-display'), '// Selecciona un contrato desplegado para ver su codigo');

  document.addEventListener('click', onCopyActivate, true);
  document.addEventListener('keydown', onCopyActivate, true);
  document.addEventListener('keydown', onGlobalKeydown);

  const session = await window.polonio.auth.getSession();
  if (session.authenticated) enterApp(session.username);

  // Login
  $('login-form').addEventListener('submit', handleLogin);

  // Nav
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => showView(item.dataset.view));
  });

  // Blockchain
  $('btn-start-blockchain').addEventListener('click', startBlockchain);
  $('btn-stop-blockchain').addEventListener('click', stopBlockchain);
  $('btn-reset-blockchain').addEventListener('click', resetBlockchain);

  // Logout
  $('btn-logout').addEventListener('click', handleLogout);
  $('btn-settings-logout').addEventListener('click', handleLogout);

  // Challenges: filters & search
  document.querySelectorAll('.filter-btn[data-level]').forEach(btn => {
    btn.addEventListener('click', () => setChallengeLevel(btn.dataset.level));
  });
  const search = $('challenge-search');
  search.addEventListener('input', () => setChallengeQuery(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) { e.preventDefault(); e.stopPropagation(); setChallengeQuery(''); }
  });
  $('challenge-search-clear').addEventListener('click', () => { setChallengeQuery(''); search.focus(); });

  // Challenge detail
  $('btn-back-challenges').addEventListener('click', () => showView('challenges'));
  $('btn-activate-challenge').addEventListener('click', activateChallenge);
  $('btn-validate-challenge').addEventListener('click', validateChallenge);
  $('btn-writeup-challenge').addEventListener('click', openWriteup);
  $('btn-mark-completed').addEventListener('click', markCompleted);
  $('writeup-modal-close').addEventListener('click', closeWriteup);
  $('writeup-modal-backdrop').addEventListener('click', closeWriteup);
  $('writeup-modal-body').addEventListener('click', onWriteupClick);
  $('btn-copy-code').addEventListener('click', () => copyText(state.detailSource, 'Codigo copiado'));

  // Console
  $('btn-compile-script').addEventListener('click', compileScript);
  $('btn-deploy-script').addEventListener('click', deployScript);
  $('btn-run-script').addEventListener('click', runScript);
  $('console-interact-form').addEventListener('submit', invokeFromConsole);
  $('console-contract-select').addEventListener('change', onInteractContractChange);
  $('console-method-select').addEventListener('change', renderMethodParams);
  $('tab-editor').addEventListener('click', () => switchConsoleTab('editor'));
  $('tab-source').addEventListener('click', () => switchConsoleTab('source'));
  $('source-contract-select').addEventListener('change', loadSourceCode);
  $('btn-source-copy').addEventListener('click', () => state.sourceView && copyText(state.sourceView.source, 'Codigo copiado'));
  $('btn-source-to-editor').addEventListener('click', openSourceInEditor);

  // Inspector
  $('btn-read-storage').addEventListener('click', readStorage);
  $('btn-inspect-address').addEventListener('click', inspectAddress);
  $('btn-inspect-tx').addEventListener('click', inspectTx);

  // Terminal toggle
  $('terminal-header').addEventListener('click', () => {
    $('terminal-panel').classList.toggle('collapsed');
  });

  // Periodic status
  setInterval(async () => {
    if (!state.authenticated) return;
    const s = await window.polonio.blockchain.getStatus();
    if (s.running !== state.blockchainRunning) {
      state.blockchainRunning = s.running;
      updateBlockchainUI(s.running);
      if (!s.running) onChainStateLost();
    }
  }, 10000);
});
