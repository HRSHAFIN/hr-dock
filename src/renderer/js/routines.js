/* HR Dock — routines.
   A routine is a named list of timed steps that repeats on chosen weekdays.
   Each step raises its own reminder, and steps tick off per day so today's
   progress is independent of yesterday's. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let mounted = false;

  const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  /** Weekday order follows the user's "week starts on" preference. */
  function weekOrder() {
    const first = Number(State.settings().firstDayOfWeek) || 0;
    return [0, 1, 2, 3, 4, 5, 6].map(i => (first + i) % 7);
  }

  function daysLabel(days) {
    if (days.length === 7) return 'Every day';
    const weekdays = [1, 2, 3, 4, 5];
    if (days.length === 5 && weekdays.every(d => days.includes(d))) return 'Weekdays';
    if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends';
    return weekOrder().filter(d => days.includes(d))
      .map(d => DT.DAY_NAMES[d].slice(0, 3)).join(', ');
  }

  // ---------------------------------------------------------------- editor

  const PRESETS = [
    {
      name: 'Morning routine',
      category: 'personal',
      days: [1, 2, 3, 4, 5],
      steps: [
        { title: 'Wake up', time: '07:00' },
        { title: 'Stretch and hydrate', time: '07:10' },
        { title: 'Breakfast', time: '07:30' },
        { title: 'Plan the day', time: '08:00' }
      ]
    },
    {
      name: 'Deep work block',
      category: 'work',
      days: [1, 2, 3, 4, 5],
      steps: [
        { title: 'Clear inbox', time: '09:00' },
        { title: 'Focus block one', time: '09:30' },
        { title: 'Break', time: '11:00' },
        { title: 'Focus block two', time: '11:15' }
      ]
    },
    {
      name: 'Evening wind-down',
      category: 'health',
      days: [0, 1, 2, 3, 4, 5, 6],
      steps: [
        { title: 'Shut down work', time: '18:00' },
        { title: 'Exercise', time: '18:30' },
        { title: 'Screens off', time: '22:00' },
        { title: 'Read', time: '22:15' }
      ]
    }
  ];

  function openEditor(routine) {
    const isNew = !routine || !routine.id;
    const draft = {
      id: routine && routine.id,
      name: (routine && routine.name) || '',
      category: (routine && routine.category) || 'personal',
      days: [...((routine && routine.days) || [1, 2, 3, 4, 5])],
      steps: ((routine && routine.steps) || []).map(s => ({ ...s })),
      remind: routine && routine.remind !== undefined ? routine.remind : 0,
      active: routine ? routine.active : true,
      completed: (routine && routine.completed) || {}
    };
    if (!draft.steps.length) draft.steps.push({ title: '', time: '' });

    const body = el('div');

    const name = el('input', {
      type: 'text', value: draft.name, placeholder: 'e.g. Morning routine', maxlength: '80'
    });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Routine name' }), name]));

    // weekday picker
    const dayRow = el('div', { class: 'day-picker' });
    for (const day of weekOrder()) {
      const btn = el('button', {
        type: 'button',
        class: draft.days.includes(day) ? 'active' : '',
        text: DAY_LETTERS[day],
        title: DT.DAY_NAMES[day],
        onClick: e => {
          const i = draft.days.indexOf(day);
          if (i >= 0) draft.days.splice(i, 1); else draft.days.push(day);
          e.currentTarget.classList.toggle('active', draft.days.includes(day));
        }
      });
      dayRow.appendChild(btn);
    }
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Runs on' }), dayRow]));

    // steps editor
    const stepsHost = el('div', { class: 'step-editor' });
    function drawSteps() {
      stepsHost.innerHTML = '';
      draft.steps.forEach((step, index) => {
        const time = el('input', { type: 'time', value: step.time || '' });
        time.addEventListener('change', () => { step.time = time.value; });
        const title = el('input', {
          type: 'text', value: step.title || '', placeholder: 'Step ' + (index + 1), maxlength: '90'
        });
        title.addEventListener('input', () => { step.title = title.value; });

        const remove = el('button', {
          class: 'icon-btn sm danger', title: 'Remove step', html: Icons.icon('trash', 12),
          onClick: () => {
            draft.steps.splice(index, 1);
            if (!draft.steps.length) draft.steps.push({ title: '', time: '' });
            drawSteps();
          }
        });
        stepsHost.appendChild(el('div', { class: 'step-row' }, [time, title, remove]));
      });

      stepsHost.appendChild(el('button', {
        class: 'ghost-btn',
        text: '+ Add step',
        onClick: () => { draft.steps.push({ title: '', time: '' }); drawSteps(); }
      }));
    }
    drawSteps();
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Steps' }), stepsHost]));

    const remind = el('select');
    for (const opt of EventUI.REMIND_OPTIONS) {
      remind.appendChild(el('option', {
        value: opt.value, text: opt.label,
        selected: String(draft.remind === false || draft.remind === null ? '' : draft.remind) === opt.value
      }));
    }
    let category = draft.category;
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { text: 'Remind me' }), remind
    ]));
    body.appendChild(el('div', { class: 'field' }, [
      el('label', { text: 'Colour' }),
      (() => {
        const wrap = el('div', { class: 'pick' });
        for (const cat of State.CATEGORIES) {
          const btn = el('button', {
            type: 'button', class: cat.id === category ? 'active' : '',
            onClick: e => {
              category = cat.id;
              Array.from(wrap.children).forEach(c => c.classList.toggle('active', c === e.currentTarget));
            }
          });
          btn.appendChild(el('i', { style: { background: cat.color } }));
          btn.appendChild(document.createTextNode(cat.label));
          wrap.appendChild(btn);
        }
        return wrap;
      })()
    ]));

    const actions = [];
    if (!isNew) {
      actions.push({
        label: 'Delete', danger: true, onClick: async close => {
          const okToDelete = await UI.confirm('Delete routine',
            `"${draft.name}" and its reminders will be removed.`, 'Delete');
          if (!okToDelete) return;
          State.Routines.remove(draft.id);
          close(true);
        }
      });
    }
    actions.push({ spacer: true });
    actions.push({ label: 'Cancel', onClick: close => close(true) });
    actions.push({
      label: isNew ? 'Create routine' : 'Save', primary: true, onClick: close => {
        const steps = draft.steps.filter(s => (s.title || '').trim());
        if (!name.value.trim()) { UI.toast({ kind: 'error', title: 'Give the routine a name' }); return; }
        if (!steps.length) { UI.toast({ kind: 'error', title: 'Add at least one step' }); return; }
        if (!draft.days.length) { UI.toast({ kind: 'error', title: 'Pick at least one day' }); return; }
        const missingTime = steps.find(s => !s.time);
        if (missingTime) {
          UI.toast({ kind: 'error', title: 'Every step needs a time', message: missingTime.title });
          return;
        }
        State.Routines.save({
          ...draft, name: name.value, category, steps,
          remind: remind.value === '' ? false : Number(remind.value)
        });
        close(true);
        UI.toast({ kind: 'success', title: isNew ? 'Routine created' : 'Routine updated' });
      }
    });

    UI.modal({ title: isNew ? 'New routine' : 'Edit routine', body, actions });
  }

  /** Offer ready-made routines so the first one is a click, not a form. */
  function openPresets() {
    const body = el('div');
    body.appendChild(el('p', {
      class: 'muted-note',
      text: 'Start from a template — you can rename, retime or delete any step afterwards.'
    }));
    for (const preset of PRESETS) {
      body.appendChild(el('button', {
        class: 'preset-card',
        onClick: () => {
          const created = State.Routines.save(preset);
          UI.toast({ kind: 'success', title: preset.name + ' added', message: 'Adjust the times to suit you.' });
          setTimeout(() => openEditor(State.Routines.byId(created.id)), 250);
        }
      }, [
        el('b', { text: preset.name }),
        el('span', { text: preset.steps.map(s => s.time + ' ' + s.title).join(' · ') })
      ]));
    }
    UI.modal({
      title: 'Routine templates',
      body,
      actions: [
        { spacer: true },
        { label: 'Start from scratch', onClick: close => { close(true); openEditor(null); } }
      ]
    });
  }

  // -------------------------------------------------------------- rendering

  function routineCard(routine) {
    const today = DT.todayKey();
    const runsToday = State.Routines.runsOn(routine, today);
    const done = (routine.completed[today] || []).length;
    const card = el('div', { class: `routine${routine.active ? '' : ' inactive'}` });
    const cat = State.categoryOf(routine.category);

    card.innerHTML = `
      <div class="routine-head">
        <span class="routine-dot" style="background:${cat.color}"></span>
        <b>${esc(routine.name)}</b>
        <span class="routine-meta">${esc(daysLabel(routine.days))} · ${UI.plural(routine.steps.length, 'step')}</span>
      </div>
      <div class="routine-steps">
        ${routine.steps.map(s => `
          <span class="routine-step${(routine.completed[today] || []).includes(s.id) ? ' done' : ''}">
            <i>${esc(DT.formatTime(s.time, State.settings().timeFormat))}</i>${esc(s.title)}
          </span>`).join('')}
      </div>`;

    const foot = el('div', { class: 'routine-foot' }, [
      el('span', {
        class: 'routine-progress',
        text: runsToday
          ? `${done}/${routine.steps.length} done today`
          : 'Not scheduled today'
      }),
      el('button', {
        class: 'switch', role: 'switch', 'aria-checked': String(!!routine.active),
        title: routine.active ? 'Pause this routine' : 'Resume this routine',
        onClick: () => State.Routines.setActive(routine.id, !routine.active)
      }),
      el('button', {
        class: 'icon-btn sm', title: 'Edit routine', html: Icons.icon('edit', 13),
        onClick: () => openEditor(routine)
      })
    ]);
    card.appendChild(foot);
    card.addEventListener('dblclick', () => openEditor(routine));
    return card;
  }

  function render() {
    if (!mounted) return;
    if (!State.isActiveTab('routines')) return;

    const host = $('#routineList');
    const routines = State.Routines.all();
    host.innerHTML = '';

    if (!routines.length) {
      host.appendChild(el('div', { class: 'empty' }, [
        el('strong', { text: 'No routines yet' }),
        el('div', { text: 'A routine is a set of timed steps that repeats — a morning ritual, a gym split, a shutdown checklist. Each step reminds you when its time comes.' }),
        el('div', { style: { marginTop: '12px', display: 'flex', gap: '6px', justifyContent: 'center' } }, [
          el('button', { class: 'primary-btn', text: 'Use a template', onClick: openPresets }),
          el('button', { class: 'ghost-btn', text: 'Start from scratch', onClick: () => openEditor(null) })
        ])
      ]));
      renderToday();
      return;
    }

    for (const routine of routines) host.appendChild(routineCard(routine));
    renderToday();
  }

  /** Today's steps across every active routine, as a tickable checklist. */
  function renderToday(container) {
    const host = container || $('#routineToday');
    if (!host) return;
    const today = DT.todayKey();
    const steps = State.Routines.stepsFor(today);

    if (!steps.length) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;

    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const progress = State.Routines.progress(today);

    host.innerHTML = `
      <div class="card-head">
        <h3>${Icons.icon('routine', 13)} Today's routine</h3>
        <span class="pill">${progress.done}/${progress.total}</span>
      </div>
      <div class="mini-bar" style="margin-bottom:10px">
        <span style="width:${progress.percent}%"></span>
      </div>`;

    const list = el('div', { class: 'routine-check-list' });
    for (const step of steps) {
      const mins = DT.toMinutes(step.time);
      const isNext = !step.done && mins !== null && mins >= nowMinutes;
      const overdue = !step.done && mins !== null && mins < nowMinutes;
      const row = el('div', {
        class: `routine-check${step.done ? ' done' : ''}${overdue ? ' late' : ''}${isNext ? ' next' : ''}`
      });
      row.innerHTML = `
        <span class="check" role="checkbox" tabindex="0" aria-checked="${step.done}"></span>
        <span class="rc-time">${esc(DT.formatTime(step.time, State.settings().timeFormat))}</span>
        <span class="rc-title">${esc(step.title)}</span>
        <span class="rc-routine">${esc(step.routineName)}</span>`;

      const toggle = () => {
        const nowDone = State.Routines.toggleStep(step.routineId, step.id, today);
        if (nowDone) {
          const after = State.Routines.progress(today);
          if (after.done === after.total) {
            UI.toast({ kind: 'success', title: 'Routine complete for today', icon: 'flame' });
          }
        }
      };
      row.querySelector('.check').addEventListener('click', toggle);
      row.querySelector('.check').addEventListener('keydown', e => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
      });
      list.appendChild(row);
    }
    host.appendChild(list);
  }

  function init() {
    mounted = true;

    $('#routineAdd').addEventListener('click', () => openEditor(null));
    $('#routineTemplates').addEventListener('click', openPresets);

    State.on('routines', () => { render(); if (State.isActiveTab('today')) renderToday(); });
    State.on('settings', render);
    State.on('tick:day', () => { render(); renderToday(); });
    State.on('tick:minute', () => { if (State.isActiveTab('today')) renderToday(); });

    render();
  }

  global.Routines = { init, render, renderToday, openEditor, openPresets };
}(window));
