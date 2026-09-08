/* HR Dock — DOM helpers, toasts, modals and the notification chime. */
(function (global) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Create an element from tag, props and children in one call. */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const child of [].concat(children || [])) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  /** Escape user text before it goes anywhere near innerHTML. */
  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid(prefix) {
    return `${prefix || 'id'}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function debounce(fn, wait) {
    let t = null;
    const wrapped = function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
    };
    wrapped.cancel = () => { if (t) { clearTimeout(t); t = null; } };
    wrapped.flush = function (...args) { if (t) { clearTimeout(t); t = null; } fn.apply(this, args); };
    return wrapped;
  }

  function throttle(fn, wait) {
    let last = 0, pending = null;
    return function (...args) {
      const now = Date.now();
      if (now - last >= wait) { last = now; fn.apply(this, args); }
      else if (!pending) {
        pending = setTimeout(() => {
          pending = null; last = Date.now(); fn.apply(this, args);
        }, wait - (now - last));
      }
    };
  }

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  function formatBytes(bytes, digits) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, i)).toFixed(digits === undefined ? (i > 1 ? 1 : 0) : digits)} ${units[i]}`;
  }

  function formatRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return '0 KB/s';
    if (bytesPerSec > 1024 * 1024) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  }

  function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

  /**
   * Strip HTML down to readable text (for note previews and search).
   * Block boundaries become spaces, otherwise adjacent lines would run
   * together as one unreadable word.
   */
  function textOf(html) {
    const div = document.createElement('div');
    div.innerHTML = String(html || '')
      .replace(/<(br|hr)\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|blockquote)>/gi, ' ');
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // ------------------------------------------------------------------ sound

  let audioCtx = null;
  /** A short two-note chime, synthesised so no audio file ships with the app. */
  function chime(kind) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      const notes = kind === 'alert' ? [880, 660] : [740, 988];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.16);
        gain.gain.setValueAtTime(0, now + i * 0.16);
        gain.gain.linearRampToValueAtTime(0.16, now + i * 0.16 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.16 + 0.42);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + i * 0.16);
        osc.stop(now + i * 0.16 + 0.45);
      });
    } catch (err) {
      console.warn('[chime] unavailable', err);
    }
  }

  // ----------------------------------------------------------------- toasts

  const toastHost = () => $('#toasts');

  function toast(opts) {
    const o = typeof opts === 'string' ? { title: opts } : (opts || {});
    const host = toastHost();
    if (!host) return () => {};

    const node = el('div', { class: `toast ${o.kind || ''}` });
    node.innerHTML = `
      <span class="toast-icon">${Icons.icon(o.icon || (o.kind === 'error' ? 'alert' : o.kind === 'success' ? 'check' : 'info'), 18)}</span>
      <div class="toast-body">
        <div class="toast-title">${esc(o.title || '')}</div>
        ${o.message ? `<div class="toast-msg">${esc(o.message)}</div>` : ''}
      </div>`;

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 200);
    };

    if (o.actions && o.actions.length) {
      const bar = el('div', { class: 'toast-actions' });
      for (const action of o.actions) {
        bar.appendChild(el('button', {
          class: action.primary ? 'primary-btn' : 'ghost-btn',
          text: action.label,
          onClick: () => { try { action.onClick(close); } finally { if (!action.keepOpen) close(); } }
        }));
      }
      node.querySelector('.toast-body').appendChild(bar);
    } else {
      node.addEventListener('click', close);
    }

    host.appendChild(node);
    const timeout = o.timeout === undefined ? 4200 : o.timeout;
    if (timeout > 0) setTimeout(close, timeout);
    // Keep the stack shallow so it never covers the whole widget.
    while (host.children.length > 4) host.firstElementChild.remove();
    return close;
  }

  // ----------------------------------------------------------------- modals

  let activeModal = null;

  /**
   * modal({ title, body, actions, wide, onClose }) -> { close, root }
   * `body` may be an element or an HTML string; `actions` render in the footer.
   */
  function modal(opts) {
    const root = $('#modalRoot');
    if (!root) return { close() {} };
    if (activeModal) activeModal.close(true);

    root.innerHTML = '';
    root.hidden = false;

    const box = el('div', { class: 'modal' });
    const head = el('div', { class: 'modal-head' }, [
      el('h3', { text: opts.title || '' }),
      el('button', { class: 'icon-btn sm', html: Icons.icon('x', 14), title: 'Close', onClick: () => close() })
    ]);
    const body = el('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    box.appendChild(head);
    box.appendChild(body);

    if (opts.actions && opts.actions.length) {
      const foot = el('div', { class: 'modal-foot' });
      for (const action of opts.actions) {
        if (action.spacer) { foot.appendChild(el('div', { class: 'spacer' })); continue; }
        foot.appendChild(el('button', {
          class: action.primary ? 'primary-btn' : (action.danger ? 'ghost-btn danger' : 'ghost-btn'),
          text: action.label,
          onClick: () => action.onClick(close)
        }));
      }
      box.appendChild(foot);
    }

    root.appendChild(box);

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    function onBackdrop(e) {
      if (e.target === root) close();
    }
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('mousedown', onBackdrop);

    function close(silent) {
      document.removeEventListener('keydown', onKey, true);
      root.removeEventListener('mousedown', onBackdrop);
      root.hidden = true;
      root.innerHTML = '';
      activeModal = null;
      if (!silent && opts.onClose) opts.onClose();
    }

    activeModal = { close };
    const focusable = body.querySelector('input, textarea, select, button');
    if (focusable) setTimeout(() => focusable.focus(), 40);
    return { close, root: box, body };
  }

  /** Promise-based confirmation dialog. */
  function confirm(title, message, confirmLabel) {
    return new Promise(resolve => {
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value); } };
      modal({
        title,
        body: el('p', { text: message, style: { fontSize: '12.5px', color: 'var(--ink-2)', lineHeight: '1.55' } }),
        actions: [
          { spacer: true },
          { label: 'Cancel', onClick: close => { done(false); close(true); } },
          { label: confirmLabel || 'Confirm', danger: true, onClick: close => { done(true); close(true); } }
        ],
        onClose: () => done(false)
      });
    });
  }

  global.UI = {
    $, $$, el, esc, uid, debounce, throttle, clamp,
    formatBytes, formatRate, formatDuration, plural, textOf,
    chime, toast, modal, confirm
  };
}(window));
