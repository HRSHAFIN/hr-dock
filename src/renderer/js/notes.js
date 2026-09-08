/* HR Dock — sticky notes.
   A grid of cards plus a full-panel rich-text editor. Edits autosave on a
   short debounce and flush immediately when the editor closes, so nothing is
   ever lost to a stray click or a sudden quit. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let query = '';
  let categoryFilter = 'all';
  let editingId = null;
  let mounted = false;

  const save = UI.debounce(() => commit(), 550);

  function tint(color) {
    if (!color || color === 'transparent') return 'var(--surface-1)';
    return `color-mix(in srgb, ${color} 16%, transparent)`;
  }

  // -------------------------------------------------------------- the grid

  function render() {
    if (!mounted) return;
    if (!State.isActiveTab('notes')) return;
    renderCategoryChips();

    const grid = $('#notesGrid');
    let notes = State.Notes.search(query);
    if (categoryFilter !== 'all') notes = notes.filter(n => (n.category || 'general') === categoryFilter);

    grid.innerHTML = '';
    if (!notes.length) {
      grid.appendChild(el('div', {
        class: 'empty',
        style: { gridColumn: '1 / -1' },
        html: query
          ? `<strong>No matches</strong>Nothing found for "${esc(query)}".`
          : '<strong>No notes yet</strong>Capture a thought with + Note.'
      }));
      return;
    }

    for (const note of notes) {
      const card = el('div', { class: 'note', style: { '--note-bg': tint(note.color) } });
      card.dataset.id = note.id;
      const excerpt = UI.textOf(note.html).slice(0, 180);
      card.innerHTML = `
        ${note.pinned ? `<span class="note-pin">${Icons.icon('pinSm', 12)}</span>` : ''}
        <div class="note-title">${esc(note.title || 'Untitled')}</div>
        <div class="note-excerpt">${esc(excerpt || 'Empty note')}</div>
        <div class="note-foot">
          <span>${esc(State.categoryOf(note.category).label)}</span>
          <span>${esc(DT.relativeDay(DT.key(new Date(note.updatedAt))))}</span>
        </div>`;
      card.addEventListener('click', () => open(note.id));
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        togglePin(note.id);
      });
      grid.appendChild(card);
    }
  }

  function renderCategoryChips() {
    const host = $('#noteCats');
    const used = new Set(State.Notes.all().map(n => n.category || 'general'));
    const cats = State.CATEGORIES.filter(c => used.has(c.id));
    if (!cats.length) { host.innerHTML = ''; return; }

    host.innerHTML = '';
    const makeChip = (id, label) => el('button', {
      class: `chip${categoryFilter === id ? ' active' : ''}`,
      text: label,
      onClick: () => { categoryFilter = id; render(); }
    });
    host.appendChild(makeChip('all', 'All'));
    for (const cat of cats) host.appendChild(makeChip(cat.id, cat.label));
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
    bodyEl.innerHTML = note ? note.html : '';
    bodyEl.dataset.placeholder = 'Start writing…';

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
    $('#noteSaved').textContent = note ? `Edited ${new Date(note.updatedAt).toLocaleString()}` : 'New note';

    setTimeout(() => (note ? bodyEl : title).focus(), 50);
  }

  function renderColorPicker(active) {
    const host = $('#noteColors');
    host.innerHTML = '';
    for (const color of State.NOTE_COLORS) {
      const swatch = el('i', {
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
      });
      host.appendChild(swatch);
    }
  }

  function updatePinButton(pinned) {
    const btn = $('#notePin');
    btn.innerHTML = Icons.icon('pinSm', 13);
    btn.setAttribute('aria-pressed', String(!!pinned));
    btn.title = pinned ? 'Unpin note' : 'Pin note';
  }

  /** Write the editor's current contents back into the store. */
  function commit() {
    const editor = $('#noteEditor');
    if (editor.hidden) return null;

    const title = $('#noteTitle').value.trim();
    const html = $('#noteBody').innerHTML;
    const isEmpty = !title && !UI.textOf(html);

    if (isEmpty) {
      // Never persist a blank note; drop it if it already existed and was emptied.
      if (editingId) { State.Notes.remove(editingId); editingId = null; }
      return null;
    }

    const record = State.Notes.save({
      id: editingId,
      title,
      html,
      color: editor.dataset.color || 'transparent',
      pinned: editor.dataset.pinned === 'true',
      category: $('#noteCategory').value
    });
    editingId = record.id;
    $('#noteSaved').textContent = `Saved ${new Date(record.updatedAt).toLocaleTimeString()}`;
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
    UI.toast({ title: note.pinned ? 'Unpinned' : 'Pinned to top', timeout: 1600 });
  }

  // ------------------------------------------------------- rich text edit

  function exec(command) {
    const bodyEl = $('#noteBody');
    bodyEl.focus();
    if (command === 'hiliteColor') {
      document.execCommand('hiliteColor', false, 'rgba(245,196,81,.35)');
    } else if (command === 'checklist') {
      insertChecklistLine();
    } else {
      document.execCommand(command, false, null);
    }
    save();
  }

  /** Wrap the caret's line in a toggleable checklist item. */
  function insertChecklistLine() {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType === 3) node = node.parentNode;

    const existing = node.closest ? node.closest('.chk') : null;
    if (existing) {
      // Toggling off: unwrap back to a plain line.
      const text = existing.textContent;
      existing.replaceWith(document.createTextNode(text));
      return;
    }
    document.execCommand('insertHTML', false,
      '<div class="chk" data-done="0">&#8203;</div>');
  }

  function init() {
    mounted = true;

    $('#noteAdd').addEventListener('click', () => open(null));
    $('#noteClose').addEventListener('click', close);
    $('#noteDelete').addEventListener('click', async () => {
      if (!editingId) { close(); return; }
      const note = State.Notes.byId(editingId);
      const ok = await UI.confirm('Delete note', `"${note && note.title ? note.title : 'This note'}" will be removed.`, 'Delete');
      if (!ok) return;
      save.cancel();
      State.Notes.remove(editingId);
      editingId = null;
      $('#noteEditor').hidden = true;
      render();
    });

    $('#notePin').addEventListener('click', () => {
      const editor = $('#noteEditor');
      const next = editor.dataset.pinned !== 'true';
      editor.dataset.pinned = String(next);
      updatePinButton(next);
      save();
    });

    $('#noteTitle').addEventListener('input', save);
    $('#noteBody').addEventListener('input', save);
    $('#noteCategory').addEventListener('change', save);

    // Paste as plain text: pasted markup from a browser would wreck the theme.
    $('#noteBody').addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    $('#noteBody').addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save.flush(); }
    });

    // Clicking a checklist marker toggles it.
    $('#noteBody').addEventListener('click', e => {
      const item = e.target.closest('.chk');
      if (!item) return;
      const rect = item.getBoundingClientRect();
      if (e.clientX - rect.left > 22) return;
      item.dataset.done = item.dataset.done === '1' ? '0' : '1';
      save();
    });

    $('#rteToolbar').addEventListener('mousedown', e => {
      const btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      e.preventDefault();            // keep the caret where it is
      exec(btn.dataset.cmd);
    });

    const searchInput = $('#noteSearch');
    searchInput.addEventListener('input', UI.debounce(e => {
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
