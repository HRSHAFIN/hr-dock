/* HR Dock — productivity insights and the focus timer.
   Every number here is derived from data the user actually created; nothing is
   simulated, and the weekly score is spelled out in the tooltip so it can be
   argued with rather than just displayed. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  let mounted = false;

  // ---------------------------------------------------------- focus timer

  const focus = {
    running: false,
    startedAt: 0,
    carried: 0,        // seconds accumulated but not yet written to disk
    timer: null
  };

  function focusElapsed() {
    return focus.carried + (focus.running ? Math.floor((Date.now() - focus.startedAt) / 1000) : 0);
  }

  function flushFocus() {
    const seconds = focusElapsed();
    if (seconds > 0) State.Stats.addFocusTime(seconds);
    focus.carried = 0;
    focus.startedAt = Date.now();
  }

  function startFocus() {
    if (focus.running) return;
    focus.running = true;
    focus.startedAt = Date.now();
    focus.timer = setInterval(() => {
      renderFocusCard();
      // Persist once a minute so a crash costs at most 60 seconds of credit.
      if (focusElapsed() >= 60) flushFocus();
    }, 1000);
    renderFocusCard();
  }

  function pauseFocus() {
    if (!focus.running) return;
    focus.carried = focusElapsed();
    focus.running = false;
    clearInterval(focus.timer);
    focus.timer = null;
    flushFocus();
    focus.carried = 0;
    renderFocusCard();
  }

  function resetFocus() {
    pauseFocus();
    focus.carried = 0;
    renderFocusCard();
  }

  function renderFocusCard() {
    const card = $('#focusCard');
    // The focus timer ticks every second; only paint it when Today is visible.
    if (!card || !State.isActiveTab('today')) return;

    const todaySeconds = State.Stats.focusOn(DT.todayKey()) + (focus.running ? focusElapsed() : 0);
    const session = focusElapsed();
    const mm = String(Math.floor(session / 60)).padStart(2, '0');
    const ss = String(session % 60).padStart(2, '0');

    card.innerHTML = `
      <div class="focus-time">${mm}:${ss}</div>
      <div class="focus-copy">
        <b>Focus session</b>
        <p>${UI.formatDuration(todaySeconds)} focused today</p>
      </div>`;

    const controls = el('div', { style: { display: 'flex', gap: '4px' } }, [
      el('button', {
        class: 'icon-btn',
        title: focus.running ? 'Pause focus' : 'Start focus',
        html: Icons.icon(focus.running ? 'pause' : 'play', 15),
        onClick: () => (focus.running ? pauseFocus() : startFocus())
      }),
      el('button', {
        class: 'icon-btn', title: 'Reset session', html: Icons.icon('reset', 15),
        onClick: resetFocus
      })
    ]);
    card.appendChild(controls);
  }

  // ------------------------------------------------------------- insights

  function lastDays(count) {
    const out = [];
    for (let i = count - 1; i >= 0; i--) {
      const date = DT.addDays(new Date(), -i);
      out.push({ date, key: DT.key(date) });
    }
    return out;
  }

  function weeklyScore() {
    const week = lastDays(7);
    const completed = week.reduce((sum, d) => sum + State.Stats.completionsOn(d.key), 0);
    const focusHours = week.reduce((sum, d) => sum + State.Stats.focusOn(d.key), 0) / 3600;
    const today = DT.todayKey();
    const outstanding = State.Todos.all().filter(t => !t.done && t.due && t.due <= today).length;
    const planned = Math.max(1, completed + outstanding);
    const rate = completed / planned;
    const score = Math.round(Math.min(100, rate * 70 + Math.min(30, focusHours * 5)));
    const label = score >= 80 ? 'Excellent' : score >= 60 ? 'Strong' : score >= 40 ? 'Steady' : score > 0 ? 'Building' : 'Idle';
    return { score, label, completed, focusHours, outstanding };
  }

  function statTile(value, label, extra) {
    return `<div class="stat">
      <b>${esc(value)}</b>
      <span>${esc(label)}</span>
      ${extra ? `<div class="delta ${esc(extra.tone || '')}">${esc(extra.text)}</div>` : ''}
    </div>`;
  }

  function renderGrid() {
    const host = $('#statGrid');
    if (!host) return;
    const today = DT.todayKey();
    const todos = State.Todos.all();
    const openCount = todos.filter(t => !t.done).length;
    const doneToday = State.Stats.completionsOn(today);
    const doneYesterday = State.Stats.completionsOn(DT.key(DT.addDays(new Date(), -1)));
    const streak = State.Stats.get().streak;
    const score = weeklyScore();
    const overdue = todos.filter(t => !t.done && t.due && t.due < today).length;

    const delta = doneToday - doneYesterday;
    host.innerHTML = [
      statTile(String(doneToday), 'Completed today', {
        text: delta === 0 ? 'Same as yesterday' : `${delta > 0 ? '+' : ''}${delta} vs yesterday`,
        tone: delta > 0 ? 'up' : delta < 0 ? 'down' : ''
      }),
      statTile(String(openCount), 'Open tasks', overdue
        ? { text: `${UI.plural(overdue, 'overdue task')}`, tone: 'down' }
        : { text: 'Nothing overdue', tone: 'up' }),
      statTile(`${score.score}`, 'Weekly score', { text: score.label }),
      statTile(`${streak.current}d`, 'Current streak', { text: `Best ${streak.best}d` })
    ].join('');

    const pill = $('#weekScore');
    if (pill) {
      pill.textContent = `${score.completed} done · ${UI.formatDuration(score.focusHours * 3600)} focus`;
      pill.title = 'Weekly score = completion rate (70 pts) + focused time (30 pts, 5 per hour)';
    }
  }

  function renderWeekBars() {
    const host = $('#weekBars');
    if (!host) return;
    const days = lastDays(7).map(d => ({ ...d, value: State.Stats.completionsOn(d.key) }));
    const max = Math.max(1, ...days.map(d => d.value));
    const today = DT.todayKey();

    host.innerHTML = days.map(d => `
      <div class="bar-col${d.key === today ? ' today' : ''}" title="${esc(DT.relativeDay(d.key))}: ${UI.plural(d.value, 'task')}">
        <span class="bar-val">${d.value || ''}</span>
        <span class="bar-track"><span class="bar-fill" style="height:${(d.value / max) * 100}%"></span></span>
        <small>${esc(DT.DAY_NAMES[d.date.getDay()].slice(0, 1))}</small>
      </div>`).join('');
  }

  function renderMonthHeat() {
    const host = $('#monthHeat');
    if (!host) return;
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    let cells = DT.monthGrid(first, Number(State.settings().firstDayOfWeek) || 0);
    // The grid is always six weeks; drop a trailing week that belongs entirely
    // to the next month rather than leaving a blank band.
    while (cells.length > 28 && cells.slice(-7).every(d => d.getMonth() !== now.getMonth())) {
      cells = cells.slice(0, -7);
    }
    const today = DT.todayKey();
    let monthTotal = 0;

    // Column headings make the grid readable as a month rather than a blob.
    const labels = document.querySelector('#monthHeat').previousElementSibling;
    if (labels && labels.classList.contains('heat-days')) labels.remove();
    const weekStart = Number(State.settings().firstDayOfWeek) || 0;
    const head = document.createElement('div');
    head.className = 'heat-days';
    head.innerHTML = [0, 1, 2, 3, 4, 5, 6]
      .map(i => '<span>' + DT.DAY_NAMES[(weekStart + i) % 7].slice(0, 1) + '</span>').join('');
    host.parentNode.insertBefore(head, host);

    host.innerHTML = cells.map(date => {
      const key = DT.key(date);
      const inMonth = date.getMonth() === now.getMonth();
      const value = State.Stats.completionsOn(key);
      if (inMonth) monthTotal += value;
      const level = value === 0 ? 0 : value < 2 ? 1 : value < 4 ? 2 : value < 7 ? 3 : 4;
      const classes = [];
      if (!inMonth || key > today) classes.push('future');
      return `<i data-l="${level}" class="${classes.join(' ')}" title="${esc(key)}: ${UI.plural(value, 'task')}"></i>`;
    }).join('');

    const meta = $('#monthMeta');
    if (meta) {
      const monthPrefix = today.slice(0, 7);
      const activeDays = Object.keys(State.Stats.get().completions)
        .filter(k => k.slice(0, 7) === monthPrefix && State.Stats.completionsOn(k) > 0).length;
      meta.textContent = `${UI.plural(monthTotal, 'task')} · ${UI.plural(activeDays, 'active day')}`;
    }
  }

  function renderBreakdown() {
    const host = $('#catBreakdown');
    if (!host) return;
    const open = State.Todos.all().filter(t => !t.done);
    const counts = new Map();
    for (const todo of open) {
      const id = todo.category || 'general';
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    if (!counts.size) {
      host.innerHTML = '<div class="empty"><strong>No open tasks</strong>Nothing to break down.</div>';
      return;
    }
    const max = Math.max(...counts.values());
    host.innerHTML = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => {
        const cat = State.categoryOf(id);
        return `<div class="bd-row">
          <span class="bd-name">${esc(cat.label)}</span>
          <span class="bd-track"><span class="bd-fill" style="width:${(count / max) * 100}%;background:${cat.color}"></span></span>
          <span class="bd-val">${count}</span>
        </div>`;
      }).join('');
  }

  function render() {
    if (!mounted) return;
    if (!State.isActiveTab('stats')) return;
    renderGrid();
    renderWeekBars();
    renderMonthHeat();
    renderBreakdown();
  }

  function init() {
    mounted = true;
    renderFocusCard();

    State.on('todos', () => { render(); });
    State.on('stats', () => { render(); renderFocusCard(); });
    State.on('tick:day', render);
    State.on('settings', render);

    // Don't lose an in-flight focus session when the widget closes.
    window.addEventListener('beforeunload', () => { if (focus.running) flushFocus(); });

    render();
  }

  global.Stats = {
    init,
    render,
    renderFocusCard,
    focusRunning: () => focus.running,
    weeklyScore
  };
}(window));
