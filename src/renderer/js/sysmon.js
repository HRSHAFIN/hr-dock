/* HR Dock — system monitor view.
   Sampling only runs while this tab is visible; leaving the tab tears the
   PowerShell helper down, so an idle widget costs nothing. */
(function (global) {
  'use strict';

  const { $, esc } = UI;

  const HISTORY = 40;
  const history = { down: [], up: [] };
  let latest = null;
  let watching = false;
  let mounted = false;

  function ringColor(percent) {
    if (percent >= 90) return 'var(--prio-critical)';
    if (percent >= 70) return 'var(--prio-high)';
    return 'var(--accent)';
  }

  function gauge(label, percent, caption, iconName) {
    const value = Math.max(0, Math.min(100, percent || 0));
    const circumference = 2 * Math.PI * 19;
    return `
      <div class="gauge">
        <div class="gauge-ring">
          <svg width="46" height="46" viewBox="0 0 46 46">
            <circle class="bg" cx="23" cy="23" r="19"></circle>
            <circle class="fg" cx="23" cy="23" r="19"
                    stroke="${ringColor(value)}"
                    stroke-dasharray="${circumference}"
                    stroke-dashoffset="${circumference * (1 - value / 100)}"></circle>
          </svg>
          <span>${Math.round(value)}</span>
        </div>
        <div class="gauge-copy">
          <b>${Icons.icon(iconName, 12)} ${esc(label)}</b>
          <small>${esc(caption)}</small>
        </div>
      </div>`;
  }

  function renderGauges(sample) {
    const host = $('#gaugeRow');
    if (!host) return;

    const tiles = [
      gauge('CPU', sample.cpu, `${sample.cores} logical cores`, 'cpu'),
      gauge('Memory', sample.memory.percent,
        `${UI.formatBytes(sample.memory.used)} of ${UI.formatBytes(sample.memory.total)}`, 'memory')
    ];

    if (sample.battery !== null) {
      tiles.push(gauge('Battery', sample.battery,
        sample.charging ? 'Charging' : 'On battery', 'battery'));
    }
    if (sample.temp !== null) {
      tiles.push(gauge('Thermals', Math.min(100, (sample.temp / 100) * 100),
        `${sample.temp.toFixed(1)} °C sensor`, 'thermometer'));
    }
    host.innerHTML = tiles.join('');
  }

  function renderDisks(sample) {
    const host = $('#diskMeters');
    if (!host) return;
    if (!sample.disks || !sample.disks.length) {
      host.innerHTML = '<div class="empty">Reading drive information…</div>';
      return;
    }
    host.innerHTML = sample.disks.map(disk => `
      <div class="meter">
        <span class="m-name">${esc(disk.name)}</span>
        <span class="m-track">
          <span class="m-fill" style="width:${disk.percent}%;background:${ringColor(disk.percent)}"></span>
        </span>
        <span class="m-val">${UI.formatBytes(disk.size - disk.used)} free</span>
      </div>`).join('');
  }

  /** Two overlaid sparklines sharing one auto-scaled axis. */
  function renderNetwork(sample) {
    const host = $('#netSpark');
    const pill = $('#netPill');
    if (!host) return;

    history.down.push(sample.net.down || 0);
    history.up.push(sample.net.up || 0);
    while (history.down.length > HISTORY) history.down.shift();
    while (history.up.length > HISTORY) history.up.shift();

    if (pill) pill.textContent = `↓ ${UI.formatRate(sample.net.down)} · ↑ ${UI.formatRate(sample.net.up)}`;

    const width = 100;
    const height = 40;
    const max = Math.max(1024, ...history.down, ...history.up);
    const count = history.down.length;
    const step = width / Math.max(1, HISTORY - 1);
    // Newest sample sits at the right edge and older ones trail off to the
    // left, so a short history hugs the present instead of stretching.
    const xAt = i => width - (count - 1 - i) * step;
    const points = series => series.map((value, i) =>
      `${xAt(i).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`).join(' ');

    const downPts = points(history.down);
    const area = count > 1
      ? `M${xAt(0).toFixed(1)},${height} L${downPts.split(' ').join(' L')} L${width},${height} Z`
      : '';

    host.innerHTML = `
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        ${area ? `<path class="down-area" d="${area}"></path>` : ''}
        <polyline class="down-line" points="${downPts}"></polyline>
        <polyline class="up-line" points="${points(history.up)}"></polyline>
      </svg>
      <div class="spark-legend">
        <span><i style="background:var(--cat-meeting)"></i>Down</span>
        <span><i style="background:var(--cat-personal)"></i>Up</span>
        <span style="margin-left:auto">peak ${UI.formatRate(max)}</span>
      </div>`;
  }

  function renderMachine(sample) {
    const host = $('#sysKv');
    if (!host) return;
    const env = State.env();
    const rows = [
      ['System', sample.host],
      ['Uptime', UI.formatDuration(sample.uptime)],
      ['Cores', String(sample.cores)],
      ['Memory', UI.formatBytes(sample.memory.total)],
      ['Widget', `v${env.version} · Electron ${env.electron}`],
      ['Backdrop', env.surface === 'acrylic' ? 'Windows acrylic' : 'CSS glass']
    ];
    host.innerHTML = rows.map(([k, v]) =>
      `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  }

  function render(sample) {
    latest = sample;
    if (!mounted || !sample) return;
    renderGauges(sample);
    renderDisks(sample);
    renderNetwork(sample);
    renderMachine(sample);
  }

  async function start() {
    if (watching) return;
    watching = true;
    const first = await hrdock.system.watch(true);
    if (first) render(first);
  }

  function stop() {
    if (!watching) return;
    watching = false;
    hrdock.system.watch(false);
  }

  function init() {
    mounted = true;
    hrdock.on('system:sample', render);

    // Follow the active tab: the monitor is the only module that costs
    // measurable CPU, so it must not run in the background.
    State.on('tab', tab => {
      if (tab === 'system' && State.settings().modules.system !== false) start();
      else stop();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (document.body.dataset.tab === 'system') start();
    });
  }

  global.SysMon = { init, start, stop, latest: () => latest };
}(window));
