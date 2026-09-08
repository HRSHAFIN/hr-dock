/* HR Dock — event editor and schedule timeline.
   Shared by the Today view and the Calendar view so an event looks and behaves
   the same everywhere it appears. */
(function (global) {
  'use strict';

  const { el, esc, $ } = UI;

  const REMIND_OPTIONS = [
    { value: '', label: 'No reminder' },
    { value: '0', label: 'At start time' },
    { value: '5', label: '5 minutes before' },
    { value: '10', label: '10 minutes before' },
    { value: '15', label: '15 minutes before' },
    { value: '30', label: '30 minutes before' },
    { value: '60', label: '1 hour before' },
    { value: '120', label: '2 hours before' },
    { value: '1440', label: '1 day before' }
  ];

  /** A row of pill buttons bound to a single value. */
  function pickerRow(options, value, onPick) {
    const wrap = el('div', { class: 'pick' });
    for (const opt of options) {
      const btn = el('button', {
        class: opt.id === value ? 'active' : '',
        type: 'button',
        onClick: () => {
          value = opt.id;
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

  /**
   * Open the create/edit dialog.
   * @param {object} prefill  existing event, or defaults for a new one
   * @param {string} instanceDay  the occurrence being edited, for repeat series
   */
  function openEditor(prefill, instanceDay) {
    const isNew = !prefill || !prefill.id;
    const draft = Object.assign({
      title: '',
      date: instanceDay || DT.todayKey(),
      time: '',
      endTime: '',
      category: 'general',
      priority: 'medium',
      location: '',
      notes: '',
      remind: 10,
      recurrence: 'none',
      interval: 1,
      until: null
    }, prefill || {});

    const body = el('div');

    const title = el('input', {
      type: 'text', value: draft.title, placeholder: 'Event title', maxlength: '160'
    });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Title' }), title]));

    const date = el('input', { type: 'date', value: draft.date });
    const time = el('input', { type: 'time', value: draft.time });
    const endTime = el('input', { type: 'time', value: draft.endTime });
    body.appendChild(el('div', { class: 'field-row' }, [
      el('div', { class: 'field wide' }, [el('label', { text: 'Date' }), date]),
      el('div', { class: 'field' }, [el('label', { text: 'Start' }), time]),
      el('div', { class: 'field' }, [el('label', { text: 'End' }), endTime])
    ]));

    body.appendChild(el('div', { class: 'field' }, [
      el('label', { text: 'Category' }),
      pickerRow(State.CATEGORIES.map(c => ({ id: c.id, label: c.label, color: c.color })),
        draft.category, v => { draft.category = v; })
    ]));

    body.appendChild(el('div', { class: 'field' }, [
      el('label', { text: 'Priority' }),
      pickerRow(State.PRIORITIES.map(p => ({ id: p.id, label: p.label, color: `var(--prio-${p.id})` })),
        draft.priority, v => { draft.priority = v; })
    ]));

    const location = el('input', { type: 'text', value: draft.location, placeholder: 'Optional', maxlength: '120' });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Location' }), location]));

    const remind = el('select');
    for (const opt of REMIND_OPTIONS) {
      remind.appendChild(el('option', {
        value: opt.value, text: opt.label,
        selected: String(draft.remind === null || draft.remind === false ? '' : draft.remind) === opt.value
      }));
    }

    const recurrence = el('select');
    for (const rec of State.RECURRENCES) {
      recurrence.appendChild(el('option', { value: rec.id, text: rec.label, selected: rec.id === draft.recurrence }));
    }
    body.appendChild(el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Reminder' }), remind]),
      el('div', { class: 'field' }, [el('label', { text: 'Repeat' }), recurrence])
    ]));

    const until = el('input', { type: 'date', value: draft.until || '' });
    const untilField = el('div', { class: 'field' }, [el('label', { text: 'Repeat until (optional)' }), until]);
    untilField.hidden = draft.recurrence === 'none';
    recurrence.addEventListener('change', () => { untilField.hidden = recurrence.value === 'none'; });
    body.appendChild(untilField);

    const notes = el('textarea', { rows: '2', placeholder: 'Notes', style: { resize: 'vertical', minHeight: '52px' } });
    notes.value = draft.notes;
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Notes' }), notes]));

    function collect() {
      return Object.assign({}, draft, {
        title: title.value.trim() || 'Untitled event',
        date: date.value || DT.todayKey(),
        time: time.value,
        endTime: endTime.value,
        location: location.value.trim(),
        notes: notes.value,
        remind: remind.value === '' ? null : Number(remind.value),
        recurrence: recurrence.value,
        until: recurrence.value === 'none' ? null : (until.value || null)
      });
    }

    const actions = [];
    if (!isNew) {
      actions.push({
        label: 'Delete', danger: true, onClick: async close => {
          const ok = await UI.confirm('Delete event',
            draft.recurrence !== 'none'
              ? 'This deletes every occurrence of the repeating event.'
              : 'This cannot be undone.', 'Delete');
          if (!ok) return;
          State.Events.remove(draft.id);
          close(true);
          UI.toast({ kind: 'success', title: 'Event deleted' });
        }
      });
    }
    actions.push({ spacer: true });
    actions.push({ label: 'Cancel', onClick: close => close(true) });
    actions.push({
      label: isNew ? 'Add event' : 'Save', primary: true, onClick: close => {
        const record = collect();
        if (record.endTime && record.time && record.endTime < record.time) {
          UI.toast({ kind: 'error', title: 'End time is before the start time' });
          return;
        }
        State.Events.save(record);
        close(true);
        UI.toast({ kind: 'success', title: isNew ? 'Event added' : 'Event updated', message: record.title });
      }
    });

    const handle = UI.modal({ title: isNew ? 'New event' : 'Edit event', body, actions });
    title.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        State.Events.save(collect());
        handle.close(true);
      }
    });
    return handle;
  }

  // ------------------------------------------------------------- timeline

  function eventMeta(instance) {
    const bits = [];
    const cat = State.categoryOf(instance.category);
    bits.push(`<span class="tag"><span class="dot" style="background:${cat.color}"></span>${esc(cat.label)}</span>`);
    if (instance.location) bits.push(`<span class="tag">${Icons.icon('mapPin', 10)}${esc(instance.location)}</span>`);
    if (instance.recurrence && instance.recurrence !== 'none') bits.push(`<span class="tag">${Icons.icon('repeat', 10)}</span>`);
    if (instance.remind !== null && instance.remind !== false && instance.remind !== undefined) {
      bits.push(`<span class="tag">${Icons.icon('bell', 10)}</span>`);
    }
    return bits.join('');
  }

  /**
   * Render one day's events as a timeline, with a "now" marker slotted into
   * the correct position when the day being shown is today.
   */
  function renderTimeline(container, dayKey, opts) {
    const options = opts || {};
    const instances = State.Events.onDay(dayKey);
    container.innerHTML = '';

    if (!instances.length) {
      container.appendChild(el('div', {
        class: 'empty',
        html: `<strong>Nothing scheduled</strong>${options.emptyHint || 'Enjoy the clear run.'}`
      }));
      return;
    }

    const settings = State.settings();
    const isToday = dayKey === DT.todayKey();
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    let nowPlaced = false;

    for (const instance of instances) {
      const start = DT.toMinutes(instance.time);

      if (isToday && !nowPlaced && start !== null && start > nowMinutes) {
        container.appendChild(el('div', { class: 'now-line' }));
        nowPlaced = true;
      }

      const past = isToday && start !== null && start < nowMinutes;
      const live = isToday && start !== null && start <= nowMinutes
        && DT.toMinutes(instance.endTime) !== null && DT.toMinutes(instance.endTime) > nowMinutes;

      const cat = State.categoryOf(instance.category);
      const row = el('div', {
        class: `tl-item${past && !live ? ' past' : ''}${live ? ' now' : ''}${instance.done ? ' done' : ''}`,
        style: { '--cat': cat.color }
      });

      row.innerHTML = `
        <div class="tl-rail">
          <div class="tl-time">${instance.time ? esc(DT.formatTime(instance.time, settings.timeFormat)) : 'All day'}</div>
          ${instance.endTime ? `<span class="tl-end">${esc(DT.formatTime(instance.endTime, settings.timeFormat))}</span>` : ''}
        </div>
        <div class="tl-body">
          <div class="tl-title">${esc(instance.title)}</div>
          <div class="tl-meta">${eventMeta(instance)}</div>
        </div>`;

      const actions = el('div', { class: 'tl-actions' }, [
        el('button', {
          class: 'icon-btn sm',
          title: instance.done ? 'Mark as not done' : 'Mark as done',
          html: Icons.icon('check', 13),
          onClick: e => {
            e.stopPropagation();
            const done = State.Events.toggleDone(instance.id, dayKey);
            if (done) UI.toast({ kind: 'success', title: 'Marked complete', message: instance.title, timeout: 1800 });
          }
        }),
        el('button', {
          class: 'icon-btn sm',
          title: 'Edit event',
          html: Icons.icon('edit', 13),
          onClick: e => { e.stopPropagation(); openEditor(State.Events.byId(instance.id), dayKey); }
        }),
        el('button', {
          class: 'icon-btn sm danger',
          title: instance.recurrence !== 'none' ? 'Skip this occurrence' : 'Delete event',
          html: Icons.icon('trash', 13),
          onClick: async e => {
            e.stopPropagation();
            if (instance.recurrence && instance.recurrence !== 'none') {
              State.Events.skipDay(instance.id, dayKey);
              UI.toast({ title: 'Occurrence skipped', message: instance.title, timeout: 2200 });
              return;
            }
            const ok = await UI.confirm('Delete event', `"${instance.title}" will be removed.`, 'Delete');
            if (ok) State.Events.remove(instance.id);
          }
        })
      ]);
      row.appendChild(actions);
      row.addEventListener('dblclick', () => openEditor(State.Events.byId(instance.id), dayKey));
      container.appendChild(row);
    }

    if (isToday && !nowPlaced) container.appendChild(el('div', { class: 'now-line' }));
  }

  /** Compact list used for "upcoming" and the calendar's day panel. */
  function renderInstanceList(container, instances, options) {
    const opts = options || {};
    container.innerHTML = '';
    if (!instances.length) {
      container.appendChild(el('div', {
        class: 'empty',
        html: `<strong>${esc(opts.emptyTitle || 'Nothing here')}</strong>${esc(opts.emptyHint || '')}`
      }));
      return;
    }
    const settings = State.settings();
    for (const instance of instances) {
      const cat = State.categoryOf(instance.category);
      const row = el('div', { class: `row${instance.done ? ' done' : ''}` });
      row.innerHTML = `
        <span class="prio-flag prio-${esc(instance.priority || 'medium')}"></span>
        <div class="row-main">
          <div class="row-title">${esc(instance.title)}</div>
          <div class="row-meta">
            <span class="tag"><span class="dot" style="background:${cat.color}"></span>${esc(cat.label)}</span>
            ${opts.showDay ? `<span class="tag">${Icons.icon('calendar', 10)}${esc(DT.relativeDay(instance.day))}</span>` : ''}
            ${instance.time ? `<span class="tag">${Icons.icon('clock', 10)}${esc(DT.formatTime(instance.time, settings.timeFormat))}</span>` : '<span class="tag">All day</span>'}
            ${instance.location ? `<span class="tag">${Icons.icon('mapPin', 10)}${esc(instance.location)}</span>` : ''}
          </div>
        </div>`;
      row.appendChild(el('div', { class: 'row-actions' }, [
        el('button', {
          class: 'icon-btn sm', title: 'Edit', html: Icons.icon('edit', 13),
          onClick: () => openEditor(State.Events.byId(instance.id), instance.day)
        })
      ]));
      container.appendChild(row);
    }
  }

  global.EventUI = { openEditor, renderTimeline, renderInstanceList, REMIND_OPTIONS };
}(window));
