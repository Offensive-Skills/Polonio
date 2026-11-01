'use strict';

/**
 * Render — Markdown and source code rendering for the renderer process.
 *
 * Depends on the vendored browser builds loaded before this file:
 *   marked (Markdown → HTML), DOMPurify (sanitizer), hljs + the Solidity grammar.
 *
 * Every HTML string produced here is either hljs output (which escapes the
 * source) or passes through DOMPurify, so it is safe to assign to innerHTML.
 */
const Render = (() => {
  // Writeups and challenge code are almost always Solidity.
  const DEFAULT_LANGUAGE = 'solidity';
  const AUTO_DETECT_SUBSET = ['solidity', 'javascript', 'typescript', 'bash', 'json', 'python'];

  const LANGUAGE_LABELS = {
    solidity: 'Solidity',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    bash: 'Bash',
    shell: 'Shell',
    json: 'JSON',
    python: 'Python',
    plaintext: 'Texto',
  };

  // Tokens that only make sense in Solidity: used to classify unlabeled blocks.
  const SOLIDITY_HINT = /\b(pragma\s+solidity|contract\s+\w+|interface\s+\w+|library\s+\w+|mapping\s*\(|u?int(8|16|32|64|128|256)\b|bytes(4|32)\b|address(\s+payable)?\s+\w+|msg\.(sender|value|data)|tx\.origin|modifier\s+\w+|emit\s+\w+|delegatecall|selfdestruct|external\s+payable|public\s+view|returns\s*\()/;

  // The Solidity grammar tags elementary types as plain keywords; give them
  // their own class so `uint256 balance` reads differently from `public view`.
  const SOLIDITY_TYPE = /<span class="hljs-keyword">(address|bool|string|bytes|byte|u?int(?:8|16|24|32|40|48|56|64|72|80|88|96|104|112|120|128|136|144|152|160|168|176|184|192|200|208|216|224|232|240|248|256)?|bytes(?:[1-9]|[12][0-9]|3[0-2])|u?fixed(?:\d+x\d+)?)<\/span>/g;
  hljs.addPlugin({
    'after:highlight': (result) => {
      if (result.language === 'solidity') {
        result.value = result.value.replace(SOLIDITY_TYPE, '<span class="hljs-type">$1</span>');
      }
    },
  });

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Resolve the language of a code block: the declared one when hljs knows it
   * (aliases like "sol", "js", "sh" included), otherwise a best guess biased
   * towards Solidity.
   */
  function resolveLanguage(declared, code) {
    const name = String(declared || '').trim().toLowerCase();
    if (name) {
      const lang = hljs.getLanguage(name);
      if (lang) return canonicalName(name);
      if (name === 'text' || name === 'txt' || name === 'plain') return 'plaintext';
    }
    if (SOLIDITY_HINT.test(code)) return 'solidity';
    const guess = hljs.highlightAuto(code, AUTO_DETECT_SUBSET);
    return guess.language && guess.relevance >= 5 ? guess.language : (name ? 'plaintext' : DEFAULT_LANGUAGE);
  }

  /** Map an alias ("sol", "js", "sh"…) to the grammar's primary name. */
  function canonicalName(name) {
    for (const lang of hljs.listLanguages()) {
      if (lang === name) return lang;
      const def = hljs.getLanguage(lang);
      if (def && Array.isArray(def.aliases) && def.aliases.includes(name)) return lang;
    }
    return name;
  }

  function languageLabel(language) {
    return LANGUAGE_LABELS[language] || language;
  }

  /** Highlighted (and escaped) HTML for `code`. */
  function highlight(code, language) {
    const text = String(code == null ? '' : code);
    if (language && language !== 'plaintext' && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    return escapeHtml(text);
  }

  /**
   * Render source code into `container` as a read-only code view with line
   * numbers. Indentation (spaces or tabs) is preserved exactly.
   */
  function codeView(container, source, language = DEFAULT_LANGUAGE) {
    const text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
    const lines = text.split('\n').length;

    const view = document.createElement('div');
    view.className = 'code-view';

    const gutter = document.createElement('div');
    gutter.className = 'code-view-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');

    const pre = document.createElement('pre');
    pre.className = 'code-view-pre';
    const code = document.createElement('code');
    code.className = `hljs language-${language}`;
    code.innerHTML = highlight(text, language);
    pre.appendChild(code);

    view.append(gutter, pre);
    container.replaceChildren(view);
  }

  /** Placeholder message inside a code container (comment style). */
  function codePlaceholder(container, message) {
    const p = document.createElement('div');
    p.className = 'code-view-placeholder';
    p.textContent = message;
    container.replaceChildren(p);
  }

  // ─── Markdown ──────────────────────────────────────────────────────────────

  const markdownParser = new marked.Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        const declared = String(lang || '').trim().split(/\s+/)[0];
        const language = resolveLanguage(declared, text);
        return '<div class="code-block">'
          + '<div class="code-block-header">'
          + `<span class="code-block-lang">${escapeHtml(languageLabel(language))}</span>`
          + '<button type="button" class="btn btn-ghost btn-sm code-block-copy">Copiar</button>'
          + '</div>'
          + `<pre><code class="hljs language-${escapeHtml(language)}">${highlight(text, language)}</code></pre>`
          + '</div>';
      },
    },
  });

  const PURIFY_CONFIG = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'option', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style', 'id', 'name'],
  };

  // Links: only http(s) and in-page anchors survive; external ones are opened
  // by the main process in the system browser (see setWindowOpenHandler).
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = (node.getAttribute('href') || '').trim();
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else if (!href.startsWith('#')) {
      node.removeAttribute('href');
    }
  });

  /** Sanitized HTML for a Markdown document. */
  function markdown(md) {
    const html = markdownParser.parse(String(md == null ? '' : md));
    return DOMPurify.sanitize(html, PURIFY_CONFIG);
  }

  return { markdown, highlight, codeView, codePlaceholder, resolveLanguage, escapeHtml };
})();
