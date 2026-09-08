/* HR Dock — calendar view: month grid, week strip, day panel and upcoming list.
   Event dots are pre-bucketed per day in one pass so the grid costs a single
   walk over the data rather than 42 independent lookups. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let cursor = new Date();          // month (or week) currently in view
  let selected = DT.todayKey();
  let mode = 'month';
  let mounted = false;

  function weekdayLabels() {
    const first = Number(State.settings().firstDayOfWeek) || 0;
    const out = [];
    for (let i = 0; i < 7; i++) out.push(DT.DAY_NAMES[(first + i) % 7].slice(0, 2));
    return out;
  }

  /** day key -> { events: [...], tasks: [...] } for the visible range. */
  function bucket(startKey, endKey) {
    const map = new Map();
    const ensure = k => {
      if (!map.has(k)) map.set(k, { events: [], tasks: [] });
      return map.get(k);
    };
    for (const instance of State.Events.between(startKey, endKey)) {
      ensure(instance.day).events.push(instance);
    }
    for (const todo of State.Todos.all()) {
      if (todo.due && todo.due >= startKey && todo.due <= endKey) ensure(todo.due).tasks.push(todo);
    }
    return map;
  }

  function renderHeader() {
    const title = $('#calTitle');
    if (mode === 'week') {
      const start = DT.startOfWeek(cursor, Number(State.settings().firstDayOfWeek) || 0);
      const end = DT.addDays(start, 6);
      const sameMonth = start.getMonth() === end.getMonth();
      title.textContent = sameMonth
        ? `${DT.MONTH_NAMES[start.getMonth()]} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`
        : `${DT.MONTH_NAMES[start.getMonth()].slice(0, 3)} ${start.getDate()} – ${DT.MONTH_NAMES[end.getMonth()].slice(0, 3)} ${end.getDate()}`;
    } else {
      title.textContent = `${DT.MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`;
    }

    const wd = $('#calWeekdays');
    wd.hidden = mode === 'week';
    if (mode !== 'week') {
      wd.innerHTML = weekdayLabels().map(d => `<span>${esc(d)}</span>`).join('');
    }
  }

  function dotsFor(day) {
    if (!day) return '';
    const cats = [];
    for (const ev of day.events.slice(0, 3)) cats.push(State.categoryOf(ev.category).color);
    if (day.tasks.length && cats.length < 3) cats.push('var(--accent)');
    return cats.length
      ? `<span class="cal-dots">${cats.map(c => `<i style="background:${c}"></i>`).join('')}</span>`
      : '<span class="cal-dots"></span>';
  }

  function renderMonth() {
    const grid = $('#calGrid');
    const firstDay = Number(State.settings().firstDayOfWeek) || 0;
    const cells = DT.monthGrid(cursor, firstDay);
    const map = bucket(DT.key(cells[0]), DT.key(cells[cells.length - 1]));
    const today = DT.todayKey();
    const month = cursor.getMonth();

    grid.className = 'cal-grid';
    grid.innerHTML = '';

    for (const date of cells) {
      const key = DT.key(date);
      const day = map.get(key);
      const count = day ? day.events.length + day.tasks.length : 0;
      const classes = ['cal-cell'];
      if (date.getMonth() !== month) classes.push('other');
      if (date.getDay() === 0 || date.getDay() === 6) classes.push('weekend');
      if (key === today) classes.push('today');
      if (key === selected) classes.push('selected');

      const cell = el('button', { class: classes.join(' '), type: 'button' });
      cell.dataset.day = key;
      cell.innerHTML = `<span>${date.getDate()}</span>${dotsFor(day)}`
        + (count > 3 ? `<span class="load-bar" style="opacity:${Math.min(0.75, 0.25 + count * 0.08)}"></span>` : '');
      cell.title = count ? `${UI.plural(count, 'item')} on ${DT.relativeDay(key)}` : '';
      grid.appendChild(cell);
    }
  }

  function renderWeek() {
    const grid = $('#calGrid');
    const firstDay = Number(State.settings().firstDayOfWeek) || 0;
    const start = DT.startOfWeek(cursor, firstDay);
    const map = bucket(DT.key(start), DT.key(DT.addDays(start, 6)));
    const today = DT.todayKey();
    const settings = State.settings();

    grid.className = 'cal-week';
    grid.innerHTML = '';

    for (let i = 0; i < 7; i++) {
      const date = DT.addDays(start, i);
      const key = DT.key(date);
      const day = map.get(key) || { events: [], tasks: [] };
      const row = el('button', {
        class: `cal-week-day${key === today ? ' today' : ''}${key === selected ? ' selected' : ''}`,
        type: 'button'
      });
      row.dataset.day = key;

      const chips = day.events.slice(0, 3).map(ev => `
        <span class="cwd-chip">
          <i style="background:${State.categoryOf(ev.category).color}"></i>
          ${ev.time ? esc(DT.formatTime(ev.time, settings.timeFormat)) + ' ' : ''}${esc(ev.title)}
        </span>`).join('');

      const extra = day.events.length > 3 ? `<span class="cwd-chip" style="color:var(--ink-4)">+${day.events.length - 3} more</span>` : '';
      const tasks = day.tasks.length
        ? `<span class="cwd-chip"><i style="background:var(--accent)"></i>${UI.plural(day.tasks.length, 'task')} due</span>` : '';

      row.innerHTML = `
        <span class="cwd-date"><b>${date.getDate()}</b><span>${esc(DT.DAY_NAMES[date.getDay()].slice(0, 3))}</span></span>
        <span class="cwd-events">${chips || tasks || '<span class="cwd-chip" style="color:var(--ink-4)">No events</span>'}${extra}${chips && tasks ? tasks : ''}</span>`;
      grid.appendChild(row);
    }
  }

  function renderDayPanel() {
    $('#calDayTitle').textContent = `${DT.relativeDay(selected)} · ${(() => {
      const d = DT.fromKey(selected);
      return `${DT.MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
    })()}`;

    const list = $('#calDayList');
    const instances = State.Events.onDay(selected);
    EventUI.renderInstanceList(list, instances, {
      emptyTitle: 'No events',
      emptyHint: 'Double-click a date to add one.'
    });

    const tasks = State.Todos.all().filter(t => t.due === selected);
    if (tasks.length) {
      list.appendChild(el('div', {
        class: 'section-meta',
        style: { margin: '10px 2px 4px' },
        text: `${UI.plural(tasks.length, 'task')} due`
      }));
      Tasks.renderRows(list, tasks, { showDue: false });
    }
  }

  function renderUpcoming() {
    const container = $('#calUpcoming');
    const today = DT.todayKey();
    const end = DT.key(DT.addDays(new Date(), 21));
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

    const instances = State.Events.between(today, end)
      .filter(instance => {
        if (instance.done) return false;
        if (instance.day > today) return true;
        const start = DT.toMinutes(instance.time);
        return start === null || start >= nowMinutes;
      })
      .slice(0, 8);

    EventUI.renderInstanceList(container, instances, {
      showDay: true,
      emptyTitle: 'Nothing coming up',
      emptyHint: 'The next three weeks are clear.'
    });
  }

  function render() {
    if (!mounted) return;
    // Skip entirely while another tab is on screen; setTab re-renders on return.
    if (!State.isActiveTab('calendar')) return;
    renderHeader();
    if (mode === 'week') renderWeek(); else renderMonth();
    renderDayPanel();
    renderUpcoming();
  }

  function select(dayKey) {
    selected = dayKey;
    const d = DT.fromKey(dayKey);
    if (d && (d.getMonth() !== cursor.getMonth() || d.getFullYear() !== cursor.getFullYear())) cursor = d;
    render();
  }

  function step(delta) {
    cursor = mode === 'week' ? DT.addDays(cursor, delta * 7) : DT.addMonths(cursor, delta);
    render();
  }

  function init() {
    mounted = true;

    $('#calPrev').innerHTML = Icons.icon('chevronL', 15);
    $('#calNext').innerHTML = Icons.icon('chevronR', 15);
    $('#calPrev').addEventListener('click', () => step(-1));
    $('#calNext').addEventListener('click', () => step(1));
    $('#calTitle').addEventListener('click', () => { cursor = new Date(); select(DT.todayKey()); });

    $('#calModeSeg').addEventListener('click', e => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      mode = btn.dataset.mode;
      Array.from(e.currentTarget.children).forEach(c => c.classList.toggle('active', c === btn));
      render();
    });

    const grid = $('#calGrid');
    grid.addEventListener('click', e => {
      const cell = e.target.closest('[data-day]');
      if (cell) select(cell.dataset.day);
    });
    grid.addEventListener('dblclick', e => {
      const cell = e.target.closest('[data-day]');
      if (cell) EventUI.openEditor({ date: cell.dataset.day });
    });

    $('#addEventDay').addEventListener('click', () => EventUI.openEditor({ date: selected }));

    // Shift+wheel pages the month. A plain wheel must scroll the view like it
    // does everywhere else — silently hijacking it made the panel below the
    // grid unreachable by scrolling.
    grid.addEventListener('wheel', UI.throttle(e => {
      if (!e.shiftKey || Math.abs(e.deltaY) < 8) return;
      step(e.deltaY > 0 ? 1 : -1);
    }, 220), { passive: true });

    State.on('events', render);
    State.on('todos', render);
    State.on('settings', render);
    State.on('tick:day', () => { render(); });
    State.on('tick:minute', () => { if (document.body.dataset.tab === 'calendar') renderUpcoming(); });

    // Arrow-key navigation while the calendar is the active tab.
    document.addEventListener('keydown', e => {
      if (document.body.dataset.tab !== 'calendar') return;
      if (e.target.matches('input, textarea, select, [contenteditable="true"]')) return;
      const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (moves[e.key] !== undefined) {
        e.preventDefault();
        select(DT.key(DT.addDays(DT.fromKey(selected), moves[e.key])));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        EventUI.openEditor({ date: selected });
      } else if (e.key.toLowerCase() === 't') {
        cursor = new Date();
        select(DT.todayKey());
      }
    });

    render();
  }

  global.Calendar = {
    init,
    render,
    select,
    selectedDay: () => selected,
    show: () => { render(); }
  };
}(window));
