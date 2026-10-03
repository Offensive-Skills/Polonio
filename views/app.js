'use strict';

const state = {
  authenticated: false,
  blockchainRunning: false,
  currentView: 'dashboard',
  selectedChallenge: null,
  challenges: [],
};

// ─── Utilities ───────────────────────────────────────────────────────────────

function showToast(msg, type = 'info', duration = 3500) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, duration);
}

function terminalLog(msg, type = 'info') {
  const c = document.getElementById('terminal-content');
  const e = document.createElement('div');
  e.className = 'terminal-entry';
  const ts = new Date().toLocaleTimeString('es-ES', { hour12: false });
  e.innerHTML = `<span class="terminal-timestamp">[${ts}]</span> <span class="terminal-message ${type}">${esc(msg)}</span>`;
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
}

function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

function consoleOutput(msg, type = 'info') {
  const c = document.getElementById('console-output');
  const e = document.createElement('div');
  e.className = `console-line console-${type}`;
  e.textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  c.appendChild(e);
  c.scrollTop = c.scrollHeight;
}

// ─── Navigation ──────────────────────────────────────────────────────────────

function navigateTo(viewId) {
  document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
  const target = document.getElementById(`view-${viewId}`);
  if (target) target.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === viewId));
  const titles = { dashboard: 'Dashboard', challenges: 'Retos', 'challenge-detail': 'Detalle', console: 'Consola', inspector: 'Inspector', settings: 'Configuracion' };
  document.getElementById('view-title').textContent = titles[viewId] || 'Polonio';
  state.currentView = viewId;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function handleLogin(e) {
  e.preventDefault();
  const user = document.getElementById('login-username').value.trim();
  const token = document.getElementById('login-token').value.trim();
  const remember = document.getElementById('login-remember').checked;
  const errEl = document.getElementById('login-error');
  const spin = document.getElementById('login-spinner');
  const txt = document.getElementById('login-btn-text');
  errEl.classList.remove('visible');
  spin.style.display = 'block'; txt.style.display = 'none';

  const res = await window.polonio.auth.login(user, token, remember);
  spin.style.display = 'none'; txt.style.display = 'inline';

  if (res.success) {
    state.authenticated = true;
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    document.getElementById('settings-username').textContent = user;
    terminalLog(`Sesion iniciada: ${user}`);
    loadDashboard();
  } else {
    errEl.textContent = res.error || 'Credenciales invalidas';
    errEl.classList.add('visible');
  }
}

async function handleLogout() {
  await window.polonio.auth.logout();
  state.authenticated = false;
  document.getElementById('app-shell').style.display = 'none';
  document.getElementById('login-view').style.display = 'flex';
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
  }
}

