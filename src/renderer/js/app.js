/* HR Dock — application shell.
   Boots the modules, owns tab routing, the Today view, the compact pane, the
   custom resize handles and the keyboard map. */
(function (global) {
  'use strict';

  const { $, $$, el, esc } = UI;

  const TAB_ICONS = {
    today: 'home', calendar: 'calendar', tasks: 'tasks', routines: 'routine',
    notes: 'note', stats: 'chart', system: 'cpu', settings: 'settings'
  };
  const TAB_ORDER = Object.keys(TAB_ICONS);

  let currentTab = 'today';

  const rememberTab = UI.debounce(tab => State.patchSettings({ lastTab: tab }), 800);

  // ------------------------------------------------------------ tab routing

  function moveIndicator() {
    const indicator = $('#tabIndicator');
    const active = $(`.tab[data-tab="${currentTab}"]`);
    if (!indicator || !active) return;
    const width = Math.max(18, active.offsetWidth - 18);
    indicator.style.width = `${width}px`;
    indicator.style.transform = `translateX(${active.offsetLeft + (active.offsetWidth - width) / 2}px)`;
  }

  function setTab(tab) {
    if (!TAB_ICONS[tab]) tab = 'today';
    currentTab = tab;
    document.body.dataset.tab = tab;

    $$('.tab').forEach(btn => btn.setAttribute('aria-selected', String(btn.dataset.tab === tab)));
    $$('.view').forEach(view => view.classList.toggle('active', view.dataset.view === tab));
    $('#views').scrollTop = 0;
    moveIndicator();

    if (tab === 'today') renderToday();
    if (tab === 'calendar') Calendar.render();
    if (tab === 'tasks') Tasks.render();
    if (tab === 'routines') Routines.render();
    if (tab === 'notes') Notes.render();
    if (tab === 'stats') Stats.render();
    if (tab === 'settings') Settings.render();

    State.emit('tab', tab);
    rememberTab(tab);
  }

  // ------------------------------------------------------------ today view

  function renderToday() {
    const settings = State.settings();
    // Compact mode hides the whole dashboard, so rebuilding it every minute
    // would be pure waste; leaving compact re-renders the active tab.
    if (settings.compact) return;
    const view = $('.view[data-view="today"]');
    const heads = view.querySelectorAll('.section-head');

    Weather.renderCard();

    const showSchedule = settings.modules.schedule !== false;
    const showTasks = settings.modules.todos !== false;

    heads[0].hidden = !showSchedule;
    $('#todayTimeline').hidden = !showSchedule;
    heads[1].hidden = !showTasks;
    $('#todayTasks').hidden = !showTasks;

    if (showSchedule) {
      EventUI.renderTimeline($('#todayTimeline'), DT.todayKey(), {
        emptyHint: 'Add an event to map out the day.'
      });
    }
    Routines.renderToday();
    if (showTasks) Tasks.renderTodayList($('#todayTasks'));
    Stats.renderFocusCard();
  }

  // --------------------------------------------------------- compact pane

  /** The single most relevant upcoming thing: an event first, else a task. */
  function nextUp() {
    const today = DT.todayKey();
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();

    const upcoming = State.Events.between(today, DT.key(DT.addDays(new Date(), 7)))
      .filter(instance => {
        if (instance.done) return false;
        if (instance.day > today) return true;
        const start = DT.toMinutes(instance.time);
        return start !== null && start >= nowMinutes;
      });
    if (upcoming.length) {
      const next = upcoming[0];
      return {
        time: next.time ? DT.formatTime(next.time, State.settings().timeFormat) : 'All day',
        title: next.title,
        color: State.categoryOf(next.category).color,
        day: next.day
      };
    }

    const task = State.Todos.all()
      .filter(t => !t.done && t.due)
      .sort((a, b) => (a.due + (a.dueTime || '99:99')).localeCompare(b.due + (b.dueTime || '99:99')))[0];
    if (task) {
      return {
        time: task.dueTime ? DT.formatTime(task.dueTime, State.settings().timeFormat) : DT.relativeDay(task.due),
        title: task.title,
        color: 'var(--accent)',
        day: task.due
      };
    }
    return null;
  }

  function renderCompact() {
    if (!State.settings().compact) return;
    const host = $('#compactNext');
    const next = nextUp();

    host.innerHTML = next
      ? `<div class="compact-next">
           <span class="dot" style="background:${next.color}"></span>
           <span class="cn-time">${esc(next.time)}</span>
           <span class="cn-title">${esc(next.title)}</span>
           ${next.day !== DT.todayKey() ? `<span style="color:var(--ink-4);font-size:10.5px">${esc(DT.relativeDay(next.day))}</span>` : ''}
         </div>`
      : `<div class="compact-next"><span class="cn-title" style="color:var(--ink-4)">Nothing scheduled</span></div>`;

    const today = DT.todayKey();
    const done = State.Stats.completionsOn(today);
    const open = State.Todos.all().filter(t => !t.done && (!t.due || t.due <= today)).length;
    const total = Math.max(1, done + open);
    $('#compactBar').style.width = `${Math.round((done / total) * 100)}%`;
    $('#compactLabel').textContent = `${done}/${total}`;
  }

  // ------------------------------------------------------------- chrome

  function syncChrome() {
    const s = State.settings();
    const pin = $('#btnPin');
    pin.innerHTML = Icons.icon('pin', 15);
    pin.setAttribute('aria-pressed', String(!!s.alwaysOnTop));
    pin.title = s.alwaysOnTop ? 'Always on top — on' : 'Always on top — off';

    const compact = $('#btnCompact');
    compact.innerHTML = Icons.icon(s.compact ? 'expand' : 'compact', 15);
    compact.title = s.compact ? 'Full dashboard  ·  Ctrl+Alt+C' : 'Compact mode  ·  Ctrl+Alt+C';

    $('#btnHelp').innerHTML = Icons.icon('info', 15);
    $('#btnSettings').innerHTML = Icons.icon('settings', 15);
    $('#btnHide').innerHTML = Icons.icon('eyeOff', 15);
    $('#btnQuit').innerHTML = Icons.icon('power', 15);

    const status = $('#chromeStatus');
    const bits = [];
    if (s.clickThrough) bits.push('click-through');
    if (s.notifications.silent) bits.push('silent');
    if (!s.alwaysOnTop) bits.push('unpinned');
    status.textContent = bits.join(' · ');
  }

  function wireChrome() {
    $('#btnPin').addEventListener('click', async () => {
      const next = !State.settings().alwaysOnTop;
      await State.patchSettings({ alwaysOnTop: next });
      syncChrome();
    });
    $('#btnCompact').addEventListener('click', () => hrdock.window.toggleCompact());
    $('#btnHelp').addEventListener('click', openHelp);
    $('#btnSettings').addEventListener('click', () => setTab('settings'));
    $('#btnHide').addEventListener('click', () => hrdock.window.hide());
    $('#btnQuit').addEventListener('click', () => quit());

    $('#addEventToday').addEventListener('click', () => EventUI.openEditor({ date: DT.todayKey() }));

    $('#tabs').addEventListener('click', e => {
      const tab = e.target.closest('.tab');
      if (tab) setTab(tab.dataset.tab);
    });

    // The compact pane is a shortcut back to the full dashboard.
    $('#compactPane').addEventListener('dblclick', () => hrdock.window.command('compact', false));

    // The header and hero are not scroll containers, so a wheel over the clock
    // or the weather chip would do nothing. Forward it to the content instead:
    // scrolling anywhere in the widget should scroll the widget.
    for (const region of [$('#chrome'), $('#hero'), $('#tabs')]) {
      region.addEventListener('wheel', e => {
        const views = $('#views');
        if (views.scrollHeight <= views.clientHeight) return;
        views.scrollTop += e.deltaY;
        e.preventDefault();
      }, { passive: false });
    }
  }

  // ------------------------------------------------------- help & welcome

  const HELP = [
    ['Getting around', [
      ['Move the widget', 'Drag the top strip or the clock'],
      ['Resize', 'Drag any edge or corner'],
      ['Hide it', 'The ⦸ button, Esc, or Ctrl+Alt+A'],
      ['Bring it back', 'Tray icon, or Ctrl+Alt+A'],
      ['Close completely', 'The ⏻ button — stops reminders too']
    ]],
    ['Shortcuts', [
      ['Ctrl+1 … 8', 'Jump to a tab'],
      ['Ctrl+N', 'New task'],
      ['Ctrl+E', 'New event'],
      ['Ctrl+F', 'Search notes'],
      ['Ctrl+Alt+C', 'Compact mode'],
      ['Arrows / T', 'Move the calendar, jump to today'],
      ['Shift+wheel', 'Page months on the calendar']
    ]],
    ['Typing a task quickly', [
      ['report tomorrow', 'Due tomorrow'],
      ['call bank friday 5pm', 'Due Friday at 17:00'],
      ['pay rent in 3 days', 'Due three days out'],
      ['!high  !critical  !low', 'Set the priority'],
      ['#work  #health  #study', 'Set the category'],
      ['water plants every week', 'Repeats — rolls forward when done']
    ]]
  ];

  function openHelp() {
    const body = el('div', { class: 'help' });
    for (const [heading, rows] of HELP) {
      body.appendChild(el('h4', { text: heading }));
      const table = el('div', { class: 'help-rows' });
      for (const [key, meaning] of rows) {
        table.appendChild(el('div', { class: 'help-row' }, [
          el('code', { text: key }),
          el('span', { text: meaning })
        ]));
      }
      body.appendChild(table);
    }
    UI.modal({
      title: 'How to use HR Dock',
      body,
      actions: [
        { spacer: true },
        { label: 'Got it', primary: true, onClick: close => close(true) }
      ]
    });
  }

  /**
   * A widget with no title bar and no taskbar button needs to say so once.
   * Shown a single time, then never again.
   */
  function maybeWelcome() {
    if (State.settings().onboarded) return;

    const body = el('div', { class: 'welcome' });
    body.innerHTML = `
      <p>This is your desktop dashboard — clock, calendar, tasks, routines,
         weather and notes in one place. Three things worth knowing:</p>
      <ul>
        <li><b>It has no taskbar button.</b> Use the tray icon or
            <span class="kbd">Ctrl</span>+<span class="kbd">Alt</span>+<span class="kbd">A</span> to show and hide it.</li>
        <li><b>Drag it anywhere</b> by the top strip; it remembers where you put it
            and snaps to screen edges.</li>
        <li><b>Hiding is not closing.</b> The ⦸ button hides and keeps reminders
            running; the ⏻ button shuts everything down.</li>
      </ul>`;

    UI.modal({
      title: 'Welcome to HR Dock',
      body,
      actions: [
        {
          label: 'Start with Windows',
          onClick: async close => {
            await hrdock.autostart.set(true);
            await State.patchSettings({ onboarded: true });
            UI.toast({ kind: 'success', title: 'HR Dock will start with Windows' });
            close(true);
            openHelp();
          }
        },
        { spacer: true },
        {
          label: 'Show me around',
          primary: true,
          onClick: close => {
            State.patchSettings({ onboarded: true });
            close(true);
            openHelp();
          }
        }
      ],
      onClose: () => State.patchSettings({ onboarded: true })
    });
  }

  /**
   * Shut the app down for real — not just hide the window.
   * Hiding is the everyday action, so quitting asks first and says plainly
   * what stops working, since a closed HR Dock fires no reminders.
   */
  async function quit() {
    const ok = await UI.confirm(
      'Close HR Dock?',
      'The widget and its background services will shut down completely, so '
      + 'reminders will not fire until you open it again. Your data is saved.',
      'Close HR Dock');
    if (!ok) return;
    Notes.flush();
    State.flushAll();
    hrdock.window.quit();
  }

  // ------------------------------------------------------- resize handles

  /**
   * Frameless windows get no OS resize border, so the eight handles drive
   * setBounds directly from pointer deltas in screen coordinates.
   */
  function wireResize() {
    for (const handle of $$('.rz')) {
      handle.addEventListener('pointerdown', async e => {
        e.preventDefault();
        const state = await hrdock.window.state();
        if (!state) return;

        const edge = handle.dataset.edge;
        // Pointer origin and window origin are both screen-space but must stay
        // separate: `px/py` track the mouse, `x/y/width/height` the window.
        const start = { px: e.screenX, py: e.screenY, ...state.bounds };
        const min = State.settings().compact ? { w: 260, h: 120 } : { w: 380, h: 460 };
        handle.setPointerCapture(e.pointerId);

        const onMove = ev => {
          const dx = ev.screenX - start.px;
          const dy = ev.screenY - start.py;
          let width = start.width;
          let height = start.height;
          let x = start.x;
          let y = start.y;

          if (edge.includes('e')) width = Math.max(min.w, start.width + dx);
          if (edge.includes('s')) height = Math.max(min.h, start.height + dy);
          if (edge.includes('w')) {
            width = Math.max(min.w, start.width - dx);
            x = start.x + (start.width - width);
          }
          if (edge.includes('n')) {
            height = Math.max(min.h, start.height - dy);
            y = start.y + (start.height - height);
          }
          hrdock.window.setBounds({ x, y, width, height });
        };

        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          try { handle.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
          moveIndicator();
        };

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });
    }
  }

  // ---------------------------------------------------------- keyboard map

  function wireKeyboard() {
    document.addEventListener('keydown', e => {
      const typing = e.target.matches('input, textarea, select, [contenteditable="true"]');

      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key >= '1' && e.key <= '8') {
        e.preventDefault();
        setTab(TAB_ORDER[Number(e.key) - 1]);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !typing) {
        e.preventDefault();
        setTab('tasks');
        $('#taskInput').focus();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'e' && !typing) {
        e.preventDefault();
        EventUI.openEditor({ date: currentTab === 'calendar' ? Calendar.selectedDay() : DT.todayKey() });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setTab('notes');
        $('#noteSearch').focus();
        return;
      }
      if (e.key === 'Escape' && !typing && $('#modalRoot').hidden && Notes.isEditing() === false) {
        hrdock.window.hide();
      }
    });
  }

  // ------------------------------------------------------------ bootstrap

  async function init() {
    await State.init();

    // Paint tab glyphs before anything measures them.
    for (const tab of $$('.tab')) {
      tab.querySelector('.tab-icon').innerHTML = Icons.icon(TAB_ICONS[tab.dataset.tab], 17);
    }

    Clock.init();
    Weather.init();
    Calendar.init();
    Tasks.init();
    Routines.init();
    Notes.init();
    Stats.init();
    SysMon.init();
    Settings.init();
    Notify.init();

    wireChrome();
    wireResize();
    wireKeyboard();
    syncChrome();

    setTab(State.settings().lastTab || 'today');
    renderCompact();
    setTimeout(maybeWelcome, 900);   // let the first paint land before greeting

    // Keep derived surfaces fresh without every module polling on its own.
    State.on('events', () => { if (currentTab === 'today') renderToday(); renderCompact(); });
    State.on('todos', () => { if (currentTab === 'today') renderToday(); renderCompact(); });
    State.on('stats', renderCompact);
    State.on('settings', () => { syncChrome(); if (currentTab === 'today') renderToday(); renderCompact(); });
    State.on('tick:minute', () => { if (currentTab === 'today') renderToday(); renderCompact(); });
    State.on('tick:day', () => { renderToday(); renderCompact(); });

    hrdock.on('state:changed', payload => {
      document.body.dataset.compact = String(!!payload.compact);
      State.settings().compact = !!payload.compact;
      syncChrome();
      renderCompact();
      // Returning to the full dashboard: repaint whatever tab was left behind.
      if (!payload.compact) setTab(currentTab);
      requestAnimationFrame(moveIndicator);
    });

    window.addEventListener('resize', UI.throttle(moveIndicator, 80));
    window.addEventListener('beforeunload', () => { Notes.flush(); State.flushAll(); });

    // Reveal only once the first paint is genuinely ready.
    requestAnimationFrame(() => { document.body.classList.add('ready'); moveIndicator(); });
  }

  global.App = { init, setTab, renderToday, renderCompact, quit, openHelp, currentTab: () => currentTab };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}(window));
