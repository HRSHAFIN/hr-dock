/* HR Dock — notes.
   A grid of cards plus a full-panel editor. The editor understands the
   markdown shorthand people type by reflex (`# `, `- `, `1. `, `[] `, `> `,
   `---`), so formatting never requires reaching for the toolbar. Edits
   autosave on a short debounce and flush when the editor closes. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let query = '';
  let categoryFilter = 'all';
  let sortBy = 'updated';
  let editingId = null;
  let mounted = false;
  let lastDeleted = null;          // for undo

  const save = UI.debounce(() => commit(), 550);

  function tint(color) {
    if (!color || color === 'transparent') return 'var(--surface-1)';
    return `color-mix(in srgb, ${color} 16%, transparent)`;
  }

  /** Escape for HTML, then wrap search hits so matches are visible. */
  function highlight(text, term) {
    const safe = esc(text);
    if (!term || term.trim().length < 2) return safe;
    const needle = esc(term.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(needle, 'gi'), m => `<mark>${m}</mark>`);
  }

  /**
   * The note's opening line — the first block that actually has words in it.
   * Flattening the whole note and slicing would splice unrelated lines
   * together, which reads like nonsense on the card.
   */
  function firstLine(html) {
    const div = document.createElement('div');
    div.innerHTML = html;
    for (const node of Array.from(div.childNodes)) {
      const text = (node.textContent || '').replace(/​/g, '').trim();
      if (text) return text;
    }
    return (div.textContent || '').replace(/​/g, '').trim();
  }

  /** Checklist progress for a note, or null when it has no checklist. */
  function checklistProgress(html) {
    const div = document.createElement('div');
    div.innerHTML = UI.sanitizeHtml(html);
    const items = div.querySelectorAll('.chk');
    if (!items.length) return null;
    let done = 0;
    items.forEach(i => { if (i.dataset.done === '1') done++; });
    return { done, total: items.length };
  }

  function sortNotes(list) {
    const copy = [...list];
    if (sortBy === 'created') copy.sort((a, b) => b.createdAt - a.createdAt);
    else if (sortBy === 'title') {
      copy.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    } else copy.sort((a, b) => b.updatedAt - a.updatedAt);
    // Pinned notes always float, whatever the sort.
    return copy.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  }

  // -------------------------------------------------------------- the grid

  function render() {
    if (!mounted) return;
    if (!State.isActiveTab('notes')) return;
    renderControls();

    const grid = $('#notesGrid');
    let notes = State.Notes.search(query);
    if (categoryFilter !== 'all') notes = notes.filter(n => (n.category || 'general') === categoryFilter);
    notes = sortNotes(notes);

    grid.innerHTML = '';
    if (!notes.length) {
      const empty = el('div', { class: 'empty', style: { gridColumn: '1 / -1' } }, [
        el('strong', { text: query ? 'No matches' : 'No notes yet' }),
        el('div', {
          text: query
            ? `Nothing found for "${query}".`
            : 'Jot down a thought, a checklist, a meeting note — it saves as you type.'
        })
      ]);
      if (!query) {
        empty.appendChild(el('div', { style: { marginTop: '12px' } }, [
          el('button', { class: 'primary-btn', text: '+ New note', onClick: () => open(null) })
        ]));
      }
      grid.appendChild(empty);
      return;
    }

    for (const note of notes) grid.appendChild(noteCard(note));
  }

  function noteCard(note) {
    const card = el('div', { class: 'note', style: { '--note-bg': tint(note.color) } });
    card.dataset.id = note.id;

    const progress = checklistProgress(note.html);
    const excerpt = UI.textOf(note.html).slice(0, 170);
    const cat = State.categoryOf(note.category);

    card.innerHTML = `
      <div class="note-title">${highlight(note.title || 'Untitled', query)}</div>
      <div class="note-excerpt">${excerpt ? highlight(excerpt, query) : '<i>Empty note</i>'}</div>
      <div class="note-foot">
        <span class="note-cat"><i style="background:${cat.color}"></i>${esc(cat.label)}</span>
        ${progress
          ? `<span class="note-progress${progress.done === progress.total ? ' complete' : ''}">${progress.done}/${progress.total}</span>`
          : ''}
        <span class="note-when">${esc(DT.relativeDay(DT.key(new Date(note.updatedAt))))}</span>
      </div>`;

    // Hover actions — pinning used to be right-click only, which nobody finds.
    const actions = el('div', { class: 'note-actions' }, [
      el('button', {
        class: `icon-btn sm${note.pinned ? ' pinned' : ''}`,
        title: note.pinned ? 'Unpin' : 'Pin to top',
        html: Icons.icon('pinSm', 12),
        onClick: e => { e.stopPropagation(); togglePin(note.id); }
      }),
      el('button', {
        class: 'icon-btn sm',
        title: 'Duplicate',
        html: Icons.icon('note', 12),
        onClick: e => {
          e.stopPropagation();
          const copy = State.Notes.save({
            ...note, id: null, title: (note.title || 'Untitled') + ' (copy)', pinned: false
          });
          UI.toast({ kind: 'success', title: 'Note duplicated', timeout: 1800 });
          setTimeout(() => open(copy.id), 200);
        }
      }),
      el('button', {
        class: 'icon-btn sm danger',
        title: 'Delete',
        html: Icons.icon('trash', 12),
        onClick: e => { e.stopPropagation(); removeNote(note.id); }
      })
    ]);
    card.appendChild(actions);

    if (note.pinned) card.appendChild(el('span', { class: 'note-pin', html: Icons.icon('pinSm', 12) }));

    card.addEventListener('click', () => open(note.id));
    return card;
  }

  function renderControls() {
    const host = $('#noteCats');
    const used = new Set(State.Notes.all().map(n => n.category || 'general'));
    const cats = State.CATEGORIES.filter(c => used.has(c.id));

    host.innerHTML = '';
    if (cats.length > 1) {
      const chip = (id, label) => el('button', {
        class: `chip${categoryFilter === id ? ' active' : ''}`,
        text: label,
        onClick: () => { categoryFilter = id; render(); }
      });
      host.appendChild(chip('all', 'All'));
      for (const cat of cats) host.appendChild(chip(cat.id, cat.label));
    }

    if (State.Notes.all().length > 1) {
      const sort = el('select', {
        class: 'mini-select',
        title: 'Sort notes',
        onChange: e => { sortBy = e.target.value; render(); }
      });
      for (const opt of [['updated', 'Recently edited'], ['created', 'Newest first'], ['title', 'A–Z']]) {
        sort.appendChild(el('option', { value: opt[0], text: opt[1], selected: sortBy === opt[0] }));
      }
      host.appendChild(sort);
    }
  }

  // ---------------------------------------------------------- the editor

  function open(id) {
    const note = id ? State.Notes.byId(id) : null;
    editingId = note ? note.id : null;

    const editor = $('#noteEditor');
    const title = $('#noteTitle');
    const bodyEl = $('#noteBody');
    const category = $('#noteCategory');

    title.value = note ? note.title : '';
    // Stored HTML is cleaned on the way in, not just on the way out.
    // An empty editor gets a real block to start in: typing into a bare
    // contenteditable produces loose text nodes, and formatBlock (every
    // heading/quote shorthand) has nothing to convert.
    const html = note ? UI.sanitizeHtml(note.html) : '';
    bodyEl.innerHTML = UI.textOf(html) || /<(hr|img)/i.test(html) ? html : '<div><br></div>';

    category.innerHTML = '';
    for (const cat of State.CATEGORIES) {
      category.appendChild(el('option', {
        value: cat.id, text: cat.label,
        selected: (note ? note.category : 'general') === cat.id
      }));
    }

    renderColorPicker(note ? note.color : 'transparent');
    updatePinButton(note ? note.pinned : false);

    editor.hidden = false;
    editor.dataset.color = note ? note.color : 'transparent';
    editor.dataset.pinned = String(note ? !!note.pinned : false);
    if (note) setStatus('idle', `Edited ${DT.relativeDay(DT.key(new Date(note.updatedAt)))}`);
    else setStatus('new');
    updateCount();

    setTimeout(() => (note ? bodyEl : title).focus(), 50);
  }

  function renderColorPicker(active) {
    const host = $('#noteColors');
    host.innerHTML = '';
    for (const color of State.NOTE_COLORS) {
      host.appendChild(el('i', {
        class: color === active ? 'active' : '',
        title: color === 'transparent' ? 'No colour' : color,
        style: {
          background: color === 'transparent' ? 'var(--surface-3)' : color,
          border: color === 'transparent' ? '1.5px dashed var(--ink-4)' : undefined
        },
        onClick: () => {
          $('#noteEditor').dataset.color = color;
          renderColorPicker(color);
          save();
        }
      }));
    }
  }

  function updatePinButton(pinned) {
    const btn = $('#notePin');
    btn.innerHTML = Icons.icon('pinSm', 13);
    btn.setAttribute('aria-pressed', String(!!pinned));
    btn.title = pinned ? 'Unpin note' : 'Pin note';
  }

  /**
   * Say what the editor is doing with the writing.
   * Autosave is invisible by nature, and an editor that never shows a Save
   * control reads as one that might lose your work — so the status line is
   * explicit, and the Save button exists even though it is rarely needed.
   */
  function setStatus(state, when) {
    const node = $('#noteSaved');
    if (!node) return;
    node.dataset.state = state;
    if (state === 'saving') node.textContent = 'Saving…';
    else if (state === 'saved') node.textContent = `Saved ${when || new Date().toLocaleTimeString()}`;
    else if (state === 'new') node.textContent = 'Saves as you type';
    else node.textContent = when || '';
  }

  function updateCount() {
    const counter = $('#noteCount');
    if (!counter) return;
    const text = UI.textOf($('#noteBody').innerHTML);
    const words = text ? text.split(/\s+/).length : 0;
    const progress = checklistProgress($('#noteBody').innerHTML);
    counter.textContent = [
      words ? UI.plural(words, 'word') : '',
      progress ? `${progress.done}/${progress.total} done` : ''
    ].filter(Boolean).join(' · ');
  }

  /** Write the editor's contents back into the store. */
  function commit() {
    const editor = $('#noteEditor');
    if (editor.hidden) return null;

    const bodyHtml = UI.sanitizeHtml($('#noteBody').innerHTML);
    const text = UI.textOf(bodyHtml);
    let title = $('#noteTitle').value.trim();

    if (!title && !text) {
      // Never persist a blank note; drop it if it existed and was emptied.
      if (editingId) { State.Notes.remove(editingId); editingId = null; }
      return null;
    }
    // An untitled note takes its name from its first line, the way a person
    // would name it — better than a wall of cards all reading "Untitled".
    if (!title) title = firstLine(bodyHtml).slice(0, 60);

    const record = State.Notes.save({
      id: editingId,
      title,
      html: bodyHtml,
      color: editor.dataset.color || 'transparent',
      pinned: editor.dataset.pinned === 'true',
      category: $('#noteCategory').value
    });
    editingId = record.id;
    setStatus('saved', new Date(record.updatedAt).toLocaleTimeString());
    updateCount();
    return record;
  }

  /**
   * Commit right now, on purpose.
   * Autosave already does this, but pressing Save should visibly confirm the
   * writing is safe rather than leaving the user to trust a debounce.
   */
  function saveNow(silent) {
    save.cancel();
    const record = commit();
    if (!record) {
      if (!silent) UI.toast({ title: 'Nothing to save yet', message: 'Write something first.', timeout: 2000 });
      return null;
    }
    if (!silent) UI.toast({ kind: 'success', title: 'Note saved', message: record.title, timeout: 1600 });
    return record;
  }

  function close() {
    save.cancel();
    commit();
    $('#noteEditor').hidden = true;
    editingId = null;
    render();
  }

  function togglePin(id) {
    const note = State.Notes.byId(id);
    if (!note) return;
    State.Notes.save({ ...note, pinned: !note.pinned });
    UI.toast({ title: note.pinned ? 'Unpinned' : 'Pinned to top', timeout: 1500 });
  }

  /** Delete with an undo window — a note is easy to lose and hard to retype. */
  function removeNote(id) {
    const note = State.Notes.byId(id);
    if (!note) return;
    lastDeleted = { ...note };
    State.Notes.remove(id);
    if (editingId === id) { $('#noteEditor').hidden = true; editingId = null; }
    render();
    UI.toast({
      title: 'Note deleted',
      message: note.title || 'Untitled',
      timeout: 7000,
      actions: [{
        label: 'Undo',
        primary: true,
        onClick: () => {
          if (!lastDeleted) return;
          State.Notes.save(lastDeleted);
          lastDeleted = null;
          render();
        }
      }]
    });
  }

  // ------------------------------------------------- rich text & shorthand

  function exec(command) {
    const bodyEl = $('#noteBody');
    bodyEl.focus();
    if (command === 'hiliteColor') document.execCommand('hiliteColor', false, 'rgba(245,196,81,.35)');
    else if (command === 'checklist') toggleChecklistLine();
    else if (command === 'link') insertLink();
    else document.execCommand(command, false, null);
    save();
    updateCount();
  }

  /** The block element the caret currently sits in. */
  function caretBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    return node.closest ? node.closest('div, p, li, h1, h2, h3, blockquote') : null;
  }

  function toggleChecklistLine() {
    const block = caretBlock();
    if (block && block.classList.contains('chk')) {
      const text = block.textContent;
      const plain = document.createElement('div');
      plain.textContent = text;
      block.replaceWith(plain);
      return;
    }
    document.execCommand('insertHTML', false, '<div class="chk" data-done="0">&#8203;</div>');
  }

  function insertLink() {
    const sel = window.getSelection();
    const selected = sel && String(sel);
    const input = el('input', { type: 'text', placeholder: 'https://example.com' });
    const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

    UI.modal({
      title: 'Add a link',
      body: el('div', { class: 'field' }, [
        el('label', { text: selected ? `Link for "${selected.slice(0, 40)}"` : 'Address' }),
        input
      ]),
      actions: [
        { spacer: true },
        { label: 'Cancel', onClick: c => c(true) },
        {
          label: 'Add link', primary: true, onClick: c => {
            let url = input.value.trim();
            if (!url) { c(true); return; }
            if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
            c(true);
            $('#noteBody').focus();
            if (saved) {
              const s = window.getSelection();
              s.removeAllRanges();
              s.addRange(saved);
            }
            if (!String(window.getSelection())) document.execCommand('insertText', false, url);
            document.execCommand('createLink', false, url);
            save();
          }
        }
      ]
    });
  }

  /**
   * Markdown shorthand: typing the marker plus a space converts the line.
   * This is what people already type in every other notes app, so honouring
   * it means the toolbar becomes optional rather than mandatory.
   */
  const SHORTHAND = [
    { marker: '#', apply: () => document.execCommand('formatBlock', false, 'h1') },
    { marker: '##', apply: () => document.execCommand('formatBlock', false, 'h2') },
    { marker: '###', apply: () => document.execCommand('formatBlock', false, 'h3') },
    { marker: '-', apply: () => document.execCommand('insertUnorderedList') },
    { marker: '*', apply: () => document.execCommand('insertUnorderedList') },
    { marker: '1.', apply: () => document.execCommand('insertOrderedList') },
    { marker: '[]', apply: () => toggleChecklistLine() },
    { marker: '[ ]', apply: () => toggleChecklistLine() },
    { marker: '>', apply: () => document.execCommand('formatBlock', false, 'blockquote') }
  ];

  function handleShorthand(e) {
    if (e.key !== ' ') return false;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== 3) return false;

    const before = node.textContent.slice(0, range.startOffset);
    if (before.length > 4 || !before.trim()) return false;

    const hit = SHORTHAND.find(s => s.marker === before.trim());
    if (!hit) return false;

    // Inside a list the markers are just characters: "- " is how you write a
    // dash, and converting a list item into a nested list is never what was
    // meant. Enter already continues the list.
    const block = caretBlock();
    if (block && (block.tagName === 'LI' || block.closest('ul, ol'))) return false;

    e.preventDefault();
    node.textContent = node.textContent.slice(range.startOffset);
    const r = document.createRange();
    r.setStart(node, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    hit.apply();
    save();
    return true;
  }

  /** Enter inside a checklist continues it; Enter on an empty item leaves it. */
  function handleChecklistEnter(e) {
    if (e.key !== 'Enter' || e.shiftKey) return false;
    const block = caretBlock();
    if (!block || !block.classList.contains('chk')) return false;

    e.preventDefault();
    const text = block.textContent.replace(/​/g, '').trim();
    if (!text) {
      const plain = document.createElement('div');
      plain.innerHTML = '<br>';
      block.replaceWith(plain);
      placeCaret(plain);
      return true;
    }
    const next = document.createElement('div');
    next.className = 'chk';
    next.dataset.done = '0';
    next.innerHTML = '​';
    block.after(next);
    placeCaret(next);
    save();
    return true;
  }

  function placeCaret(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function init() {
    mounted = true;
    try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch (_) { /* older engines */ }

    $('#noteAdd').addEventListener('click', () => open(null));
    $('#noteClose').addEventListener('click', close);

    $('#noteSave').addEventListener('click', () => saveNow());
    $('#noteDone').addEventListener('click', () => { saveNow(true); close(); });
    $('#noteDelete').addEventListener('click', () => {
      if (!editingId) { close(); return; }
      removeNote(editingId);
    });

    $('#notePin').addEventListener('click', () => {
      const editor = $('#noteEditor');
      const next = editor.dataset.pinned !== 'true';
      editor.dataset.pinned = String(next);
      updatePinButton(next);
      save();
    });

    $('#noteTitle').addEventListener('input', () => { setStatus('saving'); save(); });
    $('#noteCategory').addEventListener('change', save);

    const body = $('#noteBody');
    body.addEventListener('input', () => { setStatus('saving'); save(); updateCount(); });

    // Paste as plain text, but keep a pasted URL as a working link.
    body.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (/^https?:\/\/\S+$/i.test(text.trim())) {
        document.execCommand('createLink', false, text.trim());
      } else {
        document.execCommand('insertText', false, text);
      }
      save();
      updateCount();
    });

    body.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); insertLink(); return; }
      if (handleChecklistEnter(e)) return;
      handleShorthand(e);
    });

    // Clicking the marker area toggles a checklist item; Ctrl+click opens links.
    body.addEventListener('click', e => {
      const link = e.target.closest('a[href]');
      if (link && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        hrdock.openExternal(link.href);
        return;
      }
      const item = e.target.closest('.chk');
      if (!item) return;
      const rect = item.getBoundingClientRect();
      if (e.clientX - rect.left > 22) return;
      item.dataset.done = item.dataset.done === '1' ? '0' : '1';
      save();
      updateCount();
    });

    $('#rteToolbar').addEventListener('mousedown', e => {
      const btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      e.preventDefault();               // keep the caret where it is
      exec(btn.dataset.cmd);
    });

    $('#noteSearch').addEventListener('input', UI.debounce(e => {
      query = e.target.value;
      render();
    }, 160));

    State.on('notes', () => { if ($('#noteEditor').hidden) render(); });
    State.on('settings', () => { if ($('#noteEditor').hidden) render(); });

    render();
  }

  global.Notes = {
    init,
    render,
    open,
    close,
    flush: () => { save.cancel(); commit(); },
    isEditing: () => !$('#noteEditor').hidden
  };
}(window));