function updateBlockchainUI(running) {
  document.getElementById('blockchain-dot').className = `status-dot status-dot-${running ? 'active' : 'inactive'}`;
  document.getElementById('blockchain-status-text').textContent = running ? 'Conectado' : 'Desconectado';
  document.getElementById('btn-start-blockchain').style.display = running ? 'none' : 'inline-flex';
  document.getElementById('btn-stop-blockchain').style.display = running ? 'inline-flex' : 'none';
  document.getElementById('btn-reset-blockchain').style.display = running ? 'inline-flex' : 'none';
  document.getElementById('stat-status').textContent = running ? 'Activo' : 'Inactivo';
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function loadDashboard() {
  const status = await window.polonio.blockchain.getStatus();
  state.blockchainRunning = status.running;
  updateBlockchainUI(status.running);

  if (!status.running) {
    document.getElementById('stat-block').textContent = '--';
    document.getElementById('accounts-list').innerHTML = '<p class="text-muted">Inicia el nodo para ver las cuentas.</p>';
    return;
  }

  const info = await window.polonio.blockchain.getInfo();
  if (info.running) {
    document.getElementById('stat-block').textContent = info.blockNumber || '0';
    document.getElementById('stat-chain').textContent = info.chainId || '31337';
    if (info.accounts && info.accounts.length) {
      // Skip account[0] (deployer/admin)
      const userAccounts = info.accounts.slice(1);
      const listEl = document.getElementById('accounts-list');
      listEl.innerHTML = userAccounts.map((a, i) =>
        `<div class="account-row"><span class="account-index">${i}</span><span class="account-address" data-address="${esc(a.address)}" title="Click para copiar">${esc(a.address)}</span><span class="account-balance">${parseFloat(a.balance).toFixed(2)} ETH</span></div>`
      ).join('');
      // Bind copy handlers via addEventListener (inline handlers are blocked by CSP).
      listEl.querySelectorAll('.account-address').forEach(el => {
        el.addEventListener('click', () => {
          window.polonio.system.copyToClipboard(el.dataset.address);
          showToast('Copiado');
        });
      });
    }
  }

  const active = await window.polonio.challenges.getActive();
  document.getElementById('stat-challenges').textContent = active.length || '0';
}

// ─── Challenges ──────────────────────────────────────────────────────────────

async function loadChallenges(level = 'all') {
  const grid = document.getElementById('challenges-grid');
  if (!state.blockchainRunning) {
    grid.innerHTML = '<p class="text-muted" style="grid-column:1/-1;">Inicia el nodo para cargar los retos.</p>';
    return;
  }
  grid.innerHTML = '<div class="spinner spinner-lg" style="margin:auto;grid-column:1/-1;"></div>';

  try {
    let challenges = [];
    if (level === 'active') {
      // Filter by deployed
      const [f, m, d] = await Promise.all([
        window.polonio.challenges.list('facil'),
        window.polonio.challenges.list('medio'),
        window.polonio.challenges.list('dificil'),
      ]);
      const all = [...(Array.isArray(f) ? f : []), ...(Array.isArray(m) ? m : []), ...(Array.isArray(d) ? d : [])];
      const active = await window.polonio.challenges.getActive();
      const activeNames = active.map(a => a.challengeName);
      challenges = all.filter(ch => activeNames.includes(ch.name));
    } else if (level === 'all') {
      const [f, m, d] = await Promise.all([
        window.polonio.challenges.list('facil'),
        window.polonio.challenges.list('medio'),
        window.polonio.challenges.list('dificil'),
      ]);
      challenges = [...(Array.isArray(f) ? f : []), ...(Array.isArray(m) ? m : []), ...(Array.isArray(d) ? d : [])];
    } else {
      const res = await window.polonio.challenges.list(level);
      challenges = Array.isArray(res) ? res : [];
    }
    state.challenges = challenges;

    if (!challenges.length) {
      grid.innerHTML = '<p class="text-muted" style="grid-column:1/-1;">No hay retos disponibles.</p>';
      return;
    }

    grid.innerHTML = challenges.map(ch => `
      <div class="challenge-card" data-name="${esc(ch.name)}">
        <div class="challenge-card-level" data-level="${ch.level}">${levelLabel(ch.level)}</div>
        <div class="challenge-card-title">${esc(ch.name)}</div>
        <div class="challenge-card-desc">${esc(ch.description || '')}</div>
        <div class="challenge-card-footer">
          <span class="text-muted" style="font-size:11px;">${levelLabel(ch.level)}</span>
          ${ch.completed ? '<span class="challenge-card-completed">Completado</span>' : ''}
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.challenge-card').forEach(card => {
      card.addEventListener('click', () => {
        const ch = challenges.find(c => c.name === card.dataset.name);
        if (ch) openChallengeDetail(ch);
      });
    });
  } catch (err) {
    grid.innerHTML = `<p class="text-error">${err.message || err}</p>`;
  }
}

function levelLabel(l) {
  const m = { facil: 'BASICO', medio: 'INTERMEDIO', dificil: 'AVANZADO', insano: 'EXPERTO' };
  return m[l] || l.toUpperCase();
}

// ─── Challenge Detail ────────────────────────────────────────────────────────

async function openChallengeDetail(ch) {
  state.selectedChallenge = ch;
  navigateTo('challenge-detail');
  document.getElementById('detail-challenge-name').textContent = ch.name;
  document.getElementById('detail-challenge-desc').textContent = ch.description || '';

  const active = await window.polonio.challenges.getActive();
  const isActive = active.some(c => c.challengeName === ch.name);

  document.getElementById('btn-activate-challenge').style.display = isActive ? 'none' : 'inline-flex';
  document.getElementById('btn-validate-challenge').style.display = isActive ? 'inline-flex' : 'none';
  document.getElementById('btn-writeup-challenge').style.display = isActive ? 'inline-flex' : 'none';
  document.getElementById('btn-mark-completed').style.display = (isActive && !ch.completed) ? 'inline-flex' : 'none';
  document.getElementById('detail-challenge-badge').innerHTML = ch.completed ? '<span class="badge badge-completed">COMPLETADO</span>' : (isActive ? '<span class="badge badge-active">DESPLEGADO</span>' : '');

  // Load contracts
  try {
    const contracts = await window.polonio.challenges.getSmartcontracts(ch.name);
    const listEl = document.getElementById('detail-contracts-list');
    if (Array.isArray(contracts) && contracts.length) {
      listEl.innerHTML = contracts.map(sc => `<div class="contract-item" data-sc="${esc(sc.name)}">${esc(sc.name)}.sol</div>`).join('');
      listEl.querySelectorAll('.contract-item').forEach(item => {
        item.addEventListener('click', () => loadContractCode(ch.name, item.dataset.sc));
      });
      // Auto-load first contract code
      loadContractCode(ch.name, contracts[0].name);
    } else {
      listEl.innerHTML = '<p class="text-muted">Sin contratos definidos.</p>';
    }
  } catch { /* ignore */ }
}

async function loadContractCode(challengeName, scName) {
  document.getElementById('detail-code-title').textContent = `${scName}.sol`;
  try {
    const res = await window.polonio.contracts.getCode(challengeName, scName);
    document.getElementById('detail-code-display').textContent = res.contract || '// Sin contenido';
  } catch {
    document.getElementById('detail-code-display').textContent = '// Error al cargar';
  }
}

async function activateChallenge() {
  if (!state.selectedChallenge) return;
  const name = state.selectedChallenge.name;
  terminalLog(`Desplegando reto: ${name}...`);

  const res = await window.polonio.challenges.activate(name);
  if (res.success) {
    terminalLog(`Desplegado: ${res.contracts.length} contrato(s)`, 'success');
    res.contracts.forEach(c => terminalLog(`  ${c.name} => ${c.address}`));
    showToast('Reto desplegado correctamente', 'success');
    openChallengeDetail(state.selectedChallenge);
    refreshConsoleContracts();
  } else {
    terminalLog(`Error: ${res.error}`, 'error');
    showToast(res.error, 'error');
  }
}

async function validateChallenge() {
  if (!state.selectedChallenge) return;
  const res = await window.polonio.challenges.validate(state.selectedChallenge.name);
  if (res.passed) {
    showToast('Reto completado', 'success');
    terminalLog(`COMPLETADO: ${state.selectedChallenge.name}`, 'success');
    await window.polonio.challenges.complete(state.selectedChallenge.name, true);
    state.selectedChallenge.completed = true;
    openChallengeDetail(state.selectedChallenge);
  } else {
    showToast(res.message || 'Aun no resuelto', 'warning');
    terminalLog(`Validacion fallida: ${res.message || 'condiciones no cumplidas'}`, 'error');
  }
}

async function markCompleted() {
  if (!state.selectedChallenge) return;
  await window.polonio.challenges.complete(state.selectedChallenge.name, true);
  state.selectedChallenge.completed = true;
  showToast('Reto marcado como completado', 'success');
  terminalLog(`Marcado completado: ${state.selectedChallenge.name}`, 'success');
  openChallengeDetail(state.selectedChallenge);
}

// ─── Blockchain Reset ────────────────────────────────────────────────────────

async function resetBlockchain() {
  if (!state.blockchainRunning) return;
  terminalLog('Reiniciando blockchain... Se eliminaran todos los contratos y se resetearan los saldos.', 'warning');
  const res = await window.polonio.blockchain.restart();
  if (res.success) {
    showToast('Blockchain reiniciada', 'success');
    terminalLog('Blockchain reiniciada correctamente', 'success');
    loadDashboard();
  } else {
    showToast(`Error: ${res.error}`, 'error');
    terminalLog(`Error al reiniciar: ${res.error}`, 'error');
  }
}

// ─── Writeup Viewer ──────────────────────────────────────────────────────────

async function openWriteup() {
  if (!state.selectedChallenge) return;
  const modal = document.getElementById('writeup-modal');
  const body = document.getElementById('writeup-modal-body');
  const title = document.getElementById('writeup-modal-title');

  title.textContent = `Writeup — ${state.selectedChallenge.name}`;
  body.innerHTML = '<div class="spinner spinner-lg" style="margin:auto;"></div>';
  modal.style.display = 'flex';

  try {
    const res = await window.polonio.challenges.getWriteup(state.selectedChallenge.name);
    const md = res.content || res;
    body.innerHTML = renderMarkdown(md);
  } catch (err) {
    body.innerHTML = `<p class="text-error">Error al cargar el writeup: ${err.message || err}</p>`;
  }
}

function closeWriteup() {
  document.getElementById('writeup-modal').style.display = 'none';
}

function renderMarkdown(md) {
  // Escape ALL HTML first; the transforms below only introduce a known, safe
  // set of tags. This neutralizes any raw HTML embedded in the writeup.
  const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Only allow safe link schemes — blocks javascript:, data:, file:, etc.
  const safeHref = (url) => {
    const u = String(url).trim();
    if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) {
      return u.replace(/"/g, '%22');
    }
    return '#';
  };

  let html = escapeHtml(md)
    // Code blocks (``` ... ```) — content is already HTML-escaped above
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`)
    // Headings
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr>')
    // Blockquotes (the '>' was escaped to '&gt;' above)
    .replace(/^&gt; (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    // Bold & italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Links — validate the URL scheme and escape quotes
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
      `<a href="${safeHref(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`)
    // Unordered lists
    .replace(/^\- (.+)$/gm, '<li>$1</li>')
    // Paragraphs — split on double newlines
    .split(/\n\n+/)
    .map(block => {
      block = block.trim();
      if (!block) return '';
      if (block.startsWith('<h') || block.startsWith('<pre') || block.startsWith('<hr') || block.startsWith('<blockquote') || block.startsWith('<ul') || block.startsWith('<ol')) return block;
      if (block.includes('<li>')) return `<ul>${block}</ul>`;
      return `<p>${block.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
  return html;
}

// ─── Console (Scripting Interface) ───────────────────────────────────────────

async function refreshConsoleContracts() {
  const sel = document.getElementById('console-contract-select');
  const srcSel = document.getElementById('source-contract-select');
  const deployed = await window.polonio.contracts.getDeployed();
  sel.innerHTML = '<option value="">-- Seleccionar --</option>';
  srcSel.innerHTML = '<option value="">-- Contrato --</option>';
  if (Array.isArray(deployed)) {
    deployed.forEach(c => {
      const name = c.contractName || c.fileName;
      const addrShort = c.address.slice(0, 10);
      sel.innerHTML += `<option value="${name}">${name} (${addrShort}...)</option>`;
      srcSel.innerHTML += `<option value="${name}" data-challenge="${c.challengeName || ''}">${name} (${addrShort}...)</option>`;
    });
  }
}

async function refreshConsoleAccounts() {
  if (!state.blockchainRunning) return;
  const sel = document.getElementById('console-account-select');
  try {
    const accs = await window.polonio.blockchain.getAccounts();
    // Skip account[0] (deployer/admin) — user accounts start from index 1
    const userAccs = accs.slice(1);
    sel.innerHTML = userAccs.map((a, i) => `<option value="${i + 1}">[${i}] ${a.address.slice(0, 12)}...</option>`).join('');
  } catch { /* */ }
}

async function runScript() {
  const src = document.getElementById('script-editor').value;
  if (!src.trim()) { showToast('Escribe un script', 'warning'); return; }
  consoleOutput('> Ejecutando script JS...', 'info');
  const res = await window.polonio.script.execute(src);
  if (res.success) {
    if (res.output) consoleOutput(res.output, 'success');
    if (res.result) consoleOutput(`Return: ${res.result}`, 'info');
    if (!res.output && !res.result) consoleOutput('OK (sin output)', 'success');
  } else {
    consoleOutput(`Error: ${res.error}`, 'error');
  }
}

function switchConsoleTab(tab) {
  const editor = document.getElementById('script-editor');
  const source = document.getElementById('source-viewer');
  document.querySelectorAll('.console-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.console-tab[data-tab="${tab}"]`).classList.add('active');
  if (tab === 'editor') {
    editor.style.display = 'block';
    source.style.display = 'none';
  } else {
    editor.style.display = 'none';
    source.style.display = 'flex';
  }
}

async function loadSourceCode() {
  const sel = document.getElementById('source-contract-select');
  const name = sel.value;
  const display = document.getElementById('source-code-display');
  if (!name) { display.textContent = '// Selecciona un contrato desplegado para ver su codigo'; return; }

  const challengeName = sel.selectedOptions[0].dataset.challenge;
  if (!challengeName) { display.textContent = '// Contrato de usuario (sin codigo fuente asociado)'; return; }

  try {
    const res = await window.polonio.contracts.getCode(challengeName, name);
    display.textContent = res.contract || '// Sin codigo fuente disponible';
  } catch {
    display.textContent = '// Error al cargar el codigo';
  }
}

async function compileScript() {
  const src = document.getElementById('script-editor').value;
  if (!src.trim()) { showToast('Escribe codigo Solidity', 'warning'); return null; }
  consoleOutput('> Compilando...', 'info');
  const res = await window.polonio.compiler.compile(src);
  if (res.success) {
    consoleOutput(`OK: ${Object.keys(res.contracts).join(', ')}`, 'success');
    return res;
  } else {
    res.errors.forEach(e => consoleOutput(e.message || e, 'error'));
    return null;
  }
}

async function deployScript() {
  const src = document.getElementById('script-editor').value;
  if (!src.trim()) { showToast('Escribe codigo Solidity', 'warning'); return; }
  consoleOutput('> Compilando y desplegando...', 'info');
  const res = await window.polonio.contracts.deployUser({ title: 'Script', source: src, fileName: 'Script.sol', constructorArgs: [] });
  if (res.success) {
    consoleOutput(`Desplegado en: ${res.address}`, 'success');
    terminalLog(`Deploy => ${res.address}`);
    refreshConsoleContracts();
  } else {
    consoleOutput(`Error: ${res.error}`, 'error');
  }
}

async function invokeFromConsole() {
  const contractName = document.getElementById('console-contract-select').value;
  const method = document.getElementById('console-method').value.trim();
  const argsStr = document.getElementById('console-args').value.trim();
  const value = document.getElementById('console-value').value.trim() || '0';
  const accountIdx = parseInt(document.getElementById('console-account-select').value) || 0;

  if (!contractName) { showToast('Selecciona un contrato', 'warning'); return; }
  if (!method) { showToast('Introduce un metodo', 'warning'); return; }

  const args = argsStr ? argsStr.split(',').map(a => a.trim()) : [];
  const abiData = await window.polonio.contracts.getAbi(contractName);
  if (!abiData) { consoleOutput('ABI no encontrado', 'error'); return; }

  consoleOutput(`> ${contractName}.${method}(${args.join(', ')})`, 'info');

  const res = await window.polonio.contracts.interact({
    address: abiData.contractAddress,
    abi: abiData.abi,
    methodName: method,
    args,
    accountIndex: accountIdx,
    value,
  });

  if (res.success) {
    if (res.type === 'call') {
      consoleOutput(JSON.stringify(res.result, null, 2), 'success');
    } else {
      consoleOutput(`TX: ${res.result.transactionHash}`, 'success');
      consoleOutput(`Gas: ${res.result.gasUsed} | Block: ${res.result.blockNumber}`);
      if (res.result.events && Object.keys(res.result.events).length) {
        consoleOutput(`Events: ${JSON.stringify(res.result.events, null, 2)}`);
      }
    }
    terminalLog(`${method}() => OK`);
  } else {
    consoleOutput(`Error: ${res.error}`, 'error');
    terminalLog(`${method}() => FAILED`, 'error');
  }
}

// ─── Inspector ───────────────────────────────────────────────────────────────

async function readStorage() {
  const addr = document.getElementById('inspector-address').value.trim();
  const slot = document.getElementById('inspector-slot').value.trim();
  if (!addr) { showToast('Introduce una direccion', 'warning'); return; }
  const res = await window.polonio.inspector.readStorage(addr, parseInt(slot));
  const el = document.getElementById('storage-result');
  el.style.display = 'block';
  if (res.error) {
    el.innerHTML = `<span class="text-error">${res.error}</span>`;
  } else {
    el.innerHTML = `<div><strong>Raw:</strong> ${res.raw}</div><div><strong>uint256:</strong> ${res.interpretations.asUint256}</div><div><strong>address:</strong> ${res.interpretations.asAddress}</div><div><strong>bool:</strong> ${res.interpretations.asBool}</div>`;
  }
}

async function inspectAddress() {
  const addr = document.getElementById('inspector-info-address').value.trim();
  if (!addr) return;
  const [balance, code] = await Promise.all([
    window.polonio.inspector.getBalance(addr),
    window.polonio.inspector.getCode(addr),
  ]);
  const el = document.getElementById('address-info-result');
  el.style.display = 'block';
  el.innerHTML = `<div><strong>Balance:</strong> ${balance.ether} ETH</div><div><strong>Code:</strong> ${!code.isEmpty ? `${code.size} bytes` : 'EOA (sin codigo)'}</div>`;
}

async function inspectTx() {
  const hash = document.getElementById('inspector-tx-hash').value.trim();
  if (!hash) return;
  const res = await window.polonio.inspector.getTransactionReceipt(hash);
  const el = document.getElementById('tx-result');
  el.style.display = 'block';
  el.innerHTML = res.error ? `<span class="text-error">${res.error}</span>` : `<pre>${JSON.stringify(res, null, 2)}</pre>`;
}

// ─── Background ──────────────────────────────────────────────────────────────

function initBackground() {
  const canvas = document.getElementById('bgCanvas');
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

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initBackground();

  const session = await window.polonio.auth.getSession();
  if (session.authenticated) {
    state.authenticated = true;
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
    document.getElementById('settings-username').textContent = session.username;
    loadDashboard();
  }

  // Login
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // Nav
  document.querySelectorAll('.nav-item[data-view]').forEach(item => {
    item.addEventListener('click', () => {
      const v = item.dataset.view;
      navigateTo(v);
      if (v === 'challenges') loadChallenges();
      if (v === 'dashboard') loadDashboard();
      if (v === 'console') { refreshConsoleContracts(); refreshConsoleAccounts(); }
    });
  });

  // Blockchain
  document.getElementById('btn-start-blockchain').addEventListener('click', startBlockchain);
  document.getElementById('btn-stop-blockchain').addEventListener('click', stopBlockchain);
  document.getElementById('btn-reset-blockchain').addEventListener('click', resetBlockchain);

  // Logout
  document.getElementById('btn-logout').addEventListener('click', handleLogout);
  document.getElementById('btn-settings-logout').addEventListener('click', handleLogout);

  // Challenges
  document.querySelectorAll('.filter-btn[data-level]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadChallenges(btn.dataset.level);
    });
  });
  document.getElementById('btn-back-challenges').addEventListener('click', () => { navigateTo('challenges'); loadChallenges(); });
  document.getElementById('btn-activate-challenge').addEventListener('click', activateChallenge);
  document.getElementById('btn-validate-challenge').addEventListener('click', validateChallenge);
  document.getElementById('btn-writeup-challenge').addEventListener('click', openWriteup);
  document.getElementById('btn-mark-completed').addEventListener('click', markCompleted);
  document.getElementById('writeup-modal-close').addEventListener('click', closeWriteup);
  document.getElementById('writeup-modal-backdrop').addEventListener('click', closeWriteup);
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    window.polonio.system.copyToClipboard(document.getElementById('detail-code-display').textContent);
    showToast('Copiado');
  });

  // Console
  document.getElementById('btn-compile-script').addEventListener('click', compileScript);
  document.getElementById('btn-deploy-script').addEventListener('click', deployScript);
  document.getElementById('btn-run-script').addEventListener('click', runScript);
  document.getElementById('btn-console-invoke').addEventListener('click', invokeFromConsole);
  document.getElementById('tab-editor').addEventListener('click', () => switchConsoleTab('editor'));
  document.getElementById('tab-source').addEventListener('click', () => switchConsoleTab('source'));
  document.getElementById('source-contract-select').addEventListener('change', loadSourceCode);

  // Inspector
  document.getElementById('btn-read-storage').addEventListener('click', readStorage);
  document.getElementById('btn-inspect-address').addEventListener('click', inspectAddress);
  document.getElementById('btn-inspect-tx').addEventListener('click', inspectTx);

  // Terminal toggle
  document.getElementById('terminal-header').addEventListener('click', () => {
    document.getElementById('terminal-panel').classList.toggle('collapsed');
  });

  // Periodic status
  setInterval(async () => {
    if (state.authenticated) {
      const s = await window.polonio.blockchain.getStatus();
      if (s.running !== state.blockchainRunning) { state.blockchainRunning = s.running; updateBlockchainUI(s.running); }
    }
  }, 10000);
});
