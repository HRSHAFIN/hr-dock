/* HR Dock — system monitor view.

   Sampling only runs while this tab is visible; leaving the tab tears the
   PowerShell helper down, so an idle widget costs nothing.

   The panel is built once and then patched. A sample lands every two seconds,
   and rebuilding a screenful of hardware readouts at that rate would throw
   away the user's scroll position and any text they were trying to select, to
   redraw text that mostly did not change. `build()` lays out the structure,
   `update()` writes the handful of numbers that moved. */
(function (global) {
  'use strict';

  const { $, esc } = UI;

  const HISTORY = 60;
  const series = { cpu: [], mem: [], gpu: [], vram: [], down: [], up: [], read: [], write: [] };

  let latest = null;
  let inventory = null;
  let watching = false;
  let mounted = false;
  let built = false;
  let speedRunning = false;

  const refs = {};

  // ---------------------------------------------------------------- helpers

  const setText = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
  };

  const push = (key, value) => {
    const list = series[key];
    list.push(Number.isFinite(value) ? value : 0);
    while (list.length > HISTORY) list.shift();
  };

  function ringColor(percent) {
    if (percent >= 90) return 'var(--prio-critical)';
    if (percent >= 70) return 'var(--prio-high)';
    return 'var(--accent)';
  }

  /** A degree reading, or an honest blank when the hardware will not say. */
  const degrees = v => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}°C` : '—');
  const mhz = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? `${Math.round(v)} MHz` : '—');
  const pct = v => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—');

  /** MB/s, because that is the unit a download is actually read in. */
  const rate = bytesPerSec => {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 1) return '0.00 MB/s';
    return `${(bytesPerSec / 1048576).toFixed(2)} MB/s`;
  };

  const mbps = v => (Number.isFinite(v) ? `${v >= 100 ? Math.round(v) : v.toFixed(1)}` : '—');

  /**
   * Redraw one sparkline in place. Only the path data changes, so the SVG and
   * its nodes survive from sample to sample.
   */
  function drawSpark(svg, sets, floor) {
    if (!svg) return;
    const width = 100;
    const height = 40;
    const all = sets.flatMap(s => s.data);
    const max = Math.max(floor || 1, ...all);
    const count = Math.max(...sets.map(s => s.data.length), 1);
    const step = width / Math.max(1, HISTORY - 1);
    // Newest sample sits at the right edge so a short history hugs the present
    // rather than stretching to fill the box.
    const xAt = i => width - (count - 1 - i) * step;

    for (const set of sets) {
      const line = svg.querySelector(`.${set.cls}-line`);
      const area = svg.querySelector(`.${set.cls}-area`);
      const points = set.data
        .map((value, i) => `${xAt(i).toFixed(1)},${(height - (value / max) * height).toFixed(1)}`);
      if (line) line.setAttribute('points', points.join(' '));
      if (area) {
        area.setAttribute('d', points.length > 1
          ? `M${xAt(0).toFixed(1)},${height} L${points.join(' L')} L${width},${height} Z`
          : '');
      }
    }
    return max;
  }

  const sparkSvg = classes => `
    <svg class="spark-svg" viewBox="0 0 100 40" preserveAspectRatio="none">
      ${classes.map(c => `<path class="${c}-area"></path>`).join('')}
      ${classes.map(c => `<polyline class="${c}-line"></polyline>`).join('')}
    </svg>`;

  const row = (label, id) =>
    `<dt>${esc(label)}</dt><dd data-ref="${id}">—</dd>`;

  // ------------------------------------------------------------ the gauges

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
      gauge('CPU', sample.cpu, sample.cpuMhz ? `${(sample.cpuMhz / 1000).toFixed(2)} GHz` : `${sample.cores} threads`, 'cpu'),
      gauge('Memory', sample.memory.percent,
        `${UI.formatBytes(sample.memory.used)} of ${UI.formatBytes(sample.memory.total)}`, 'memory')
    ];

    if (sample.gpu && typeof sample.gpu.util === 'number') {
      const g = sample.gpu;
      tiles.push(gauge('GPU', g.util,
        typeof g.temp === 'number' ? `${Math.round(g.temp)}°C` : 'usage', 'gpu'));
    }
    if (sample.battery !== null) {
      tiles.push(gauge('Battery', sample.battery,
        sample.charging ? 'Charging' : 'On battery', 'battery'));
    }
    host.innerHTML = tiles.join('');
  }

  // ------------------------------------------------------------ build once

  function build() {
    const host = $('#systemPanels');
    if (!host || built) return;

    const inv = inventory || {};
    const cpu = inv.cpu || {};
    const board = inv.board || {};
    const bios = inv.bios || {};
    const osInfo = inv.os || {};
    const sticks = inv.memory || [];
    const drives = inv.drives || [];
    const adapters = inv.adapters || [];

    // The card that matters is the discrete one. A machine with integrated
    // graphics and a virtual display driver reports three adapters, and the
    // one with the most memory behind it is the one doing the work.
    const gpus = (inv.gpus || []).slice().sort((a, b) => (b.vram || 0) - (a.vram || 0));
    const gpu = gpus[0] || {};

    const totalStick = sticks.reduce((sum, s) => sum + (s.size || 0), 0);
    const stickSummary = sticks.length
      ? `${sticks.length} × ${UI.formatBytes(sticks[0].size)} ${sticks[0].type} @ ${sticks[0].speed} MHz`
      : '—';

    host.innerHTML = `
      <!-- ---------------------------------------------------------- CPU -->
      <div class="card sys-card">
        <div class="card-head">
          <h3>${Icons.icon('cpu', 13)} Processor</h3>
          <span class="pill" data-ref="cpuPill">—</span>
        </div>
        <p class="sys-title">${esc(cpu.name || inv.cpuModel || 'Unknown processor')}</p>
        <div class="spark" data-ref="cpuSpark">${sparkSvg(['cpu'])}</div>
        <dl class="kv sys-kv">
          ${row('Usage', 'cpuUsage')}
          ${row('Clock', 'cpuClock')}
          ${row('Temperature', 'cpuTemp')}
          <dt>Cores / threads</dt><dd>${cpu.cores ? `${cpu.cores} / ${cpu.threads}` : String(inv.cpuCount || '—')}</dd>
          <dt>Architecture</dt><dd>${esc(osInfo.arch || inv.arch || '—')}${cpu.socket ? ' · ' + esc(cpu.socket) : ''}</dd>
          ${cpu.cacheL3 ? `<dt>L2 / L3 cache</dt><dd>${UI.formatBytes(cpu.cacheL2 * 1024)} / ${UI.formatBytes(cpu.cacheL3 * 1024)}</dd>` : ''}
        </dl>
        <div class="core-grid" data-ref="coreGrid"></div>
      </div>

      <!-- ------------------------------------------------------- memory -->
      <div class="card sys-card">
        <div class="card-head">
          <h3>${Icons.icon('memory', 13)} Memory</h3>
          <span class="pill" data-ref="memPill">—</span>
        </div>
        <div class="spark" data-ref="memSpark">${sparkSvg(['mem'])}</div>
        <dl class="kv sys-kv">
          ${row('In use', 'memUsed')}
          ${row('Available', 'memFree')}
          <dt>Installed</dt><dd>${totalStick ? UI.formatBytes(totalStick) : UI.formatBytes(inv.totalMemory || 0)}</dd>
          <dt>Configuration</dt><dd>${esc(stickSummary)}</dd>
        </dl>
        ${sticks.length ? `<div class="stick-list">
          ${sticks.map(s => `<span class="stick">
            <i>${esc(s.slot || 'DIMM')}</i>${UI.formatBytes(s.size)} · ${esc(s.type)} · ${s.configuredSpeed || s.speed} MHz
          </span>`).join('')}
        </div>` : ''}
      </div>

      <!-- ---------------------------------------------------------- GPU -->
      <div class="card sys-card" data-ref="gpuCard">
        <div class="card-head">
          <h3>${Icons.icon('gpu', 13)} Graphics</h3>
          <span class="pill" data-ref="gpuPill">—</span>
        </div>
        <p class="sys-title">${esc(gpu.name || 'No adapter reported')}</p>
        <div class="spark" data-ref="gpuSpark">${sparkSvg(['gpu', 'vram'])}</div>
        <dl class="kv sys-kv">
          ${row('Usage', 'gpuUsage')}
          ${row('Temperature', 'gpuTemp')}
          ${row('Core clock', 'gpuClock')}
          ${row('Memory clock', 'gpuMemClock')}
          ${row('VRAM in use', 'gpuVram')}
          ${row('Power draw', 'gpuPower')}
          <dt>Vendor</dt><dd>${esc(gpu.vendor || '—')}</dd>
          <dt>Total VRAM</dt><dd>${gpu.vram ? UI.formatBytes(gpu.vram) : '—'}</dd>
          ${gpu.driver ? `<dt>Driver</dt><dd>${esc(gpu.driver)}</dd>` : ''}
          ${gpu.resolution ? `<dt>Output</dt><dd>${esc(gpu.resolution)} @ ${gpu.refresh} Hz</dd>` : ''}
        </dl>
        ${gpus.length > 1 ? `<div class="sys-note">Also present: ${gpus.slice(1).map(g => esc(g.name)).join(', ')}</div>` : ''}
      </div>

      <!-- ------------------------------------------------------ storage -->
      <div class="card sys-card">
        <div class="card-head">
          <h3>${Icons.icon('disk', 13)} Storage</h3>
          <span class="pill" data-ref="ioPill">—</span>
        </div>
        <div class="spark" data-ref="ioSpark">${sparkSvg(['read', 'write'])}</div>
        <div class="spark-legend">
          <span><i style="background:var(--cat-meeting)"></i>Read</span>
          <span><i style="background:var(--cat-personal)"></i>Write</span>
          <span style="margin-left:auto" data-ref="ioPeak"></span>
        </div>
        ${drives.length ? `<div class="drive-list">
          ${drives.map(d => `<div class="drive">
            <b>${esc(d.name)}</b>
            <span>${UI.formatBytes(d.size)} · ${esc(d.media || '')}${d.bus ? ' · ' + esc(d.bus) : ''}</span>
            <em class="health ${d.health === 'Healthy' ? 'ok' : 'warn'}">${esc(d.health || 'Unknown')}</em>
          </div>`).join('')}
        </div>` : ''}
        <div class="meters" data-ref="diskMeters"></div>
      </div>

      <!-- ------------------------------------------------------ cooling -->
      <div class="card sys-card">
        <div class="card-head">
          <h3>${Icons.icon('fan', 13)} Cooling</h3>
          <span class="pill" data-ref="fanPill">—</span>
        </div>
        <div class="fan-list" data-ref="fanList"></div>
      </div>

      <!-- ------------------------------------------------------ network -->
      <div class="card sys-card">
        <div class="card-head">
          <h3>${Icons.icon('wifi', 13)} Network</h3>
          <span class="pill" data-ref="netPill">—</span>
        </div>
        <div class="spark" data-ref="netSpark">${sparkSvg(['down', 'up'])}</div>
        <div class="spark-legend">
          <span><i style="background:var(--cat-meeting)"></i>Down</span>
          <span><i style="background:var(--cat-personal)"></i>Up</span>
          <span style="margin-left:auto" data-ref="netPeak"></span>
        </div>
        <dl class="kv sys-kv">
          ${row('Download', 'netDown')}
          ${row('Upload', 'netUp')}
          ${row('Received', 'netRx')}
          ${row('Sent', 'netTx')}
          ${adapters.length ? `<dt>Adapter</dt><dd>${esc(adapters[0].description || adapters[0].name)}</dd>
          <dt>Connection</dt><dd>${adapters[0].wireless ? 'Wi-Fi' : 'Ethernet'}${adapters[0].speed ? ' · ' + (adapters[0].speed / 1e9 >= 1 ? (adapters[0].speed / 1e9) + ' Gbps' : Math.round(adapters[0].speed / 1e6) + ' Mbps') : ''}</dd>` : ''}
        </dl>
      </div>

      <!-- --------------------------------------------------- speed test -->
      <div class="card sys-card speedtest">
        <div class="card-head">
          <h3>${Icons.icon('activity', 13)} Internet speed</h3>
          <button class="ghost-btn sm" data-ref="speedRun">Run test</button>
        </div>
        <div class="st-dials">
          <div class="st-dial"><b data-ref="stDown">—</b><small>Mbps down</small></div>
          <div class="st-dial"><b data-ref="stUp">—</b><small>Mbps up</small></div>
          <div class="st-dial"><b data-ref="stPing">—</b><small>ms ping</small></div>
          <div class="st-dial"><b data-ref="stJitter">—</b><small>ms jitter</small></div>
        </div>
        <p class="st-status" data-ref="stStatus">Measures against Cloudflare's speed service — the only request this widget makes besides the weather.</p>
        <div class="st-history" data-ref="stHistory"></div>
      </div>

      <!-- ------------------------------------------------------ machine -->
      <div class="card sys-card">
        <div class="card-head"><h3>${Icons.icon('info', 13)} Machine</h3></div>
        <dl class="kv sys-kv">
          <dt>Computer name</dt><dd>${esc((inv.machine && inv.machine.name) || inv.hostname || '—')}</dd>
          <dt>Operating system</dt><dd>${esc(osInfo.caption || inv.type || '—')}</dd>
          <dt>OS version</dt><dd>${esc(osInfo.version ? `${osInfo.version} (build ${osInfo.build})` : inv.release || '—')}</dd>
          <dt>Manufacturer</dt><dd>${esc((inv.machine && inv.machine.manufacturer) || '—')}</dd>
          <dt>System model</dt><dd>${esc((inv.machine && inv.machine.model) || '—')}</dd>
          <dt>Motherboard</dt><dd>${esc(board.product ? `${board.manufacturer} ${board.product}` : '—')}</dd>
          <dt>BIOS</dt><dd>${esc(bios.version ? `${bios.version}${bios.date ? ' · ' + bios.date : ''}` : '—')}</dd>
          <dt>Processor</dt><dd>${esc(cpu.name || inv.cpuModel || '—')}</dd>
          <dt>Graphics</dt><dd>${esc(gpu.name || '—')}</dd>
          <dt>Memory</dt><dd>${esc(stickSummary)}</dd>
          <dt>Storage</dt><dd>${drives.length ? esc(drives.map(d => `${d.name} (${UI.formatBytes(d.size)})`).join(', ')) : '—'}</dd>
          ${row('Uptime', 'uptime')}
          <dt>Widget</dt><dd>v${esc(State.env().version)} · Electron ${esc(State.env().electron)}</dd>
        </dl>
      </div>`;

    for (const node of host.querySelectorAll('[data-ref]')) refs[node.dataset.ref] = node;
    built = true;

    refs.speedRun.addEventListener('click', runSpeedTest);
    renderSpeedHistory();
  }

  // ----------------------------------------------------------- per sample

  function update(sample) {
    if (!built) return;

    push('cpu', sample.cpu);
    push('mem', sample.memory.percent);
    push('down', sample.net.down);
    push('up', sample.net.up);
    push('read', sample.diskIo ? sample.diskIo.read : 0);
    push('write', sample.diskIo ? sample.diskIo.write : 0);

    // --- processor
    setText(refs.cpuPill, pct(sample.cpu));
    setText(refs.cpuUsage, `${sample.cpu.toFixed(1)}%`);
    setText(refs.cpuClock, sample.cpuMhz ? `${(sample.cpuMhz / 1000).toFixed(2)} GHz` : '—');
    setText(refs.cpuTemp, sample.temp === null
      ? 'Not exposed by this hardware'
      : degrees(sample.temp));
    drawSpark(refs.cpuSpark.querySelector('svg'), [{ cls: 'cpu', data: series.cpu }], 100);

    // Per-core bars: built once at the right length, then only heights move.
    const loads = sample.coreLoad || [];
    if (refs.coreGrid.children.length !== loads.length) {
      refs.coreGrid.innerHTML = loads.map(() => '<span class="core"><i></i></span>').join('');
    }
    loads.forEach((load, i) => {
      const bar = refs.coreGrid.children[i];
      if (!bar) return;
      bar.firstChild.style.height = `${Math.max(4, Math.round(load))}%`;
      bar.title = `Thread ${i + 1}: ${Math.round(load)}%`;
    });

    // --- memory
    setText(refs.memPill, pct(sample.memory.percent));
    setText(refs.memUsed, `${UI.formatBytes(sample.memory.used)} (${Math.round(sample.memory.percent)}%)`);
    setText(refs.memFree, UI.formatBytes(sample.memory.free));
    drawSpark(refs.memSpark.querySelector('svg'), [{ cls: 'mem', data: series.mem }], 100);

    // --- graphics
    const gpu = sample.gpu;
    if (gpu && typeof gpu.util === 'number') {
      push('gpu', gpu.util);
      const vramPct = gpu.memTotal ? (gpu.memUsed / gpu.memTotal) * 100 : 0;
      push('vram', vramPct);

      setText(refs.gpuPill, pct(gpu.util));
      setText(refs.gpuUsage, `${gpu.util.toFixed(0)}%`);
      setText(refs.gpuTemp, gpu.source === 'counter' ? 'Needs nvidia-smi' : degrees(gpu.temp));
      setText(refs.gpuClock, mhz(gpu.clock));
      setText(refs.gpuMemClock, mhz(gpu.memClock));
      setText(refs.gpuVram, gpu.memTotal
        ? `${UI.formatBytes(gpu.memUsed * 1048576)} of ${UI.formatBytes(gpu.memTotal * 1048576)} (${Math.round(vramPct)}%)`
        : '—');
      setText(refs.gpuPower, typeof gpu.power === 'number' ? `${gpu.power.toFixed(1)} W` : '—');
      drawSpark(refs.gpuSpark.querySelector('svg'),
        [{ cls: 'gpu', data: series.gpu }, { cls: 'vram', data: series.vram }], 100);
    } else {
      setText(refs.gpuPill, 'no telemetry');
    }

    // --- storage
    const io = sample.diskIo || { read: 0, write: 0 };
    setText(refs.ioPill, `${rate(io.read)} read · ${rate(io.write)} write`);
    const ioMax = drawSpark(refs.ioSpark.querySelector('svg'),
      [{ cls: 'read', data: series.read }, { cls: 'write', data: series.write }], 1048576);
    setText(refs.ioPeak, `peak ${rate(ioMax)}`);

    if (sample.disks && sample.disks.length) {
      const signature = sample.disks.map(d => d.name).join(',');
      if (refs.diskMeters.dataset.sig !== signature) {
        refs.diskMeters.dataset.sig = signature;
        refs.diskMeters.innerHTML = sample.disks.map(disk => `
          <div class="meter">
            <span class="m-name">${esc(disk.name)}${disk.label ? ' ' + esc(disk.label) : ''}</span>
            <span class="m-track"><span class="m-fill"></span></span>
            <span class="m-val"></span>
          </div>`).join('');
      }
      sample.disks.forEach((disk, i) => {
        const node = refs.diskMeters.children[i];
        if (!node) return;
        const fill = node.querySelector('.m-fill');
        fill.style.width = `${disk.percent}%`;
        fill.style.background = ringColor(disk.percent);
        setText(node.querySelector('.m-val'), `${UI.formatBytes(disk.free)} free`);
      });
    }

    // --- cooling
    const fans = [];
    if (gpu && typeof gpu.fan === 'number') {
      fans.push({ name: 'GPU fan', value: `${Math.round(gpu.fan)}%`, percent: gpu.fan });
    }
    for (const fan of sample.fans || []) {
      fans.push({ name: fan.name || 'System fan', value: `${fan.rpm} RPM`, percent: null });
    }
    setText(refs.fanPill, fans.length ? `${fans.length} reporting` : 'none reporting');
    const fanSig = fans.map(f => f.name).join(',') + '|' + fans.length;
    if (refs.fanList.dataset.sig !== fanSig) {
      refs.fanList.dataset.sig = fanSig;
      refs.fanList.innerHTML = fans.length
        ? fans.map(f => `<div class="fan-row">
            <b>${esc(f.name)}</b>
            <span class="m-track"><span class="m-fill" style="width:${f.percent === null ? 100 : f.percent}%"></span></span>
            <em data-fan="${esc(f.name)}">${esc(f.value)}</em>
          </div>`).join('')
        : '';
      if (!fans.length) {
        refs.fanList.innerHTML = `<div class="sys-note">
          No fan reports this speed. Motherboard headers sit behind the Super I/O
          chip, which Windows does not expose to a normal program — reading CPU
          and case fans needs a kernel driver.
        </div>`;
      }
    }
    for (const fan of fans) {
      const node = refs.fanList.querySelector(`[data-fan="${CSS.escape(fan.name)}"]`);
      if (node) setText(node, fan.value);
      if (node && fan.percent !== null) {
        const bar = node.parentElement.querySelector('.m-fill');
        if (bar) bar.style.width = `${fan.percent}%`;
      }
    }

    // --- network
    setText(refs.netPill, `↓ ${rate(sample.net.down)} · ↑ ${rate(sample.net.up)}`);
    setText(refs.netDown, rate(sample.net.down));
    setText(refs.netUp, rate(sample.net.up));
    setText(refs.netRx, UI.formatBytes(sample.netTotal ? sample.netTotal.rx : 0));
    setText(refs.netTx, UI.formatBytes(sample.netTotal ? sample.netTotal.tx : 0));
    const netMax = drawSpark(refs.netSpark.querySelector('svg'),
      [{ cls: 'down', data: series.down }, { cls: 'up', data: series.up }], 131072);
    setText(refs.netPeak, `peak ${rate(netMax)}`);

    // --- machine
    setText(refs.uptime, UI.formatDuration(sample.uptime));
  }

  // ------------------------------------------------------------ speedtest

  function showResult(result) {
    setText(refs.stDown, mbps(result.down));
    setText(refs.stUp, mbps(result.up));
    setText(refs.stPing, result.ping === null ? '—' : Math.round(result.ping).toString());
    setText(refs.stJitter, result.jitter === null ? '—' : Math.round(result.jitter).toString());
    setText(refs.stStatus,
      `${result.server ? `Measured against ${result.server}` : 'Measured'} · ${DT.relativeDay(DT.key(new Date(result.ts)))} `
      + `${new Date(result.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · took ${(result.took / 1000).toFixed(1)}s`);
  }

  async function renderSpeedHistory(history) {
    if (!refs.stHistory) return;
    const list = history || await hrdock.speedtest.history();
    if (!list || !list.length) { refs.stHistory.innerHTML = ''; return; }

    if (!history) showResult(list[0]);

    refs.stHistory.innerHTML = `
      <div class="st-head">Recent tests</div>
      ${list.slice(0, 6).map(r => `
        <div class="st-row">
          <span>${esc(new Date(r.ts).toLocaleDateString([], { day: 'numeric', month: 'short' }))}
            ${esc(new Date(r.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</span>
          <b>${mbps(r.down)}<small>↓</small></b>
          <b>${mbps(r.up)}<small>↑</small></b>
          <em>${r.ping === null ? '—' : Math.round(r.ping) + ' ms'}</em>
        </div>`).join('')}`;
  }

  async function runSpeedTest() {
    if (speedRunning) return;
    speedRunning = true;
    refs.speedRun.disabled = true;
    refs.speedRun.textContent = 'Testing…';
    setText(refs.stStatus, 'Starting…');
    for (const key of ['stDown', 'stUp', 'stPing', 'stJitter']) setText(refs[key], '—');

    try {
      const response = await hrdock.speedtest.run();
      if (!response.ok) {
        setText(refs.stStatus, `Test failed: ${response.error}`);
      } else {
        showResult(response.result);
        renderSpeedHistory(response.history);
      }
    } catch (err) {
      setText(refs.stStatus, `Test failed: ${err.message}`);
    } finally {
      speedRunning = false;
      refs.speedRun.disabled = false;
      refs.speedRun.textContent = 'Run test';
    }
  }

  // ------------------------------------------------------------- lifecycle

  function render(sample) {
    latest = sample;
    if (!mounted || !sample) return;
    renderGauges(sample);
    update(sample);
  }

  async function start() {
    if (watching) return;
    watching = true;

    if (!inventory) {
      try { inventory = await hrdock.system.inventory(); } catch (_) { inventory = {}; }
    }
    build();

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

    // Progress arrives on the event channel while the result comes back on the
    // invoke channel, and the two are not ordered against each other. A phase
    // notice that overtakes the result would paint "measuring…" over the
    // finished figures, so once the run is done its stragglers are ignored.
    hrdock.on('speedtest:phase', p => {
      if (!speedRunning) return;
      const said = { latency: 'Measuring latency…', download: 'Measuring download…', upload: 'Measuring upload…' };
      setText(refs.stStatus, said[p.phase] || 'Testing…');
    });
    hrdock.on('speedtest:progress', p => {
      if (!speedRunning) return;
      if (p.phase === 'download') setText(refs.stDown, mbps(p.speed));
      if (p.phase === 'upload') setText(refs.stUp, mbps(p.speed));
    });

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
