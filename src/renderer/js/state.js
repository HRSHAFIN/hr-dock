/* HR Dock — renderer state.
   Holds the working copy of the user's data, performs every mutation, and
   flushes changed collections to the main process on a short debounce so a
   burst of typing costs one disk write rather than fifty. */
(function (global) {
  'use strict';

  const { debounce, uid } = UI;

  const CATEGORIES = [
    { id: 'work', label: 'Work', color: 'var(--cat-work)' },
    { id: 'personal', label: 'Personal', color: 'var(--cat-personal)' },
    { id: 'meeting', label: 'Meeting', color: 'var(--cat-meeting)' },
    { id: 'deadline', label: 'Deadline', color: 'var(--cat-deadline)' },
    { id: 'health', label: 'Health', color: 'var(--cat-health)' },
    { id: 'study', label: 'Study', color: 'var(--cat-study)' },
    { id: 'birthday', label: 'Birthday', color: 'var(--cat-birthday)' },
    { id: 'general', label: 'General', color: 'var(--cat-general)' }
  ];

  const PRIORITIES = [
    { id: 'low', label: 'Low', rank: 0 },
    { id: 'medium', label: 'Medium', rank: 1 },
    { id: 'high', label: 'High', rank: 2 },
    { id: 'critical', label: 'Critical', rank: 3 }
  ];

  const RECURRENCES = [
    { id: 'none', label: 'Does not repeat' },
    { id: 'daily', label: 'Every day' },
    { id: 'weekdays', label: 'Weekdays (Mon–Fri)' },
    { id: 'weekly', label: 'Every week' },
    { id: 'monthly', label: 'Every month' },
    { id: 'yearly', label: 'Every year' }
  ];

  const NOTE_COLORS = ['#5b8cff', '#b48cff', '#58c9a6', '#f5c451', '#ff8fc4', '#ff8a5b', 'transparent'];

  const state = {
    data: null,
    env: null,
    ready: false
  };

  const subscribers = new Map();   // topic -> Set(fn)

  function on(topic, fn) {
    if (!subscribers.has(topic)) subscribers.set(topic, new Set());
    subscribers.get(topic).add(fn);
    return () => subscribers.get(topic).delete(fn);
  }

  function emit(topic, payload) {
    for (const t of [topic, '*']) {
      const set = subscribers.get(t);
      if (!set) continue;
      for (const fn of set) {
        try { fn(payload, topic); } catch (err) { console.error(`[state] ${t} subscriber failed`, err); }
      }
    }
  }

  // Each collection gets its own debounced writer so a note edit never
  // rewrites the task list and vice versa.
  const writers = {};
  function persist(key) {
    if (!writers[key]) {
      writers[key] = debounce(() => {
        hrdock.data.set(key, state.data[key]).catch(err => {
          console.error('[state] save failed', err);
          UI.toast({ kind: 'error', title: 'Could not save', message: err.message });
        });
      }, 320);
    }
    writers[key]();
  }

  /** Flush everything immediately — used before quitting or importing. */
  function flushAll() {
    for (const key of Object.keys(writers)) writers[key].flush();
  }

  function commit(key) {
    persist(key);
    emit(key, state.data[key]);
  }

  // ------------------------------------------------------------- settings

  async function patchSettings(patch) {
    const next = await hrdock.settings.patch(patch);
    state.data.settings = next;
    applyTheme();
    emit('settings', next);
    return next;
  }

  /** Local-only settings update (used when main already knows). */
  function absorbSettings(settings) {
    state.data.settings = settings;
    applyTheme();
    emit('settings', settings);
  }

  function prefersDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /**
   * Is `tab` the one currently on screen?
   * Views guard their renders with this: a data change should not rebuild the
   * calendar grid and the insights charts when the user is looking at neither.
   * App.setTab writes the dataset before it calls a view's render, so the tab
   * being switched to always re-renders and picks up whatever it missed.
   */
  function isActiveTab(tab) {
    return document.body.dataset.tab === tab;
  }

  function applyTheme() {
    const s = state.data.settings;
    const theme = s.theme === 'auto' ? (prefersDark() ? 'dark' : 'light') : s.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--accent', s.accent || '#5b8cff');
    document.documentElement.style.setProperty('--accent-ink', readableInk(s.accent || '#5b8cff'));
    document.body.dataset.compact = String(!!s.compact);
    document.body.dataset.clickthrough = String(!!s.clickThrough);
  }

  /** Pick black or white text for a given accent, by relative luminance. */
  function readableInk(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    const [r, g, b] = [1, 2, 3].map(i => parseInt(m[i], 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return lum > 0.42 ? '#10141c' : '#ffffff';
  }

  // --------------------------------------------------------------- events

  function normaliseEvent(input) {
    return {
      id: input.id || uid('ev'),
      title: (input.title || 'Untitled').trim(),
      date: input.date || DT.todayKey(),
      time: input.time || '',
      endTime: input.endTime || '',
      category: input.category || 'general',
      priority: input.priority || 'medium',
      location: input.location || '',
      notes: input.notes || '',
      status: input.status || 'planned',        // planned | done | cancelled
      remind: input.remind === undefined ? 10 : input.remind,
      recurrence: input.recurrence || 'none',
      interval: Number(input.interval) || 1,
      weekdays: input.weekdays || null,
      until: input.until || null,
      exceptions: input.exceptions || [],
      completedOn: input.completedOn || [],     // day keys, so recurring events tick off per day
      createdAt: input.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }

  const Events = {
    all: () => state.data.events,
    byId: id => state.data.events.find(e => e.id === id) || null,

    /** Every event instance on a day, ordered by start time (all-day first). */
    onDay(dayKey) {
      const out = [];
      for (const ev of state.data.events) {
        if (!DT.occursOn(ev, dayKey)) continue;
        out.push({ ...ev, day: dayKey, done: (ev.completedOn || []).includes(dayKey) });
      }
      return out.sort((a, b) => {
        const am = DT.toMinutes(a.time), bm = DT.toMinutes(b.time);
        if (am === null && bm === null) return a.title.localeCompare(b.title);
        if (am === null) return -1;
        if (bm === null) return 1;
        return am - bm;
      });
    },

    /** Flattened instances across a range, for the upcoming list and dots. */
    between(startKey, endKey) {
      const out = [];
      for (const ev of state.data.events) {
        for (const day of DT.occurrencesBetween(ev, startKey, endKey)) {
          out.push({ ...ev, day, done: (ev.completedOn || []).includes(day) });
        }
      }
      return out.sort((a, b) => (a.day + (a.time || '99:99')).localeCompare(b.day + (b.time || '99:99')));
    },

    save(input) {
      const record = normaliseEvent(input);
      const idx = state.data.events.findIndex(e => e.id === record.id);
      if (idx >= 0) state.data.events[idx] = { ...state.data.events[idx], ...record };
      else state.data.events.push(record);
      commit('events');
      return record;
    },

    remove(id) {
      state.data.events = state.data.events.filter(e => e.id !== id);
      commit('events');
    },

    /** Skip one occurrence of a repeating event without deleting the series. */
    skipDay(id, dayKey) {
      const ev = Events.byId(id);
      if (!ev) return;
      ev.exceptions = Array.from(new Set([...(ev.exceptions || []), dayKey]));
      ev.updatedAt = Date.now();
      commit('events');
    },

    toggleDone(id, dayKey) {
      const ev = Events.byId(id);
      if (!ev) return;
      const days = new Set(ev.completedOn || []);
      const wasDone = days.has(dayKey);
      if (wasDone) days.delete(dayKey); else days.add(dayKey);
      ev.completedOn = Array.from(days);
      ev.status = wasDone ? 'planned' : 'done';
      ev.updatedAt = Date.now();
      commit('events');
      return !wasDone;
    }
  };

  // ---------------------------------------------------------------- todos

  function normaliseTodo(input) {
    return {
      id: input.id || uid('td'),
      title: (input.title || '').trim(),
      notes: input.notes || '',
      done: !!input.done,
      priority: input.priority || 'medium',
      category: input.category || 'general',
      due: input.due || null,
      dueTime: input.dueTime || '',
      remind: input.remind === undefined ? false : input.remind,
      recurrence: input.recurrence || 'none',
      interval: Number(input.interval) || 1,
      order: Number.isFinite(input.order) ? input.order : Date.now(),
      createdAt: input.createdAt || Date.now(),
      completedAt: input.completedAt || null,
      updatedAt: Date.now()
    };
  }

  const Todos = {
    all: () => state.data.todos,
    byId: id => state.data.todos.find(t => t.id === id) || null,

    active: () => state.data.todos.filter(t => !t.done),

    dueToday() {
      const today = DT.todayKey();
      return state.data.todos.filter(t => !t.done && t.due && t.due <= today);
    },

    save(input) {
      const record = normaliseTodo(input);
      if (!record.title) return null;
      const idx = state.data.todos.findIndex(t => t.id === record.id);
      if (idx >= 0) state.data.todos[idx] = { ...state.data.todos[idx], ...record };
      else state.data.todos.unshift(record);
      commit('todos');
      return record;
    },

    remove(id) {
      state.data.todos = state.data.todos.filter(t => t.id !== id);
      commit('todos');
    },

    /**
     * Completing a repeating task rolls it forward to the next occurrence
     * instead of closing it, which is what "recurring" has to mean for a to-do.
     */
    toggle(id) {
      const todo = Todos.byId(id);
      if (!todo) return null;

      if (!todo.done && todo.recurrence && todo.recurrence !== 'none' && todo.due) {
        // The series stays anchored to the original due date — only the search
        // start moves — so a weekly task lands next week, not tomorrow.
        const searchFrom = DT.key(DT.addDays(DT.fromKey(todo.due), 1));
        const nextDay = DT.nextOccurrence(
          {
            date: todo.due,
            recurrence: todo.recurrence,
            interval: todo.interval,
            weekdays: todo.weekdays
          },
          searchFrom);
        recordCompletion();
        todo.due = nextDay || todo.due;
        todo.completedAt = Date.now();
        todo.updatedAt = Date.now();
        commit('todos');
        return { rolled: true, next: todo.due };
      }

      todo.done = !todo.done;
      todo.completedAt = todo.done ? Date.now() : null;
      todo.updatedAt = Date.now();
      if (todo.done) recordCompletion(); else undoCompletion();
      commit('todos');
      return { rolled: false, done: todo.done };
    },

    /** Persist a new manual ordering (drag and drop). */
    reorder(orderedIds) {
      const rank = new Map(orderedIds.map((id, i) => [id, i]));
      for (const todo of state.data.todos) {
        if (rank.has(todo.id)) todo.order = rank.get(todo.id);
      }
      commit('todos');
    },

    clearCompleted() {
      const before = state.data.todos.length;
      state.data.todos = state.data.todos.filter(t => !t.done);
      commit('todos');
      return before - state.data.todos.length;
    }
  };

  // ------------------------------------------------------------- routines

  /**
   * A routine is a named set of timed steps that repeats on chosen weekdays —
   * a morning ritual, a gym split, a shutdown checklist. Steps are ticked off
   * per day, so yesterday's completions never hide today's.
   */
  function normaliseRoutine(input) {
    const steps = (input.steps || [])
      .map(s => ({
        id: s.id || uid('st'),
        title: (s.title || '').trim(),
        time: s.time || '',
        // A timetable needs a block to draw, so every step has a length.
        duration: Math.max(5, Number(s.duration) || 30)
      }))
      .filter(s => s.title)
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

    return {
      id: input.id || uid('rt'),
      name: (input.name || 'Untitled routine').trim(),
      category: input.category || 'personal',
      days: Array.isArray(input.days) && input.days.length ? input.days : [0, 1, 2, 3, 4, 5, 6],
      steps,
      active: input.active === undefined ? true : !!input.active,
      remind: input.remind === undefined ? 0 : input.remind,
      completed: input.completed || {},          // 'YYYY-MM-DD' -> [stepId]
      createdAt: input.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }

  const Routines = {
    all: () => state.data.routines,
    byId: id => state.data.routines.find(r => r.id === id) || null,

    runsOn(routine, dayKey) {
      if (!routine.active) return false;
      const day = DT.fromKey(dayKey);
      return !!day && routine.days.includes(day.getDay());
    },

    /** Flattened steps for a day, in time order, with per-day done state. */
    stepsFor(dayKey) {
      const out = [];
      for (const routine of state.data.routines) {
        if (!Routines.runsOn(routine, dayKey)) continue;
        const done = routine.completed[dayKey] || [];
        for (const step of routine.steps) {
          const start = DT.toMinutes(step.time);
          out.push({
            ...step,
            routineId: routine.id,
            routineName: routine.name,
            category: routine.category,
            startMinutes: start,
            endMinutes: start === null ? null : start + (step.duration || 30),
            done: done.includes(step.id)
          });
        }
      }
      return out.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
    },

    save(input) {
      const record = normaliseRoutine(input);
      const idx = state.data.routines.findIndex(r => r.id === record.id);
      if (idx >= 0) state.data.routines[idx] = { ...state.data.routines[idx], ...record };
      else state.data.routines.push(record);
      commit('routines');
      return record;
    },

    remove(id) {
      state.data.routines = state.data.routines.filter(r => r.id !== id);
      commit('routines');
    },

    setActive(id, active) {
      const routine = Routines.byId(id);
      if (!routine) return;
      routine.active = !!active;
      routine.updatedAt = Date.now();
      commit('routines');
    },

    toggleStep(routineId, stepId, dayKey) {
      const routine = Routines.byId(routineId);
      if (!routine) return false;
      const day = dayKey || DT.todayKey();
      const done = new Set(routine.completed[day] || []);
      const wasDone = done.has(stepId);
      if (wasDone) done.delete(stepId); else done.add(stepId);
      routine.completed[day] = Array.from(done);
      if (!routine.completed[day].length) delete routine.completed[day];
      routine.updatedAt = Date.now();
      commit('routines');
      // Finishing a routine step is real progress; count it like a task.
      if (wasDone) undoCompletion(); else recordCompletion();
      return !wasDone;
    },

    /** How much of a day's routine work is done, for the progress ring. */
    progress(dayKey) {
      const steps = Routines.stepsFor(dayKey || DT.todayKey());
      const done = steps.filter(s => s.done).length;
      return { done, total: steps.length, percent: steps.length ? (done / steps.length) * 100 : 0 };
    },

    /** Was every step of this routine ticked off on `dayKey`? */
    completedOn(routine, dayKey) {
      if (!Routines.runsOn(routine, dayKey)) return false;
      if (!routine.steps.length) return false;
      const done = routine.completed[dayKey] || [];
      return routine.steps.every(s => done.includes(s.id));
    },

    /**
     * Consecutive days a routine was finished, counting only the days it
     * actually runs — a weekday routine is not "broken" by the weekend.
     * Today still in progress does not break the streak; yesterday does.
     */
    streak(routine) {
      let cursor = new Date();
      let current = 0;
      // Give today a pass until it is finished, so a morning check-in does not
      // show the streak as already lost.
      if (Routines.runsOn(routine, DT.key(cursor)) && !Routines.completedOn(routine, DT.key(cursor))) {
        cursor = DT.addDays(cursor, -1);
      }
      for (let i = 0; i < 400; i++) {
        const key = DT.key(cursor);
        if (Routines.runsOn(routine, key)) {
          if (!Routines.completedOn(routine, key)) break;
          current++;
        }
        cursor = DT.addDays(cursor, -1);
      }
      return current;
    },

    /** Per-day completion over the last `days` days, oldest first. */
    history(days) {
      const out = [];
      const span = days || 7;
      for (let i = span - 1; i >= 0; i--) {
        const date = DT.addDays(new Date(), -i);
        const key = DT.key(date);
        const steps = Routines.stepsFor(key);
        const done = steps.filter(s => s.done).length;
        out.push({
          key,
          date,
          done,
          total: steps.length,
          percent: steps.length ? Math.round((done / steps.length) * 100) : null
        });
      }
      return out;
    },

    /** Adherence across a window, ignoring days with nothing scheduled. */
    adherence(days) {
      const history = Routines.history(days || 7).filter(d => d.total > 0);
      if (!history.length) return { percent: null, days: 0, done: 0, total: 0 };
      const done = history.reduce((sum, d) => sum + d.done, 0);
      const total = history.reduce((sum, d) => sum + d.total, 0);
      return {
        percent: Math.round((done / total) * 100),
        days: history.length,
        done,
        total,
        perfectDays: history.filter(d => d.percent === 100).length
      };
    },

    /** The next step still to do today, and whether it is already late. */
    nextStep(dayKey) {
      const day = dayKey || DT.todayKey();
      const now = new Date().getHours() * 60 + new Date().getMinutes();
      const pending = Routines.stepsFor(day).filter(s => !s.done);
      if (!pending.length) return null;
      const upcoming = pending.find(s => (DT.toMinutes(s.time) || 0) >= now);
      const step = upcoming || pending[0];
      const mins = DT.toMinutes(step.time) || 0;
      return { ...step, minutesAway: mins - now, late: mins < now };
    },

    /** Steps that are past their time and still untouched. */
    overdue(dayKey) {
      const day = dayKey || DT.todayKey();
      const now = new Date().getHours() * 60 + new Date().getMinutes();
      return Routines.stepsFor(day).filter(s => !s.done && (DT.toMinutes(s.time) || 0) < now);
    }
  };

  // ---------------------------------------------------------------- notes

  const Notes = {
    all: () => state.data.notes,
    byId: id => state.data.notes.find(n => n.id === id) || null,

    save(input) {
      const record = {
        id: input.id || uid('nt'),
        title: input.title || '',
        html: input.html || '',
        color: input.color || 'transparent',
        pinned: !!input.pinned,
        category: input.category || 'general',
        createdAt: input.createdAt || Date.now(),
        updatedAt: Date.now()
      };
      const idx = state.data.notes.findIndex(n => n.id === record.id);
      if (idx >= 0) state.data.notes[idx] = { ...state.data.notes[idx], ...record };
      else state.data.notes.unshift(record);
      commit('notes');
      return record;
    },

    remove(id) {
      state.data.notes = state.data.notes.filter(n => n.id !== id);
      commit('notes');
    },

    search(query) {
      const q = (query || '').trim().toLowerCase();
      const sorted = [...state.data.notes].sort((a, b) =>
        (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
      if (!q) return sorted;
      return sorted.filter(n =>
        (n.title || '').toLowerCase().includes(q) ||
        UI.textOf(n.html).toLowerCase().includes(q) ||
        (n.category || '').toLowerCase().includes(q));
    }
  };

  // ---------------------------------------------------------------- stats

  function recomputeStreak() {
    const stats = state.data.stats;
    const completions = stats.completions || {};
    let cursor = new Date();
    // A day still in progress with no completions doesn't break the streak.
    if (!completions[DT.key(cursor)]) cursor = DT.addDays(cursor, -1);
    let current = 0;
    while (completions[DT.key(cursor)] > 0) {
      current++;
      cursor = DT.addDays(cursor, -1);
    }
    stats.streak = {
      current,
      best: Math.max(current, (stats.streak && stats.streak.best) || 0),
      last: DT.todayKey()
    };
    return stats.streak;
  }

  function recordCompletion() {
    const today = DT.todayKey();
    const stats = state.data.stats;
    stats.completions[today] = (stats.completions[today] || 0) + 1;
    recomputeStreak();
    commit('stats');
  }

  function undoCompletion() {
    const today = DT.todayKey();
    const stats = state.data.stats;
    if (stats.completions[today]) {
      stats.completions[today] = Math.max(0, stats.completions[today] - 1);
      if (!stats.completions[today]) delete stats.completions[today];
    }
    recomputeStreak();
    commit('stats');
  }

  function addFocusTime(seconds) {
    if (!seconds) return;
    const today = DT.todayKey();
    state.data.stats.focus[today] = (state.data.stats.focus[today] || 0) + seconds;
    commit('stats');
  }

  const Stats = {
    get: () => state.data.stats,
    completionsOn: dayKey => state.data.stats.completions[dayKey] || 0,
    focusOn: dayKey => state.data.stats.focus[dayKey] || 0,
    recordCompletion,
    undoCompletion,
    addFocusTime,
    recomputeStreak
  };

  // ------------------------------------------------------------ bootstrap

  async function init() {
    const boot = await hrdock.bootstrap();
    state.data = boot.data;
    state.env = boot.env;
    state.ready = true;

    // Backfill any collection an older/partial file was missing.
    for (const key of ['events', 'routines', 'todos', 'notes']) {
      if (!Array.isArray(state.data[key])) state.data[key] = [];
    }
    if (!state.data.stats) state.data.stats = { completions: {}, focus: {}, streak: { current: 0, best: 0, last: null } };
    if (!state.data.stats.completions) state.data.stats.completions = {};
    if (!state.data.stats.focus) state.data.stats.focus = {};

    document.body.dataset.surface = boot.env.surface || 'glass';
    applyTheme();
    recomputeStreak();

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.data.settings.theme === 'auto') { applyTheme(); emit('settings', state.data.settings); }
    });

    hrdock.on('settings:changed', absorbSettings);
    hrdock.on('data:replaced', data => {
      state.data = data;
      applyTheme();
      emit('events', data.events);
      emit('routines', data.routines);
      emit('todos', data.todos);
      emit('notes', data.notes);
      emit('stats', data.stats);
      emit('settings', data.settings);
    });
    hrdock.on('theme:changed', () => {
      if (state.data.settings.theme === 'auto') { applyTheme(); emit('settings', state.data.settings); }
    });

    return state;
  }

  global.State = {
    state,
    init,
    on,
    emit,
    flushAll,
    patchSettings,
    applyTheme,
    isActiveTab,
    settings: () => state.data.settings,
    env: () => state.env,
    Events, Routines, Todos, Notes, Stats,
    CATEGORIES, PRIORITIES, RECURRENCES, NOTE_COLORS,
    categoryOf: id => CATEGORIES.find(c => c.id === id) || CATEGORIES[CATEGORIES.length - 1],
    priorityOf: id => PRIORITIES.find(p => p.id === id) || PRIORITIES[1]
  };
}(window));
