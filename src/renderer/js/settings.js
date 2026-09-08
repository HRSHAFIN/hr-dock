/* HR Dock — settings panel.
   Rendered from a declarative description so every control writes back through
   the same patch path and the panel can re-render itself after any change. */
(function (global) {
  'use strict';

  const { $, el, esc } = UI;

  const ACCENTS = ['#5b8cff', '#7c6cff', '#b48cff', '#ff6fa5', '#ff8a5b', '#f5c451', '#3fc79a', '#4fc9e8'];
  let mounted = false;
  let placeResults = [];

  const patch = p => State.patchSettings(p);

  // ------------------------------------------------------------- builders

  function group(title, rows) {
    return el('div', { class: 'set-group' }, [el('h2', { text: title })].concat(rows));
  }

  function row(label, description, control, extraClass) {
    return el('div', { class: `set-row${extraClass ? ' ' + extraClass : ''}` }, [
      el('div', { class: 'set-copy' }, [
        el('b', { text: label }),
        description ? el('small', { text: description }) : null
      ]),
      el('div', { class: 'set-control' }, [].concat(control))
    ]);
  }

  function toggle(checked, onChange) {
    const btn = el('button', {
      class: 'switch', role: 'switch', 'aria-checked': String(!!checked),
      onClick: () => {
        const next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        onChange(next);
      }
    });
    return btn;
  }

  function segmented(options, value, onPick) {
    const wrap = el('div', { class: 'seg' });
    for (const opt of options) {
      wrap.appendChild(el('button', {
        type: 'button',
        class: opt.id === value ? 'active' : '',
        text: opt.label,
        onClick: e => {
          Array.from(wrap.children).forEach(c => c.classList.toggle('active', c === e.currentTarget));
          onPick(opt.id);
        }
      }));
    }
    return wrap;
  }

  function select(options, value, onChange) {
    const node = el('select', { class: 'mini-select', onChange: e => onChange(e.target.value) });
    for (const opt of options) {
      node.appendChild(el('option', { value: opt.id, text: opt.label, selected: String(opt.id) === String(value) }));
    }
    return node;
  }

  function range(min, max, step, value, onInput, format) {
    const label = el('span', { class: 'mini-label', text: format(value) });
    const input = el('input', {
      type: 'range', min, max, step, value,
      onInput: e => { label.textContent = format(Number(e.target.value)); },
      onChange: e => onInput(Number(e.target.value))
    });
    return [input, label];
  }

  // --------------------------------------------------------------- panels

  function appearance(s) {
    const swatches = el('div', { class: 'swatches' });
    for (const color of ACCENTS) {
      swatches.appendChild(el('button', {
        class: `swatch${s.accent === color ? ' active' : ''}`,
        style: { background: color },
        title: color,
        onClick: async () => { await patch({ accent: color }); render(); }
      }));
    }

    return group('Appearance', [
      row('Theme', 'Auto follows the Windows light/dark setting.',
        segmented([
          { id: 'auto', label: 'Auto' }, { id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }
        ], s.theme, v => patch({ theme: v }))),

      row('Accent colour', 'Used for highlights, progress and the active tab.', swatches),

      row('Backdrop', 'Acrylic uses the Windows 11 blur; glass paints its own.',
        segmented([
          { id: 'auto', label: 'Auto' }, { id: 'acrylic', label: 'Acrylic' }, { id: 'glass', label: 'Glass' }
        ], s.surface, v => {
          patch({ surface: v });
          UI.toast({ title: 'Backdrop changed', message: 'The widget reloads to apply it.', timeout: 2600 });
        })),

      row('Opacity', 'How solid the whole widget appears.',
        range(40, 100, 5, Math.round((s.opacity || 1) * 100),
          v => patch({ opacity: v / 100 }), v => `${v}%`)),

      row('Compact mode', 'Shrink to clock, weather and your next commitment.',
        toggle(s.compact, v => hrdock.window.command('compact', v)))
    ]);
  }

  function behaviour(s) {
    return group('Widget behaviour', [
      row('Always on top', 'Keeps HR Dock above ordinary windows, below full-screen apps.',
        toggle(s.alwaysOnTop, v => patch({ alwaysOnTop: v }))),

      row('Click-through', 'Mouse events pass to whatever is underneath. Toggle back from the tray.',
        toggle(s.clickThrough, v => {
          patch({ clickThrough: v });
          if (v) {
            UI.toast({
              title: 'Click-through on',
              message: 'Use the tray icon or Ctrl+Alt+A to interact again.',
              timeout: 5000
            });
          }
        })),

      row('Start with Windows', 'Launch HR Dock automatically when you sign in.',
        toggle(s.autostart, async v => {
          const enabled = await hrdock.autostart.set(v);
          UI.toast({
            kind: 'success',
            title: enabled ? 'HR Dock will start with Windows' : 'Autostart disabled',
            timeout: 2400
          });
        })),

      row('Start hidden', 'When launched at sign-in, stay in the tray until called.',
        toggle(s.startMinimised, v => patch({ startMinimised: v }))),

      row('Position', 'Snap back if the widget ends up somewhere awkward.', [
        el('button', { class: 'ghost-btn', text: 'Centre', onClick: () => hrdock.window.command('center') }),
        el('button', { class: 'ghost-btn', text: 'Reset', onClick: () => hrdock.window.command('resetPosition') })
      ]),

      row('Hide vs close',
        'The ⦸ button hides the widget and leaves reminders running. Closing shuts '
        + 'everything down — no tray icon, no reminders — until you launch it again.',
        el('button', { class: 'ghost-btn danger', text: 'Close HR Dock', onClick: () => App.quit() }))
    ]);
  }

  function timeAndCalendar(s) {
    return group('Clock & calendar', [
      row('Time format', null,
        segmented([{ id: '24', label: '24-hour' }, { id: '12', label: '12-hour' }],
          String(s.timeFormat), v => patch({ timeFormat: Number(v) }))),

      row('Show seconds', 'Turn off to update the clock once a minute.',
        toggle(s.showSeconds !== false, v => patch({ showSeconds: v }))),

      row('Week starts on', null,
        select([{ id: '1', label: 'Monday' }, { id: '0', label: 'Sunday' }, { id: '6', label: 'Saturday' }],
          String(s.firstDayOfWeek), v => patch({ firstDayOfWeek: Number(v) })))
    ]);
  }

  function weatherSection(s) {
    const w = s.weather;
    const searchInput = el('input', { type: 'search', placeholder: 'Search for a city…' });
    const results = el('div', { class: 'place-results' });

    const runSearch = UI.debounce(async value => {
      if (!value || value.trim().length < 2) { results.innerHTML = ''; return; }
      results.innerHTML = '<div class="place-item">Searching…</div>';
      placeResults = await hrdock.weather.search(value);
      results.innerHTML = '';
      if (!placeResults.length) {
        results.innerHTML = '<div class="place-item">No matches found</div>';
        return;
      }
      for (const place of placeResults) {
        results.appendChild(el('button', {
          class: 'place-item',
          onClick: async () => {
            await patch({ weather: { auto: false, place } });
            await Weather.refresh(true);
            render();
            UI.toast({ kind: 'success', title: `Weather set to ${place.name}` });
          }
        }, [
          el('span', { text: place.name }),
          el('small', { text: [place.admin, place.country].filter(Boolean).join(', ') })
        ]));
      }
    }, 420);

    searchInput.addEventListener('input', e => runSearch(e.target.value));

    const current = Weather.current();
    const placeLabel = w.auto
      ? (current && current.place ? `Detected: ${current.place.name}` : 'Detecting from your connection')
      : (w.place ? `${w.place.name}${w.place.country ? ', ' + w.place.country : ''}` : 'None selected');

    const rows = [
      row('Show weather', 'Hide the weather card and hero chip entirely.',
        toggle(s.modules.weather !== false, v => { patch({ modules: { weather: v } }); Weather.renderCard(); })),

      row('Units', null,
        segmented([{ id: 'c', label: '°C' }, { id: 'f', label: '°F' }], w.unit,
          async v => { await patch({ weather: { unit: v } }); Weather.refresh(true); })),

      row('Detailed view', 'Sunrise, pressure, hourly strip and the five-day outlook.',
        toggle(w.detailed !== false, v => { patch({ weather: { detailed: v } }); Weather.renderCard(); })),

      row('Automatic location', placeLabel,
        toggle(w.auto, async v => {
          await patch({ weather: { auto: v } });
          await Weather.refresh(true);
          render();
        })),

      row('Refresh every', null,
        select([15, 30, 60, 120].map(m => ({ id: String(m), label: m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} minutes` })),
          String(w.refreshMinutes || 30), v => patch({ weather: { refreshMinutes: Number(v) } })))
    ];

    if (!w.auto) {
      rows.push(el('div', { class: 'set-row stack' }, [
        el('div', { class: 'set-copy' }, [
          el('b', { text: 'Manual location' }),
          el('small', { text: 'Search any city worldwide.' })
        ]),
        el('div', { class: 'set-control' }, [searchInput]),
        results
      ]));
    }

    return group('Weather', rows);
  }

  function notifications(s) {
    const n = s.notifications;
    return group('Reminders & notifications', [
      row('Enable reminders', 'Event, task and birthday alerts.',
        toggle(n.enabled, v => patch({ notifications: { enabled: v } }))),

      row('Sound', 'Play a short chime with each reminder.',
        toggle(n.sound, v => patch({ notifications: { sound: v } }))),

      row('Silent mode', 'Keep in-app cards but suppress desktop toasts and sound.',
        toggle(n.silent, v => patch({ notifications: { silent: v } }))),

      row('Default lead time', 'Used when an item says "remind me" without a specific offset.',
        select([0, 5, 10, 15, 30, 60].map(m => ({ id: String(m), label: m === 0 ? 'At the time' : `${m} minutes before` })),
          String(n.defaultLeadMinutes), v => patch({ notifications: { defaultLeadMinutes: Number(v) } }))),

      row('Snooze length', null,
        select([5, 10, 15, 30].map(m => ({ id: String(m), label: `${m} minutes` })),
          String(n.snoozeMinutes), v => patch({ notifications: { snoozeMinutes: Number(v) } }))),

      row('Test it', 'Fire a sample reminder right now.',
        el('button', { class: 'ghost-btn', text: 'Send test', onClick: () => hrdock.reminders.test() }))
    ]);
  }

  function modules(s) {
    return group('Modules', [
      row('System monitor', 'CPU, memory, disks, network and battery.',
        toggle(s.modules.system !== false, v => patch({ modules: { system: v } }))),
      row('Schedule on Today', 'Show the day timeline in the Today view.',
        toggle(s.modules.schedule !== false, v => { patch({ modules: { schedule: v } }); App.renderToday(); })),
      row('Focus tasks on Today', null,
        toggle(s.modules.todos !== false, v => { patch({ modules: { todos: v } }); App.renderToday(); }))
    ]);
  }

  function dataSection() {
    const env = State.env();
    const backupsHost = el('div', { class: 'place-results' });

    async function listBackups() {
      const list = await hrdock.data.backups();
      backupsHost.innerHTML = '';
      if (!list.length) {
        backupsHost.appendChild(el('div', { class: 'place-item', text: 'No backups yet' }));
        return;
      }
      for (const backup of list.slice(0, 6)) {
        backupsHost.appendChild(el('button', {
          class: 'place-item',
          onClick: async () => {
            const ok = await UI.confirm('Restore backup',
              `Replace all current data with the snapshot from ${new Date(backup.mtime).toLocaleString()}? A safety backup of the current data is taken first.`,
              'Restore');
            if (!ok) return;
            const res = await hrdock.data.import(backup.path);
            if (res.ok) UI.toast({ kind: 'success', title: 'Backup restored' });
            else UI.toast({ kind: 'error', title: 'Restore failed', message: res.error });
          }
        }, [
          el('span', { text: new Date(backup.mtime).toLocaleString() }),
          el('small', { text: UI.formatBytes(backup.size) })
        ]));
      }
    }

    const rows = [
      row('Backup now', 'Keeps the ten most recent snapshots locally.',
        el('button', {
          class: 'ghost-btn', text: 'Create backup',
          onClick: async () => {
            State.flushAll();
            const res = await hrdock.data.backup();
            if (res.ok) { UI.toast({ kind: 'success', title: 'Backup created' }); listBackups(); }
            else UI.toast({ kind: 'error', title: 'Backup failed', message: res.error });
          }
        })),

      row('Export / import', 'A single JSON file with every setting, event, task and note.', [
        el('button', {
          class: 'ghost-btn', text: 'Export',
          onClick: async () => {
            State.flushAll();
            const res = await hrdock.data.export();
            if (res.ok) UI.toast({ kind: 'success', title: 'Exported', message: res.path });
            else if (!res.cancelled) UI.toast({ kind: 'error', title: 'Export failed', message: res.error });
          }
        }),
        el('button', {
          class: 'ghost-btn', text: 'Import',
          onClick: async () => {
            const ok = await UI.confirm('Import data',
              'This replaces everything currently in HR Dock. A backup of your current data is taken first.',
              'Import');
            if (!ok) return;
            const res = await hrdock.data.import(null);
            if (res.ok) UI.toast({ kind: 'success', title: 'Data imported' });
            else if (!res.cancelled) UI.toast({ kind: 'error', title: 'Import failed', message: res.error });
          }
        })
      ]),

      row('Storage', env.userData,
        el('button', { class: 'ghost-btn', text: 'Open folder', onClick: () => hrdock.data.reveal() })),

      el('div', { class: 'set-row stack' }, [
        el('div', { class: 'set-copy' }, [
          el('b', { text: 'Restore a backup' }),
          el('small', { text: 'Pick a snapshot to roll back to.' })
        ]),
        backupsHost
      ])
    ];

    listBackups();
    return group('Data', rows);
  }

  function about() {
    const env = State.env();
    const counts = `${State.Events.all().length} events · ${State.Todos.all().length} tasks · ${State.Notes.all().length} notes`;
    return group('About', [
      el('div', {
        class: 'about',
        html: `
          <b>HR Dock ${esc(env.version)}</b> — a local-first desktop dashboard.<br>
          ${esc(counts)}<br><br>
          <b>Shortcuts</b><br>
          <span class="kbd">Ctrl</span>+<span class="kbd">Alt</span>+<span class="kbd">A</span> show or hide ·
          <span class="kbd">Ctrl</span>+<span class="kbd">Alt</span>+<span class="kbd">C</span> compact mode<br>
          <span class="kbd">Ctrl</span>+<span class="kbd">1…7</span> switch tabs ·
          <span class="kbd">Ctrl</span>+<span class="kbd">N</span> new task ·
          <span class="kbd">Ctrl</span>+<span class="kbd">E</span> new event<br>
          Arrow keys move the calendar selection; <span class="kbd">T</span> jumps to today.<br><br>
          Weather data by Open-Meteo. Data is stored only on this machine —
          nothing is uploaded, and the only network request is the weather lookup.`
      })
    ]);
  }

  function render() {
    if (!mounted) return;
    const host = $('#settings');
    const s = State.settings();
    const scroll = $('#views').scrollTop;

    host.innerHTML = '';
    host.appendChild(appearance(s));
    host.appendChild(behaviour(s));
    host.appendChild(timeAndCalendar(s));
    host.appendChild(weatherSection(s));
    host.appendChild(notifications(s));
    host.appendChild(modules(s));
    host.appendChild(dataSection());
    host.appendChild(about());

    if (document.body.dataset.tab === 'settings') $('#views').scrollTop = scroll;
  }

  function init() {
    mounted = true;
    render();
    // Re-render only when settings actually change, not on every data write.
    State.on('settings', UI.debounce(() => {
      if (document.body.dataset.tab === 'settings') render();
    }, 200));
  }

  global.Settings = { init, render };
}(window));
