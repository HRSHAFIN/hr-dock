/* HR Dock — workouts: the log of what was actually lifted, run or stretched.

   Deliberately its own tab rather than a kind of routine. A routine step is
   time you meant to spend and either did or did not; a workout is work you
   already did, and the thing worth keeping — the load, and whether it moved —
   has nowhere to live on a timetable. The whole section hides from Settings
   for anyone who does not train. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let mounted = false;

  const unit = () => (State.settings().weightUnit === 'lb' ? 'lb' : 'kg');
  const kindOf = id => State.Workouts.KINDS.find(k => k.id === id) || State.Workouts.KINDS[0];

  /** Thousands separated, because session volume runs into five figures. */
  const num = n => Math.round(n).toLocaleString();

  function minutes(mins) {
    const m = Math.max(0, Math.round(mins));
    if (!m) return '—';
    const h = Math.floor(m / 60);
    return h ? `${h}h ${m % 60}m` : `${m}m`;
  }

  /** "4 × 8 · 60kg", or just "4 × 8" when the load is the body's own. */
  function setsLabel(exercise) {
    const reps = `${exercise.sets} × ${exercise.reps}`;
    return exercise.weight ? `${reps} · ${num(exercise.weight)}${unit()}` : `${reps} · body`;
  }

  // -------------------------------------------------------------- summary

  /**
   * One honest line about the week, derived from the sessions themselves
   * rather than picked from a bag of encouragement.
   */
  function weekLine(week, streak) {
    if (!State.Workouts.all().length) {
      return 'Nothing logged yet. Record a session and the week starts keeping score.';
    }
    if (!week.sessions) {
      return streak > 0
        ? 'Nothing this week yet — the run of weeks is still alive until Sunday.'
        : 'Nothing this week. One session is enough to start again.';
    }
    const load = week.volume ? ` · ${num(week.volume)}${unit()} moved` : '';
    return `${UI.plural(week.sessions, 'session')} over ${week.days} ${week.days === 1 ? 'day' : 'days'}${load}.`;
  }

  function renderSummary() {
    const host = $('#workoutSummary');
    if (!host) return;

    const week = State.Workouts.summary(7);
    const streak = State.Workouts.streak();
    const history = State.Workouts.history(8);
    const peak = Math.max(1, ...history.map(h => h.volume || h.minutes || 0));

    host.innerHTML = `
      <div class="wo-figures">
        <span class="wo-figure">
          <b>${week.sessions}</b><small>${week.sessions === 1 ? 'session' : 'sessions'}</small>
        </span>
        <span class="wo-figure">
          <b>${minutes(week.minutes)}</b><small>time</small>
        </span>
        <span class="wo-figure">
          <b>${week.volume ? num(week.volume) + unit() : '—'}</b><small>volume</small>
        </span>
        <span class="wo-figure${streak > 0 ? ' hot' : ''}">
          <b>${Icons.icon('flame', 13)}${streak}</b><small>week streak</small>
        </span>
      </div>
      <p class="wo-line">${esc(weekLine(week, streak))}</p>
      <div class="wo-trend" title="Volume over the last eight weeks">
        ${history.map(h => {
          const value = h.volume || h.minutes || 0;
          const label = h.sessions
            ? `${h.from}: ${UI.plural(h.sessions, 'session')}${h.volume ? ', ' + num(h.volume) + unit() : ''}`
            : `${h.from}: nothing logged`;
          return `<span class="wo-bar${h.sessions ? '' : ' empty'}" title="${esc(label)}">
            <i style="height:${Math.max(3, Math.round((value / peak) * 100))}%"></i>
          </span>`;
        }).join('')}
      </div>`;
  }

  // ----------------------------------------------------------------- list

  function sessionCard(workout) {
    const card = el('div', { class: 'workout' });
    const volume = State.Workouts.volumeOf(workout);
    const kind = kindOf(workout.kind);
    const lifts = workout.exercises || [];

    card.innerHTML = `
      <div class="wo-head">
        <b>${esc(workout.name)}</b>
        <span class="wo-kind">${esc(kind.label)}</span>
        <span class="wo-when">${esc(DT.relativeDay(workout.day))}</span>
      </div>
      <div class="wo-meta">
        ${workout.duration ? `<span>${Icons.icon('clock', 11)}${esc(minutes(workout.duration))}</span>` : ''}
        ${volume ? `<span>${Icons.icon('dumbbell', 11)}${num(volume)}${unit()}</span>` : ''}
        ${lifts.length ? `<span>${UI.plural(lifts.length, 'exercise')}</span>` : ''}
      </div>
      ${lifts.length ? `<div class="wo-lifts">
        ${lifts.map(x => `
          <span class="wo-lift">
            <i>${esc(x.name)}</i>${esc(setsLabel(x))}
          </span>`).join('')}
      </div>` : ''}
      ${workout.note ? `<p class="wo-note">${esc(workout.note)}</p>` : ''}`;

    card.appendChild(el('div', { class: 'wo-foot' }, [
      el('button', {
        class: 'icon-btn sm', title: 'Repeat this session',
        html: Icons.icon('repeat', 13),
        onClick: () => openEditor({
          ...workout,
          id: null,
          createdAt: null,
          day: DT.todayKey(),
          note: '',
          exercises: lifts.map(x => ({ ...x, id: null }))
        })
      }),
      el('button', {
        class: 'icon-btn sm', title: 'Edit session', html: Icons.icon('edit', 13),
        onClick: () => openEditor(workout)
      })
    ]));
    card.addEventListener('dblclick', () => openEditor(workout));
    return card;
  }

  function renderEmpty(host) {
    host.appendChild(el('div', { class: 'empty' }, [
      el('strong', { text: 'No workouts logged' }),
      el('div', {
        text: 'Record what you trained and how much of it. The week keeps the '
          + 'count, and the load is there to compare against next time.'
      }),
      el('div', { style: { marginTop: '12px' } }, [
        el('button', { class: 'primary-btn', text: 'Log a workout', onClick: () => openEditor(null) })
      ])
    ]));
  }

  function render() {
    if (!mounted) return;
    if (!State.isActiveTab('workouts')) return;

    renderSummary();

    const host = $('#workoutList');
    if (!host) return;
    host.innerHTML = '';

    const sessions = State.Workouts.sorted();
    if (!sessions.length) { renderEmpty(host); return; }

    // Split at the start of this week, so "what have I done lately" is answered
    // before the log turns into an archive.
    const first = Number(State.settings().firstDayOfWeek) || 0;
    const weekStart = DT.key(DT.startOfWeek(new Date(), first));
    const recent = sessions.filter(w => w.day >= weekStart);
    const earlier = sessions.filter(w => w.day < weekStart);

    for (const [label, group] of [['This week', recent], ['Earlier', earlier]]) {
      if (!group.length) continue;
      host.appendChild(el('div', { class: 'wo-group-label', text: label }));
      for (const workout of group) host.appendChild(sessionCard(workout));
    }
  }

  // --------------------------------------------------------------- editor

  function openEditor(workout) {
    const isNew = !workout || !workout.id;
    const draft = {
      id: workout && workout.id,
      name: (workout && workout.name) || '',
      day: (workout && workout.day) || DT.todayKey(),
      kind: (workout && workout.kind) || 'strength',
      duration: workout && workout.duration !== undefined ? workout.duration : 45,
      note: (workout && workout.note) || '',
      exercises: ((workout && workout.exercises) || []).map(x => ({ ...x })),
      createdAt: (workout && workout.createdAt) || null
    };
    if (!draft.exercises.length) draft.exercises.push({ name: '', sets: 3, reps: 10, weight: 0 });

    const body = el('div');

    const name = el('input', {
      type: 'text', value: draft.name, placeholder: 'e.g. Push day', maxlength: '60'
    });
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Session' }), name]));

    const day = el('input', { type: 'date', value: draft.day });
    const duration = el('input', {
      type: 'number', min: '0', max: '600', step: '5',
      value: String(draft.duration), title: 'How long it took, in minutes'
    });
    const kind = el('select');
    for (const option of State.Workouts.KINDS) {
      kind.appendChild(el('option', {
        value: option.id, text: option.label, selected: option.id === draft.kind
      }));
    }
    body.appendChild(el('div', { class: 'field-row' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Date' }), day]),
      el('div', { class: 'field' }, [el('label', { text: 'Minutes' }), duration]),
      el('div', { class: 'field' }, [el('label', { text: 'Kind' }), kind])
    ]));

    const liftsHost = el('div', { class: 'lift-editor' });
    function drawLifts() {
      liftsHost.innerHTML = '';
      liftsHost.appendChild(el('div', { class: 'lift-legend' }, [
        el('span', { text: 'Exercise' }), el('span', { text: 'Sets' }),
        el('span', { text: 'Reps' }), el('span', { text: unit() })
      ]));

      draft.exercises.forEach((lift, index) => {
        const liftName = el('input', {
          type: 'text', value: lift.name || '', maxlength: '60',
          placeholder: 'Exercise ' + (index + 1)
        });
        liftName.addEventListener('input', () => { lift.name = liftName.value; });

        const sets = el('input', { type: 'number', min: '1', max: '99', value: String(lift.sets || 3) });
        sets.addEventListener('change', () => { lift.sets = Number(sets.value) || 1; });

        const reps = el('input', { type: 'number', min: '1', max: '999', value: String(lift.reps || 10) });
        reps.addEventListener('change', () => { lift.reps = Number(reps.value) || 1; });

        // Left at zero this reads as bodyweight rather than as missing data.
        const weight = el('input', {
          type: 'number', min: '0', max: '2000', step: '2.5',
          value: String(lift.weight || 0), title: 'Zero means bodyweight'
        });
        weight.addEventListener('change', () => { lift.weight = Number(weight.value) || 0; });

        liftsHost.appendChild(el('div', { class: 'lift-row' }, [
          liftName, sets, reps, weight,
          el('button', {
            class: 'icon-btn sm danger', title: 'Remove exercise', html: Icons.icon('trash', 12),
            onClick: () => {
              draft.exercises.splice(index, 1);
              if (!draft.exercises.length) draft.exercises.push({ name: '', sets: 3, reps: 10, weight: 0 });
              drawLifts();
            }
          })
        ]));
      });

      liftsHost.appendChild(el('button', {
        class: 'ghost-btn',
        text: '+ Add exercise',
        onClick: () => {
          // Carry the last row's shape forward: sets and reps rarely change
          // between exercises, and the load is the part worth typing.
          const last = draft.exercises[draft.exercises.length - 1];
          draft.exercises.push({
            name: '', sets: (last && last.sets) || 3, reps: (last && last.reps) || 10, weight: 0
          });
          drawLifts();
        }
      }));
    }
    drawLifts();
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Exercises' }), liftsHost]));

    const note = el('textarea', {
      rows: '2', placeholder: 'How it felt, what to change…',
      style: { resize: 'vertical', minHeight: '46px' }
    });
    note.value = draft.note;
    body.appendChild(el('div', { class: 'field' }, [el('label', { text: 'Note' }), note]));

    const actions = [];
    if (!isNew) {
      actions.push({
        label: 'Delete', danger: true, onClick: async close => {
          const ok = await UI.confirm('Delete session',
            `"${draft.name || 'This workout'}" will be removed from the log.`, 'Delete');
          if (!ok) return;
          State.Workouts.remove(draft.id);
          close(true);
        }
      });
    }
    actions.push({ spacer: true });
    actions.push({ label: 'Cancel', onClick: close => close(true) });
    actions.push({
      label: isNew ? 'Log workout' : 'Save', primary: true, onClick: close => {
        const exercises = draft.exercises.filter(x => (x.name || '').trim());
        if (!name.value.trim()) { UI.toast({ kind: 'error', title: 'Give the session a name' }); return; }
        if (!day.value) { UI.toast({ kind: 'error', title: 'Pick a date' }); return; }

        State.Workouts.save({
          ...draft,
          name: name.value,
          day: day.value,
          kind: kind.value,
          duration: Number(duration.value) || 0,
          note: note.value,
          exercises
        });
        close(true);
        UI.toast({
          kind: 'success',
          icon: 'dumbbell',
          title: isNew ? 'Workout logged' : 'Session updated',
          message: isNew && exercises.length ? UI.plural(exercises.length, 'exercise') + ' recorded.' : ''
        });
      }
    });

    UI.modal({ title: isNew ? 'Log a workout' : 'Edit session', body, actions });
  }

  // -------------------------------------------------------------- routing

  function init() {
    mounted = true;
    $('#workoutAdd').addEventListener('click', () => openEditor(null));
    State.on('workouts', render);
    State.on('settings', () => { if (State.isActiveTab('workouts')) render(); });
    State.on('tick:day', () => { if (State.isActiveTab('workouts')) render(); });
    render();
  }

  global.WorkoutUI = { init, render, openEditor };
}(window));
