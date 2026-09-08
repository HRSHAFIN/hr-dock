/* HR Dock — routines: the centre of the app.
   A routine is a named set of timed steps that repeats on chosen weekdays.
   The point is not to collect routines, it is to follow them, so this module
   leads with execution: what is due now, how today is going, and how the last
   week actually went — with the week laid out as a timetable you can read at a
   glance and tick off from. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let mounted = false;
  let mode = 'week';                 // week | today | manage
  const HOUR_PX = 46;                // vertical scale of the timetable
  const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  /** Weekday order follows the user's "week starts on" preference. */
  function weekOrder() {
    const first = Number(State.settings().firstDayOfWeek) || 0;
    return [0, 1, 2, 3, 4, 5, 6].map(i => (first + i) % 7);
  }

  function weekDays() {
    const start = DT.startOfWeek(new Date(), Number(State.settings().firstDayOfWeek) || 0);
    return [0, 1, 2, 3, 4, 5, 6].map(i => DT.addDays(start, i));
  }

  function daysLabel(days) {
    if (days.length === 7) return 'Every day';
    const weekdays = [1, 2, 3, 4, 5];
    if (days.length === 5 && weekdays.every(d => days.includes(d))) return 'Weekdays';
    if (days.length === 2 && days.includes(0) && days.includes(6)) return 'Weekends';
    return weekOrder().filter(d => days.includes(d))
      .map(d => DT.DAY_NAMES[d].slice(0, 3)).join(', ');
  }

  const fmt = mins => DT.formatTime(DT.fromMinutes(mins), State.settings().timeFormat);

  // ------------------------------------------------------------- momentum

  /**
   * One honest sentence about where today stands.
   * Encouragement only counts if it is true, so every line is derived from the
   * actual step counts rather than picked from a bag of platitudes.
   */
  function momentumLine(progress, next, overdue, streak) {
    if (!progress.total) {
      return State.Routines.all().length
        ? 'Nothing scheduled today — rest is part of the plan.'
        : 'No routines yet. Build the first one and the day starts planning itself.';
    }
    if (progress.done === progress.total) {
      return streak > 1
        ? `Every step done — ${streak} days in a row.`
        : 'Every step done today. That is the whole job.';
    }
    if (overdue.length) {
      const first = overdue[0];
      return overdue.length === 1
        ? `${first.title} was due at ${DT.formatTime(first.time, State.settings().timeFormat)}. Still worth doing.`
        : `${overdue.length} steps slipped past. Start with ${first.title}.`;
    }
    if (next) {
      const away = next.minutesAway;
      const when = away <= 0 ? 'now'
        : away < 60 ? `in ${away} min`
          : `at ${DT.formatTime(next.time, State.settings().timeFormat)}`;
      return progress.done
        ? `${progress.done} of ${progress.total} done. ${next.title} ${when}.`
        : `${progress.total} steps today. First up: ${next.title} ${when}.`;
    }
    return `${progress.done} of ${progress.total} done today.`;
  }

  function renderMomentum() {
    const host = $('#routineMomentum');
    if (!host) return;

    const today = DT.todayKey();
    const progress = State.Routines.progress(today);
    const next = State.Routines.nextStep(today);
    const overdue = State.Routines.overdue(today);
    const week = State.Routines.adherence(7);
    const best = State.Routines.all()
      .reduce((max, r) => Math.max(max, State.Routines.streak(r)), 0);

    const circumference = 2 * Math.PI * 22;
    const percent = Math.round(progress.percent);

    host.innerHTML = `
      <div class="mo-ring" title="${progress.done} of ${progress.total} steps done today">
        <svg width="54" height="54" viewBox="0 0 54 54">
          <circle class="bg" cx="27" cy="27" r="22"></circle>
          <circle class="fg" cx="27" cy="27" r="22"
                  stroke-dasharray="${circumference}"
                  stroke-dashoffset="${circumference * (1 - Math.min(1, progress.percent / 100))}"></circle>
        </svg>
        <span>${progress.total ? percent + '%' : '—'}</span>
      </div>
      <div class="mo-copy">
        <b>${progress.total ? `${progress.done} of ${progress.total} steps today` : 'Nothing scheduled today'}</b>
        <p>${esc(momentumLine(progress, next, overdue, best))}</p>
      </div>
      <div class="mo-stats">
        <span class="mo-stat${best > 0 ? ' hot' : ''}" title="Longest run of fully finished days">
          ${Icons.icon('flame', 13)}${best}<small>day streak</small>
        </span>
        <span class="mo-stat" title="Steps completed over the last 7 scheduled days">
          ${week.percent === null ? '—' : week.percent + '%'}<small>this week</small>
        </span>
      </div>`;
  }

  // ------------------------------------------------------------- timetable

  /** The hour window the timetable needs to show, rounded to whole hours. */
  function timeRange() {
    let min = 24 * 60;
    let max = 0;
    let found = false;
    for (const routine of State.Routines.all()) {
      if (!routine.active) continue;
      for (const step of routine.steps) {
        const start = DT.toMinutes(step.time);
        if (start === null) continue;
        found = true;
        min = Math.min(min, start);
        max = Math.max(max, start + (step.duration || 30));
      }
    }
    if (!found) return { start: 7 * 60, end: 22 * 60 };
    let start = Math.floor(min / 60) * 60;
    let end = Math.ceil(max / 60) * 60;

    // Pull the current hour into view when it is near the scheduled window, so
    // the "now" line is visible during the hours the routines actually cover.
    // Far outside it (the small hours), stretching the grid would just add
    // empty space, so the window stays tight.
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    if (now >= start - 90 && now <= end + 90) {
      start = Math.min(start, Math.floor(now / 60) * 60);
      end = Math.max(end, Math.ceil(now / 60) * 60);
    }

    // Always show a readable window, even for a single early step.
    if (end - start < 6 * 60) end = Math.min(24 * 60, start + 6 * 60);
    return { start, end: Math.max(end, start + 60) };
  }

  /** Lay overlapping blocks side by side instead of stacking them. */
  function packColumns(steps) {
    const sorted = [...steps].sort((a, b) => a.startMinutes - b.startMinutes);
    const lanes = [];
    for (const step of sorted) {
      let lane = lanes.findIndex(end => end <= step.startMinutes);
      if (lane === -1) { lanes.push(step.endMinutes); lane = lanes.length - 1; }
      else lanes[lane] = step.endMinutes;
      step._lane = lane;
    }
    const total = Math.max(1, lanes.length);
    for (const step of sorted) step._lanes = total;
    return sorted;
  }

  function renderWeek() {
    const host = $('#routineWeek');
    if (!host) return;

    const routines = State.Routines.all();
    if (!routines.length) { host.innerHTML = ''; renderEmpty(host); return; }

    const range = timeRange();
    const span = range.end - range.start;
    const bodyHeight = (span / 60) * HOUR_PX;
    const days = weekDays();
    const today = DT.todayKey();
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

    // Header row of weekday names.
    const head = days.map(date => {
      const key = DT.key(date);
      const isToday = key === today;
      return `<div class="tt-dayhead${isToday ? ' today' : ''}">
        <b>${esc(DT.DAY_NAMES[date.getDay()].slice(0, 3))}</b>
        <span>${date.getDate()}</span>
      </div>`;
    }).join('');

    // Hour labels down the gutter.
    const hours = [];
    for (let m = range.start; m <= range.end; m += 60) {
      hours.push(`<span class="tt-hour" style="top:${((m - range.start) / span) * 100}%">${esc(fmt(m))}</span>`);
    }

    const columns = days.map(date => {
      const key = DT.key(date);
      const isToday = key === today;
      const steps = packColumns(State.Routines.stepsFor(key).filter(s => s.startMinutes !== null));

      const blocks = steps.map(step => {
        const top = ((step.startMinutes - range.start) / span) * 100;
        const height = Math.max(2.5, ((step.endMinutes - step.startMinutes) / span) * 100);
        const width = 100 / step._lanes;
        const left = width * step._lane;
        const cat = State.categoryOf(step.category);
        const late = isToday && !step.done && step.endMinutes < nowMinutes;
        const live = isToday && !step.done
          && step.startMinutes <= nowMinutes && step.endMinutes > nowMinutes;
        // A 15-minute block is ~11px tall: it can show a title or a time,
        // not both, so short blocks drop the time and keep the words.
        const heightPx = ((step.endMinutes - step.startMinutes) / 60) * HOUR_PX;
        const classes = ['tt-block'];
        if (heightPx < 26) classes.push('tiny');
        if (step.done) classes.push('done');
        if (late) classes.push('late');
        if (live) classes.push('live');
        if (!isToday && key < today) classes.push('past');

        return `<button class="${classes.join(' ')}"
            style="top:${top}%;height:${height}%;left:${left}%;width:calc(${width}% - 2px);--cat:${cat.color}"
            data-routine="${esc(step.routineId)}" data-step="${esc(step.id)}" data-day="${esc(key)}"
            title="${esc(step.title)} — ${esc(step.routineName)}\n${esc(DT.formatTime(step.time, State.settings().timeFormat))}${isToday ? '\nClick to tick off' : '\nClick to edit the routine'}">
          <span class="tt-time">${esc(DT.formatTime(step.time, State.settings().timeFormat))}</span>
          <span class="tt-title">${esc(step.title)}</span>
        </button>`;
      }).join('');

      const nowLine = isToday && nowMinutes >= range.start && nowMinutes <= range.end
        ? `<span class="tt-now" style="top:${((nowMinutes - range.start) / span) * 100}%"></span>`
        : '';

      return `<div class="tt-day${isToday ? ' today' : ''}">${blocks}${nowLine}</div>`;
    }).join('');

    host.innerHTML = `
      <div class="tt-head"><div class="tt-corner"></div>${head}</div>
      <div class="tt-body" style="height:${bodyHeight}px;--hour:${HOUR_PX}px">
        <div class="tt-gutter">${hours.join('')}</div>
        ${columns}
      </div>
      <div class="tt-legend">
        ${routines.filter(r => r.active).map(r =>
          `<span><i style="background:${State.categoryOf(r.category).color}"></i>${esc(r.name)}</span>`).join('')}
      </div>`;

    host.querySelectorAll('.tt-block').forEach(block => {
      block.addEventListener('click', () => {
        const { routine, step, day } = block.dataset;
        if (day === today) tickStep(routine, step, day);
        else openEditor(State.Routines.byId(routine));
      });
    });
  }

  function renderEmpty(host) {
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'empty' }, [
      el('strong', { text: 'No routines yet' }),
      el('div', { text: 'A routine is a set of timed steps that repeats — a morning ritual, a study block, an evening wind-down. Each step reminds you when its time comes, and the week fills in as a timetable.' }),
      el('div', { style: { marginTop: '12px', display: 'flex', gap: '6px', justifyContent: 'center' } }, [
        el('button', { class: 'primary-btn', text: 'Start from a template', onClick: openPresets }),
        el('button', { class: 'ghost-btn', text: 'Build my own', onClick: () => openEditor(null) })
      ])
    ]));
  }

  // ----------------------------------------------------------- today pane

  function tickStep(routineId, stepId, dayKey) {
    const nowDone = State.Routines.toggleStep(routineId, stepId, dayKey || DT.todayKey());
    if (!nowDone) return;
    const after = State.Routines.progress(dayKey || DT.todayKey());
    if (after.done === after.total && after.total) {
      const routine = State.Routines.byId(routineId);
      const streak = routine ? State.Routines.streak(routine) : 0;
      UI.toast({
        kind: 'success',
        icon: 'flame',
        title: 'Routine complete for today',
        message: streak > 1 ? `${streak} days in a row.` : 'First day of a new streak.',
        timeout: 3200
      });
    }
  }

  /** The day as a tickable checklist, grouped by routine. */
  function renderTodayPane(container, dayKey) {
    const host = container || $('#routineTodayPane');
    if (!host) return;
    const day = dayKey || DT.todayKey();
    const steps = State.Routines.stepsFor(day);

    host.innerHTML = '';
    if (!steps.length) {
      host.appendChild(el('div', {
        class: 'empty',
        html: '<strong>Nothing scheduled today</strong>Your routines run on other days.'
      }));
      return;
    }

    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const groups = new Map();
    for (const step of steps) {
      if (!groups.has(step.routineId)) groups.set(step.routineId, []);
      groups.get(step.routineId).push(step);
    }

    for (const [routineId, groupSteps] of groups) {
      const routine = State.Routines.byId(routineId);
      if (!routine) continue;
      const done = groupSteps.filter(s => s.done).length;
      const cat = State.categoryOf(routine.category);
      const streak = State.Routines.streak(routine);

      const card = el('div', { class: 'day-group' });
      card.innerHTML = `
        <div class="dg-head">
          <span class="routine-dot" style="background:${cat.color}"></span>
          <b>${esc(routine.name)}</b>
          ${streak > 0 ? `<span class="dg-streak" title="${streak}-day streak">${Icons.icon('flame', 11)}${streak}</span>` : ''}
          <span class="dg-count">${done}/${groupSteps.length}</span>
        </div>
        <div class="mini-bar"><span style="width:${(done / groupSteps.length) * 100}%"></span></div>`;

      const list = el('div', { class: 'routine-check-list' });
      for (const step of groupSteps) {
        const late = !step.done && step.startMinutes < nowMinutes;
        const live = !step.done && step.startMinutes <= nowMinutes && step.endMinutes > nowMinutes;
        const row = el('div', {
          class: `routine-check${step.done ? ' done' : ''}${late && !live ? ' late' : ''}${live ? ' next' : ''}`
        });
        row.innerHTML = `
          <span class="check" role="checkbox" tabindex="0" aria-checked="${step.done}"></span>
          <span class="rc-time">${esc(DT.formatTime(step.time, State.settings().timeFormat))}</span>
          <span class="rc-title">${esc(step.title)}</span>
          <span class="rc-routine">${step.duration ? step.duration + ' min' : ''}</span>`;
        const toggle = () => tickStep(step.routineId, step.id, day);
        row.querySelector('.check').addEventListener('click', toggle);
        row.querySelector('.check').addEventListener('keydown', e => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
        });
        list.appendChild(row);
      }
      card.appendChild(list);
      host.appendChild(card);
    }

    // A week of adherence, so consistency is visible without leaving the tab.
    const history = State.Routines.history(7);
    const strip = el('div', { class: 'card consistency' });
    strip.innerHTML = `
      <div class="card-head"><h3>Last 7 days</h3>
        <span class="pill">${State.Routines.adherence(7).percent ?? 0}% of steps</span></div>
      <div class="week-dots">
        ${history.map(d => `
          <span class="wd${d.percent === null ? ' off' : d.percent === 100 ? ' full' : d.percent > 0 ? ' part' : ' miss'}"
                title="${esc(DT.relativeDay(d.key))}: ${d.total ? d.done + '/' + d.total : 'nothing scheduled'}">
            <i style="--fill:${d.percent === null ? 0 : d.percent}%"></i>
            <small>${esc(DT.DAY_NAMES[d.date.getDay()].slice(0, 1))}</small>
          </span>`).join('')}
      </div>`;
    host.appendChild(strip);
  }

  // ---------------------------------------------------------- manage list

  function routineCard(routine) {
    const today = DT.todayKey();
    const runsToday = State.Routines.runsOn(routine, today);
    const done = (routine.completed[today] || []).length;
    const streak = State.Routines.streak(routine);
    const card = el('div', { class: `routine${routine.active ? '' : ' inactive'}` });
    const cat = State.categoryOf(routine.category);

    card.innerHTML = `
      <div class="routine-head">
        <span class="routine-dot" style="background:${cat.color}"></span>
        <b>${esc(routine.name)}</b>
        ${streak > 0 ? `<span class="dg-streak" title="${streak}-day streak">${Icons.icon('flame', 11)}${streak}</span>` : ''}
        <span class="routine-meta">${esc(daysLabel(routine.days))} · ${UI.plural(routine.steps.length, 'step')}</span>
      </div>
      <div class="routine-steps">
        ${routine.steps.map(s => `
          <span class="routine-step${(routine.completed[today] || []).includes(s.id) ? ' done' : ''}">
            <i>${esc(DT.formatTime(s.time, State.settings().timeFormat))}</i>${esc(s.title)}
          </span>`).join('')}
      </div>`;

    card.appendChild(el('div', { class: 'routine-foot' }, [
      el('span', {
        class: 'routine-progress',
        text: runsToday ? `${done}/${routine.steps.length} done today` : 'Not scheduled today'
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
    ]));
    card.addEventListener('dblclick', () => openEditor(routine));
    return card;
  }

  // ---------------------------------------------------------------- editor

  const PRESETS = [
    {
      name: 'Morning routine', category: 'personal', days: [1, 2, 3, 4, 5],
      steps: [
        { title: 'Wake up', time: '07:00', duration: 10 },
        { title: 'Stretch and hydrate', time: '07:10', duration: 20 },
        { title: 'Breakfast', time: '07:30', duration: 30 },
        { title: 'Plan the day', time: '08:00', duration: 15 }
      ]
    },
    {
      name: 'Deep work block', category: 'work', days: [1, 2, 3, 4, 5],
      steps: [
        { title: 'Clear inbox', time: '09:00', duration: 30 },
        { title: 'Focus block one', time: '09:30', duration: 90 },
        { title: 'Break', time: '11:00', duration: 15 },
        { title: 'Focus block two', time: '11:15', duration: 75 }
      ]
    },
    {
      name: 'Evening wind-down', category: 'health', days: [0, 1, 2, 3, 4, 5, 6],
      steps: [
        { title: 'Shut down work', time: '18:00', duration: 15 },
        { title: 'Exercise', time: '18:30', duration: 45 },
        { title: 'Screens off', time: '22:00', duration: 15 },
        { title: 'Read', time: '22:15', duration: 30 }
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
    if (!draft.steps.length) draft.steps.push({ title: '', time: '', duration: 30 });

    const body = el('div');

    const name = el('input', {
      type: 'text', value: draft.name, placeholder: 'e.g. Morning routine', maxlength: '80'
    });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Routine name' }), name]));

    const dayRow = el('div', { class: 'day-picker' });
    for (const day of weekOrder()) {
      dayRow.appendChild(el('button', {
        type: 'button',
        class: draft.days.includes(day) ? 'active' : '',
        text: DAY_LETTERS[day],
        title: DT.DAY_NAMES[day],
        onClick: e => {
          const i = draft.days.indexOf(day);
          if (i >= 0) draft.days.splice(i, 1); else draft.days.push(day);
          e.currentTarget.classList.toggle('active', draft.days.includes(day));
        }
      }));
    }
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Runs on' }), dayRow]));

    const stepsHost = el('div', { class: 'step-editor' });
    function drawSteps() {
      stepsHost.innerHTML = '';
      stepsHost.appendChild(el('div', { class: 'step-legend' }, [
        el('span', { text: 'Start' }), el('span', { text: 'Step' }), el('span', { text: 'Mins' })
      ]));
      draft.steps.forEach((step, index) => {
        const time = el('input', { type: 'time', value: step.time || '' });
        time.addEventListener('change', () => { step.time = time.value; });
        const title = el('input', {
          type: 'text', value: step.title || '', placeholder: 'Step ' + (index + 1), maxlength: '90'
        });
        title.addEventListener('input', () => { step.title = title.value; });
        const duration = el('input', {
          type: 'number', min: '5', max: '600', step: '5',
          value: String(step.duration || 30), title: 'How long it takes, in minutes'
        });
        duration.addEventListener('change', () => { step.duration = Number(duration.value) || 30; });

        stepsHost.appendChild(el('div', { class: 'step-row' }, [
          time, title, duration,
          el('button', {
            class: 'icon-btn sm danger', title: 'Remove step', html: Icons.icon('trash', 12),
            onClick: () => {
              draft.steps.splice(index, 1);
              if (!draft.steps.length) draft.steps.push({ title: '', time: '', duration: 30 });
              drawSteps();
            }
          })
        ]));
      });

      stepsHost.appendChild(el('button', {
        class: 'ghost-btn',
        text: '+ Add step',
        onClick: () => {
          // Start the next step where the last one ends: less typing, and the
          // timetable stays gap-free by default.
          const last = draft.steps[draft.steps.length - 1];
          const after = last && DT.toMinutes(last.time) !== null
            ? DT.fromMinutes(DT.toMinutes(last.time) + (last.duration || 30))
            : '';
          draft.steps.push({ title: '', time: after, duration: 30 });
          drawSteps();
        }
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
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Remind me' }), remind]));
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
          UI.toast({ kind: 'error', title: 'Every step needs a start time', message: missingTime.title });
          return;
        }
        State.Routines.save({
          ...draft, name: name.value, category, steps,
          remind: remind.value === '' ? false : Number(remind.value)
        });
        close(true);
        UI.toast({
          kind: 'success',
          title: isNew ? 'Routine created' : 'Routine updated',
          message: isNew ? 'It is on your timetable now.' : ''
        });
      }
    });

    UI.modal({ title: isNew ? 'New routine' : 'Edit routine', body, actions });
  }

  /** Ready-made routines so the first one is a click, not a form. */
  function openPresets() {
    const body = el('div');
    body.appendChild(el('p', {
      class: 'muted-note',
      text: 'Start from a template — rename, retime or delete any step afterwards.'
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

  // -------------------------------------------------------------- routing

  function setMode(next) {
    mode = next;
    const view = document.querySelector('.view[data-view="routines"]');
    if (view) view.dataset.mode = mode;
    UI.$$('#routineModeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    State.patchSettings({ routineMode: mode });
    render();
  }

  function render() {
    if (!mounted) return;
    if (!State.isActiveTab('routines')) return;

    renderMomentum();
    const routines = State.Routines.all();

    if (mode === 'week') renderWeek();
    else if (mode === 'today') renderTodayPane();
    else {
      const host = $('#routineList');
      host.innerHTML = '';
      if (!routines.length) renderEmpty(host);
      else for (const routine of routines) host.appendChild(routineCard(routine));
    }
  }

  /** The Today tab's routine card — the same steps, in the day's context. */
  function renderToday(container) {
    const host = container || $('#routineToday');
    if (!host) return;
    const today = DT.todayKey();
    const steps = State.Routines.stepsFor(today);

    if (!steps.length) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;

    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const progress = State.Routines.progress(today);
    const next = State.Routines.nextStep(today);

    host.innerHTML = `
      <div class="card-head">
        <h3>${Icons.icon('routine', 13)} Today's routine</h3>
        <span class="pill">${progress.done}/${progress.total}</span>
      </div>
      <div class="mini-bar" style="margin-bottom:8px"><span style="width:${progress.percent}%"></span></div>
      <p class="routine-nudge">${esc(momentumLine(progress, next, State.Routines.overdue(today),
        State.Routines.all().reduce((m, r) => Math.max(m, State.Routines.streak(r)), 0)))}</p>`;

    const list = el('div', { class: 'routine-check-list' });
    for (const step of steps) {
      const late = !step.done && step.startMinutes < nowMinutes;
      const live = !step.done && step.startMinutes <= nowMinutes && step.endMinutes > nowMinutes;
      const row = el('div', {
        class: `routine-check${step.done ? ' done' : ''}${late && !live ? ' late' : ''}${live ? ' next' : ''}`
      });
      row.innerHTML = `
        <span class="check" role="checkbox" tabindex="0" aria-checked="${step.done}"></span>
        <span class="rc-time">${esc(DT.formatTime(step.time, State.settings().timeFormat))}</span>
        <span class="rc-title">${esc(step.title)}</span>
        <span class="rc-routine">${esc(step.routineName)}</span>`;
      const toggle = () => tickStep(step.routineId, step.id, today);
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
    mode = State.settings().routineMode || 'week';
    const view = document.querySelector('.view[data-view="routines"]');
    if (view) view.dataset.mode = mode;
    UI.$$('#routineModeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

    $('#routineAdd').addEventListener('click', () => openEditor(null));
    $('#routineTemplates').addEventListener('click', openPresets);
    $('#routineModeSeg').addEventListener('click', e => {
      const btn = e.target.closest('button[data-mode]');
      if (btn) setMode(btn.dataset.mode);
    });

    State.on('routines', () => { render(); if (State.isActiveTab('today')) renderToday(); });
    State.on('settings', render);
    State.on('tick:day', () => { render(); renderToday(); });
    State.on('tick:minute', () => {
      // The now-line, "in 12 min" and overdue styling all age by the minute.
      if (State.isActiveTab('routines')) render();
      if (State.isActiveTab('today')) renderToday();
    });

    render();
  }

  global.Routines = {
    init, render, renderToday, openEditor, openPresets,
    setMode, momentumLine
  };
}(window));
