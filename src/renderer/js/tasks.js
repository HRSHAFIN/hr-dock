/* HR Dock — to-do management.
   Quick-add understands plain language ("report tomorrow 5pm !high #work"),
   rows reorder by drag, repeating tasks roll forward on completion, and the
   stats strip tracks the daily streak. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let filter = 'today';
  let sort = 'manual';
  let mounted = false;

  // ------------------------------------------------------- language parsing

  const PRIORITY_WORDS = {
    low: 'low', l: 'low',
    med: 'medium', medium: 'medium', m: 'medium', normal: 'medium',
    high: 'high', h: 'high', urgent: 'high',
    crit: 'critical', critical: 'critical', c: 'critical', asap: 'critical'
  };

  const RECUR_WORDS = {
    daily: 'daily', 'every day': 'daily', everyday: 'daily',
    weekly: 'weekly', 'every week': 'weekly',
    monthly: 'monthly', 'every month': 'monthly',
    yearly: 'yearly', 'every year': 'yearly',
    weekdays: 'weekdays', 'every weekday': 'weekdays'
  };

  /**
   * Pull structured fields out of a free-text task line.
   * Anything it recognises is stripped from the title, so what remains reads
   * like a normal task name.
   */
  function parseTaskInput(raw) {
    let text = ` ${raw.trim()} `;
    const out = { title: '', due: null, dueTime: '', priority: 'medium', category: 'general', recurrence: 'none' };

    // !priority
    text = text.replace(/\s![a-z]+/gi, match => {
      const word = match.trim().slice(1).toLowerCase();
      if (PRIORITY_WORDS[word]) { out.priority = PRIORITY_WORDS[word]; return ' '; }
      return match;
    });

    // #category
    text = text.replace(/\s#([a-z]+)/gi, (match, word) => {
      const hit = State.CATEGORIES.find(c => c.id === word.toLowerCase());
      if (hit) { out.category = hit.id; return ' '; }
      return match;
    });

    // repetition
    for (const [phrase, value] of Object.entries(RECUR_WORDS)) {
      const re = new RegExp(`\\s${phrase}\\b`, 'i');
      if (re.test(text)) { out.recurrence = value; text = text.replace(re, ' '); break; }
    }

    // explicit date: 2026-09-08 or 8/9 or 8/9/2026
    text = text.replace(/\s(\d{4}-\d{2}-\d{2})\b/, (m, iso) => { out.due = iso; return ' '; });
    if (!out.due) {
      text = text.replace(/\s(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m, d, mo, y) => {
        const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : new Date().getFullYear();
        const date = new Date(year, Number(mo) - 1, Number(d));
        if (!Number.isNaN(date.getTime())) { out.due = DT.key(date); return ' '; }
        return m;
      });
    }

    // relative days
    if (!out.due) {
      if (/\stoday\b/i.test(text)) { out.due = DT.todayKey(); text = text.replace(/\stoday\b/i, ' '); }
      else if (/\stomorrow\b/i.test(text)) { out.due = DT.key(DT.addDays(new Date(), 1)); text = text.replace(/\stomorrow\b/i, ' '); }
      else {
        const inDays = text.match(/\sin (\d{1,3}) (day|days|week|weeks)\b/i);
        if (inDays) {
          const n = Number(inDays[1]) * (/week/i.test(inDays[2]) ? 7 : 1);
          out.due = DT.key(DT.addDays(new Date(), n));
          text = text.replace(inDays[0], ' ');
        } else {
          const weekday = text.match(/\s(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i);
          if (weekday) {
            const names = DT.DAY_NAMES.map(d => d.toLowerCase());
            const token = weekday[2].toLowerCase();
            let target = names.findIndex(n => n.startsWith(token.slice(0, 3)));
            if (target >= 0) {
              const today = new Date();
              let delta = (target - today.getDay() + 7) % 7;
              if (delta === 0) delta = 7;
              if (weekday[1]) delta += 7 - (delta > 7 ? 7 : 0);
              out.due = DT.key(DT.addDays(today, delta));
              text = text.replace(weekday[0], ' ');
            }
          }
        }
      }
    }

    // time: "at 5pm", "@17:00", "5:30pm"
    const time = text.match(/\s(?:at\s+|@)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
      || text.match(/\s(?:at\s+|@)(\d{1,2}):(\d{2})\b/);
    if (time) {
      let hour = Number(time[1]);
      const minute = Number(time[2] || 0);
      const suffix = (time[3] || '').toLowerCase();
      if (suffix === 'pm' && hour < 12) hour += 12;
      if (suffix === 'am' && hour === 12) hour = 0;
      if (hour <= 23 && minute <= 59) {
        out.dueTime = `${DT.pad(hour)}:${DT.pad(minute)}`;
        text = text.replace(time[0], ' ');
        if (!out.due) out.due = DT.todayKey();
      }
    }

    out.title = text.replace(/\s+/g, ' ').trim();
    return out;
  }

  // ------------------------------------------------------------- selection

  function sortTasks(list) {
    const copy = [...list];
    if (sort === 'priority') {
      copy.sort((a, b) => State.priorityOf(b.priority).rank - State.priorityOf(a.priority).rank
        || (a.due || '9999').localeCompare(b.due || '9999'));
    } else if (sort === 'due') {
      copy.sort((a, b) => (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99')
        || (a.dueTime || '99:99').localeCompare(b.dueTime || '99:99'));
    } else if (sort === 'created') {
      copy.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      copy.sort((a, b) => a.order - b.order);
    }
    return copy;
  }

  function visibleTasks() {
    const today = DT.todayKey();
    const all = State.Todos.all();
    let list;
    switch (filter) {
      case 'today':
        list = all.filter(t => !t.done && (!t.due || t.due <= today));
        break;
      case 'upcoming':
        list = all.filter(t => !t.done && t.due && t.due > today);
        break;
      case 'done':
        list = all.filter(t => t.done).sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
        return list.slice(0, 60);
      default:
        list = all.filter(t => !t.done);
    }
    return sortTasks(list);
  }

  // --------------------------------------------------------------- editor

  function openEditor(task) {
    const isNew = !task || !task.id;
    const draft = Object.assign({
      title: '', notes: '', priority: 'medium', category: 'general',
      due: null, dueTime: '', remind: false, recurrence: 'none'
    }, task || {});

    const body = el('div');
    const title = el('input', { type: 'text', value: draft.title, placeholder: 'What needs doing?', maxlength: '200' });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Task' }), title]));

    const due = el('input', { type: 'date', value: draft.due || '' });
    const dueTime = el('input', { type: 'time', value: draft.dueTime || '' });
    body.appendChild(el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Due date' }), due]),
      el('div', { class: 'field' }, [el('label', { text: 'Time' }), dueTime])
    ]));

    let priority = draft.priority;
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { text: 'Priority' }),
      pick(State.PRIORITIES.map(p => ({ id: p.id, label: p.label, color: `var(--prio-${p.id})` })),
        priority, v => { priority = v; })
    ]));

    let category = draft.category;
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { text: 'Category' }),
      pick(State.CATEGORIES.map(c => ({ id: c.id, label: c.label, color: c.color })),
        category, v => { category = v; })
    ]));

    const recurrence = el('select');
    for (const rec of State.RECURRENCES) {
      recurrence.appendChild(el('option', { value: rec.id, text: rec.label, selected: rec.id === draft.recurrence }));
    }
    const remind = el('select');
    for (const opt of EventUI.REMIND_OPTIONS) {
      remind.appendChild(el('option', {
        value: opt.value, text: opt.label,
        selected: String(draft.remind === false || draft.remind === null ? '' : draft.remind) === opt.value
      }));
    }
    body.appendChild(el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Repeat' }), recurrence]),
      el('div', { class: 'field' }, [el('label', { text: 'Reminder' }), remind])
    ]));

    const notes = el('textarea', { rows: '2', placeholder: 'Notes', style: { resize: 'vertical', minHeight: '52px' } });
    notes.value = draft.notes || '';
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Notes' }), notes]));

    function collect() {
      return Object.assign({}, draft, {
        title: title.value.trim(),
        due: due.value || null,
        dueTime: dueTime.value || '',
        priority, category,
        recurrence: recurrence.value,
        remind: remind.value === '' ? false : Number(remind.value),
        notes: notes.value
      });
    }

    const actions = [];
    if (!isNew) {
      actions.push({
        label: 'Delete', danger: true, onClick: async close => {
          const ok = await UI.confirm('Delete task', `"${draft.title}" will be removed.`, 'Delete');
          if (!ok) return;
          State.Todos.remove(draft.id);
          close(true);
        }
      });
    }
    actions.push({ spacer: true });
    actions.push({ label: 'Cancel', onClick: close => close(true) });
    actions.push({
      label: isNew ? 'Add task' : 'Save', primary: true, onClick: close => {
        const record = collect();
        if (!record.title) { UI.toast({ kind: 'error', title: 'A task needs a title' }); return; }
        if (record.remind !== false && !record.due) {
          UI.toast({ kind: 'error', title: 'Set a due date to use a reminder' });
          return;
        }
        State.Todos.save(record);
        close(true);
      }
    });

    const handle = UI.modal({ title: isNew ? 'New task' : 'Edit task', body, actions });
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const record = collect();
        if (record.title) { State.Todos.save(record); handle.close(true); }
      }
    });
    return handle;
  }

  function pick(options, value, onPick) {
    const wrap = el('div', { class: 'pick' });
    for (const opt of options) {
      const btn = el('button', {
        type: 'button',
        class: opt.id === value ? 'active' : '',
        onClick: () => {
          Array.from(wrap.children).forEach(c => c.classList.toggle('active', c.dataset.id === opt.id));
          onPick(opt.id);
        }
      });
      btn.dataset.id = opt.id;
      if (opt.color) btn.appendChild(el('i', { style: { background: opt.color } }));
      btn.appendChild(document.createTextNode(opt.label));
      wrap.appendChild(btn);
    }
    return wrap;
  }

  // ------------------------------------------------------------- rendering

  function dueBadge(todo) {
    if (!todo.due) return '';
    const today = DT.todayKey();
    const delta = DT.diffDays(today, todo.due);
    const time = todo.dueTime ? ` ${DT.formatTime(todo.dueTime, State.settings().timeFormat)}` : '';
    const cls = !todo.done && delta < 0 ? 'late' : (!todo.done && delta <= 1 ? 'soon' : '');
    const label = delta < 0 && !todo.done
      ? `${DT.relativeDay(todo.due)}${time} · overdue`
      : `${DT.relativeDay(todo.due)}${time}`;
    return `<span class="tag due ${cls}">${Icons.icon('clock', 10)}${esc(label)}</span>`;
  }

  function taskRow(todo, opts) {
    const options = opts || {};
    const cat = State.categoryOf(todo.category);
    const overdue = !todo.done && todo.due && todo.due < DT.todayKey();
    const row = el('div', {
      class: `row${todo.done ? ' done' : ''}${overdue ? ' overdue' : ''}`
    });
    row.dataset.id = todo.id;

    row.innerHTML = `
      ${options.draggable ? `<span class="drag-handle" title="Drag to reorder">${Icons.icon('grip', 12)}</span>` : ''}
      <span class="prio-flag prio-${esc(todo.priority)}" title="${esc(State.priorityOf(todo.priority).label)} priority"></span>
      <span class="check" role="checkbox" tabindex="0" aria-checked="${todo.done}"></span>
      <div class="row-main">
        <div class="row-title">${esc(todo.title)}</div>
        <div class="row-meta">
          <span class="tag"><span class="dot" style="background:${cat.color}"></span>${esc(cat.label)}</span>
          ${options.showDue === false ? '' : dueBadge(todo)}
          ${todo.recurrence && todo.recurrence !== 'none' ? `<span class="tag" title="Repeats ${esc(todo.recurrence)}">${Icons.icon('repeat', 10)}</span>` : ''}
          ${todo.remind !== false && todo.remind !== null && todo.remind !== undefined ? `<span class="tag" title="Reminder set">${Icons.icon('bell', 10)}</span>` : ''}
          ${todo.notes ? `<span class="tag" title="${esc(todo.notes.slice(0, 120))}">${Icons.icon('note', 10)}</span>` : ''}
        </div>
      </div>`;

    const check = row.querySelector('.check');
    const toggle = () => {
      const result = State.Todos.toggle(todo.id);
      if (result && result.rolled) {
        UI.toast({ kind: 'success', title: 'Nice — rolled forward', message: `Next due ${DT.relativeDay(result.next)}`, timeout: 2600 });
      } else if (result && result.done) {
        const streak = State.Stats.get().streak.current;
        UI.toast({
          kind: 'success', title: 'Task complete',
          message: streak > 1 ? `${streak}-day streak going` : todo.title,
          timeout: 1900
        });
      }
    };
    check.addEventListener('click', toggle);
    check.addEventListener('keydown', e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });

    row.appendChild(el('div', { class: 'row-actions' }, [
      el('button', {
        class: 'icon-btn sm', title: 'Edit task', html: Icons.icon('edit', 13),
        onClick: () => openEditor(State.Todos.byId(todo.id))
      }),
      el('button', {
        class: 'icon-btn sm danger', title: 'Delete task', html: Icons.icon('trash', 13),
        onClick: async () => {
          const ok = await UI.confirm('Delete task', `"${todo.title}" will be removed.`, 'Delete');
          if (ok) State.Todos.remove(todo.id);
        }
      })
    ]));

    row.addEventListener('dblclick', e => {
      if (e.target.closest('.check, .row-actions')) return;
      openEditor(State.Todos.byId(todo.id));
    });

    if (options.draggable) attachDrag(row);
    return row;
  }

  function renderRows(container, list, opts) {
    for (const todo of list) container.appendChild(taskRow(todo, opts));
  }

  // -------------------------------------------------------- drag and drop

  let dragId = null;

  function attachDrag(row) {
    const handle = row.querySelector('.drag-handle');
    if (!handle) return;
    handle.addEventListener('mousedown', () => { row.draggable = true; });
    row.addEventListener('mouseup', () => { row.draggable = false; });

    row.addEventListener('dragstart', e => {
      dragId = row.dataset.id;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (_) { /* Firefox parity */ }
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      row.draggable = false;
      dragId = null;
      UI.$$('.row.drop-target').forEach(r => r.classList.remove('drop-target'));
    });
    row.addEventListener('dragover', e => {
      if (!dragId || dragId === row.dataset.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', e => {
      e.preventDefault();
      row.classList.remove('drop-target');
      if (!dragId || dragId === row.dataset.id) return;
      // Reorder inside the full ordered list, not just what is on screen, so
      // hidden tasks keep their relative positions.
      const ordered = [...State.Todos.all()].sort((a, b) => a.order - b.order).map(t => t.id);
      const from = ordered.indexOf(dragId);
      const to = ordered.indexOf(row.dataset.id);
      if (from < 0 || to < 0) return;
      ordered.splice(to, 0, ordered.splice(from, 1)[0]);
      State.Todos.reorder(ordered);
      if (sort !== 'manual') {
        sort = 'manual';
        const select = $('#taskSort');
        if (select) select.value = 'manual';
        UI.toast({ title: 'Switched to manual order', timeout: 2000 });
      }
    });
  }

  // ------------------------------------------------------------ stats bar

  function renderStats() {
    const host = $('#taskStats');
    if (!host || !State.isActiveTab('tasks')) return;
    const today = DT.todayKey();
    const all = State.Todos.all();
    const dueToday = all.filter(t => t.due && t.due <= today);
    const completedToday = State.Stats.completionsOn(today);
    const target = Math.max(dueToday.filter(t => !t.done).length + completedToday, 1);
    const percent = Math.round((completedToday / target) * 100);
    const streak = State.Stats.get().streak;

    const circumference = 2 * Math.PI * 18;
    host.innerHTML = `
      <div class="ts-ring">
        <svg width="42" height="42" viewBox="0 0 42 42">
          <circle class="bg" cx="21" cy="21" r="18"></circle>
          <circle class="fg" cx="21" cy="21" r="18"
                  stroke-dasharray="${circumference}"
                  stroke-dashoffset="${circumference * (1 - Math.min(1, percent / 100))}"></circle>
        </svg>
        <span>${percent}%</span>
      </div>
      <div class="ts-copy">
        <b>${completedToday ? `${UI.plural(completedToday, 'task')} done today` : 'Nothing done yet today'}</b>
        <p>${UI.plural(all.filter(t => !t.done).length, 'task')} open · ${dueToday.filter(t => !t.done).length} due today</p>
      </div>
      ${streak.current > 0
        ? `<span class="streak" title="Best streak: ${streak.best} days">${Icons.icon('flame', 13)}${streak.current}</span>`
        : ''}`;
  }

  function render() {
    if (!mounted) return;
    if (!State.isActiveTab('tasks')) return;
    const list = $('#taskList');
    const tasks = visibleTasks();
    list.innerHTML = '';

    if (!tasks.length) {
      const hints = {
        today: ['All clear for today', 'Add a task above to get going.'],
        upcoming: ['Nothing scheduled ahead', 'Tasks with a future due date land here.'],
        all: ['No open tasks', 'Everything is done — enjoy it.'],
        done: ['Nothing completed yet', 'Finished tasks are archived here.']
      };
      const [t, h] = hints[filter] || hints.all;
      const empty = el('div', { class: 'empty' }, [
        el('strong', { text: t }),
        el('div', { text: h })
      ]);
      // An empty list should offer the next action, not just describe itself.
      if (filter !== 'done') {
        empty.appendChild(el('div', { style: { marginTop: '12px', display: 'flex', gap: '6px', justifyContent: 'center' } }, [
          el('button', {
            class: 'primary-btn', text: '+ Add a task',
            onClick: () => $('#taskInput').focus()
          }),
          el('button', {
            class: 'ghost-btn', text: 'How to type one',
            onClick: () => App.openHelp()
          })
        ]));
      }
      list.appendChild(empty);
    } else {
      renderRows(list, tasks, { draggable: sort === 'manual' && filter !== 'done' });
    }

    if (filter === 'done' && tasks.length) {
      list.appendChild(el('div', { style: { marginTop: '10px', textAlign: 'center' } }, [
        el('button', {
          class: 'ghost-btn danger',
          text: `Clear ${UI.plural(tasks.length, 'completed task')}`,
          onClick: async () => {
            const ok = await UI.confirm('Clear completed', 'Completed tasks will be permanently removed.', 'Clear');
            if (!ok) return;
            const removed = State.Todos.clearCompleted();
            UI.toast({ kind: 'success', title: `${UI.plural(removed, 'task')} cleared` });
          }
        })
      ]));
    }

    renderStats();
  }

  /** The Today view's short list: overdue and due-today work, highest first. */
  function renderTodayList(container) {
    const today = DT.todayKey();
    const open = State.Todos.all()
      .filter(t => !t.done && (!t.due || t.due <= today))
      .sort((a, b) => State.priorityOf(b.priority).rank - State.priorityOf(a.priority).rank
        || (a.due || '9999').localeCompare(b.due || '9999')
        || a.order - b.order)
      .slice(0, 6);

    container.innerHTML = '';
    if (!open.length) {
      container.appendChild(el('div', {
        class: 'empty',
        html: '<strong>Inbox zero</strong>No tasks are due today.'
      }));
    } else {
      renderRows(container, open, {});
    }

    const meta = $('#todayTaskMeta');
    if (meta) {
      const total = State.Todos.all().filter(t => !t.done && (!t.due || t.due <= today)).length;
      meta.textContent = total > open.length ? `${open.length} of ${total}` : `${UI.plural(total, 'task')}`;
    }
  }

  function quickAdd() {
    const input = $('#taskInput');
    const raw = input.value.trim();
    if (!raw) return;
    const parsed = parseTaskInput(raw);
    if (!parsed.title) { UI.toast({ kind: 'error', title: 'That task has no title' }); return; }

    const record = State.Todos.save({
      title: parsed.title,
      due: parsed.due,
      dueTime: parsed.dueTime,
      priority: parsed.priority,
      category: parsed.category,
      recurrence: parsed.recurrence,
      remind: parsed.dueTime ? 10 : false,
      order: Math.min(0, ...State.Todos.all().map(t => t.order)) - 1
    });

    input.value = '';
    const extras = [];
    if (parsed.due) extras.push(DT.relativeDay(parsed.due) + (parsed.dueTime ? ` ${DT.formatTime(parsed.dueTime, State.settings().timeFormat)}` : ''));
    if (parsed.priority !== 'medium') extras.push(`${parsed.priority} priority`);
    if (parsed.category !== 'general') extras.push(parsed.category);
    if (parsed.recurrence !== 'none') extras.push(parsed.recurrence);
    UI.toast({
      kind: 'success', title: 'Task added',
      message: extras.length ? extras.join(' · ') : record.title,
      timeout: 2400
    });
  }

  function init() {
    mounted = true;

    $('#taskAdd').addEventListener('click', quickAdd);
    $('#taskInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); quickAdd(); }
      if (e.key === 'Escape') e.target.value = '';
    });

    $('#taskFilters').addEventListener('click', e => {
      const chip = e.target.closest('.chip[data-filter]');
      if (!chip) return;
      filter = chip.dataset.filter;
      UI.$$('#taskFilters .chip').forEach(c => c.classList.toggle('active', c === chip));
      render();
    });

    $('#taskSort').addEventListener('change', e => { sort = e.target.value; render(); });

    State.on('todos', render);
    State.on('stats', renderStats);
    State.on('settings', render);
    State.on('tick:day', render);

    render();
  }

  global.Tasks = {
    init,
    render,
    renderRows,
    renderTodayList,
    openEditor,
    parseTaskInput,
    setFilter: value => { filter = value; render(); }
  };
}(window));
