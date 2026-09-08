'use strict';
/**
 * HR Dock — system metrics.
 *
 * CPU / RAM / uptime come from Node's `os` module (free, no process spawn).
 * Disk, battery, network throughput and thermals need Windows APIs, so a
 * single long-lived PowerShell helper streams them as JSON lines. The helper
 * is only alive while the System tab is actually on screen, which keeps idle
 * cost at zero.
 */
const os = require('os');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const PS_LOOP = `
$ErrorActionPreference = 'SilentlyContinue'
$i = 0
while ($true) {
  $out = @{}
  try {
    $net = Get-NetAdapterStatistics | Where-Object { $_.ReceivedBytes -gt 0 -or $_.SentBytes -gt 0 }
    $out.rx = [double](($net | Measure-Object -Property ReceivedBytes -Sum).Sum)
    $out.tx = [double](($net | Measure-Object -Property SentBytes -Sum).Sum)
  } catch {}
  if ($i % 5 -eq 0) {
    try {
      $b = Get-CimInstance Win32_Battery | Select-Object -First 1
      if ($b) { $out.battery = [int]$b.EstimatedChargeRemaining; $out.batteryStatus = [int]$b.BatteryStatus }
    } catch {}
    try {
      $t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1
      if ($t) { $out.temp = [math]::Round((($t.CurrentTemperature / 10) - 273.15), 1) }
    } catch {}
  }
  if ($i % 15 -eq 0) {
    try {
      $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
        @{ name = $_.DeviceID; size = [double]$_.Size; free = [double]$_.FreeSpace }
      }
      $out.disks = @($disks)
    } catch {}
  }
  $i++
  ConvertTo-Json -InputObject $out -Compress -Depth 4
  Start-Sleep -Seconds 2
}
`;

class SystemMonitor extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.ps = null;
    this.lastCpu = null;
    this.lastNet = null;
    this.extra = {};     // most recent values from the PowerShell helper
    this.running = false;
  }

  /** Average CPU busy-percentage across all cores since the previous sample. */
  sampleCpu() {
    const cpus = os.cpus();
    const now = cpus.reduce((acc, c) => {
      acc.idle += c.times.idle;
      acc.total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      return acc;
    }, { idle: 0, total: 0 });

    let usage = 0;
    if (this.lastCpu) {
      const idle = now.idle - this.lastCpu.idle;
      const total = now.total - this.lastCpu.total;
      if (total > 0) usage = Math.max(0, Math.min(100, (1 - idle / total) * 100));
    }
    this.lastCpu = now;
    return usage;
  }

  snapshot() {
    const total = os.totalmem();
    const free = os.freemem();
    const disks = (this.extra.disks || []).map(d => ({
      name: d.name,
      size: d.size,
      used: d.size - d.free,
      percent: d.size > 0 ? ((d.size - d.free) / d.size) * 100 : 0
    }));

    return {
      cpu: this.sampleCpu(),
      cores: os.cpus().length,
      memory: { total, used: total - free, percent: ((total - free) / total) * 100 },
      uptime: os.uptime(),
      disks,
      battery: typeof this.extra.battery === 'number' ? this.extra.battery : null,
      charging: this.extra.batteryStatus === 2 || this.extra.batteryStatus === 6,
      temp: typeof this.extra.temp === 'number' ? this.extra.temp : null,
      net: this.extra.net || { down: 0, up: 0 },
      host: `${os.type()} ${os.release()}`,
      ts: Date.now()
    };
  }

  startPowerShell() {
    if (this.ps || process.platform !== 'win32') return;
    try {
      this.ps = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_LOOP],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      console.error('[system] powershell helper unavailable:', err.message);
      this.ps = null;
      return;
    }

    let buffer = '';
    this.ps.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        try { this.ingest(JSON.parse(line)); } catch (_) { /* partial line */ }
      }
      if (buffer.length > 64 * 1024) buffer = '';
    });
    this.ps.on('exit', () => { this.ps = null; });
  }

  ingest(payload) {
    if (payload.disks) this.extra.disks = payload.disks;
    if (payload.battery !== undefined) this.extra.battery = payload.battery;
    if (payload.batteryStatus !== undefined) this.extra.batteryStatus = payload.batteryStatus;
    if (payload.temp !== undefined) this.extra.temp = payload.temp;

    if (typeof payload.rx === 'number' && typeof payload.tx === 'number') {
      const now = Date.now();
      if (this.lastNet) {
        const secs = (now - this.lastNet.ts) / 1000;
        if (secs > 0.2) {
          this.extra.net = {
            down: Math.max(0, (payload.rx - this.lastNet.rx) / secs),
            up: Math.max(0, (payload.tx - this.lastNet.tx) / secs)
          };
        }
      }
      this.lastNet = { rx: payload.rx, tx: payload.tx, ts: now };
    }
  }

  start(intervalMs = 2000) {
    if (this.running) return;
    this.running = true;
    this.sampleCpu();               // prime the delta
    this.startPowerShell();
    this.timer = setInterval(() => this.emit('sample', this.snapshot()), intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.ps) { try { this.ps.kill(); } catch (_) {} this.ps = null; }
    this.lastNet = null;
  }
}

module.exports = { SystemMonitor };
