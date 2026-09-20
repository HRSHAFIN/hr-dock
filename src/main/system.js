'use strict';
/**
 * HR Dock — system metrics.
 *
 * Two PowerShell helpers do the Windows-specific work, because Node's `os`
 * module knows about CPU time and memory and nothing else:
 *
 *   - an inventory query, run once and cached: the machine's name, board,
 *     BIOS, memory sticks, drives and graphics adapters. None of it changes
 *     while the app is open, and every one of those calls is expensive.
 *   - a streaming loop, alive only while the System tab is on screen, which
 *     emits a line of JSON every couple of seconds: clocks, disk and network
 *     throughput, graphics telemetry, battery.
 *
 * What is not here is as deliberate as what is. Consumer desktops do not
 * report CPU temperature through WMI (no ACPI thermal zone) and do not report
 * motherboard fan RPM at all (Win32_Fan is a server-class class; the headers
 * are behind the Super I/O chip and need a kernel driver to read). Those
 * fields come back null and the UI says so, rather than showing a number
 * nobody can stand behind. GPU telemetry is the exception: nvidia-smi ships
 * with the driver and reports everything, so NVIDIA cards get the full set and
 * everything else falls back to the vendor-neutral GPU Engine counter.
 */
const os = require('os');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

/* Everything that cannot change while the widget is running. */
const PS_INVENTORY = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}

$cs = Get-CimInstance Win32_ComputerSystem
$osi = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$bb = Get-CimInstance Win32_BaseBoard
$bios = Get-CimInstance Win32_BIOS

if ($cs) {
  $out.machine = @{
    name = $cs.Name
    manufacturer = $cs.Manufacturer
    model = $cs.Model
    domain = $cs.Domain
    memorySlots = [int]$cs.NumberOfLogicalProcessors
  }
}
if ($osi) {
  $out.os = @{
    caption = $osi.Caption
    version = $osi.Version
    build = $osi.BuildNumber
    arch = $osi.OSArchitecture
    installed = $osi.InstallDate.ToString('yyyy-MM-dd')
  }
}
if ($cpu) {
  $out.cpu = @{
    name = $cpu.Name.Trim()
    manufacturer = $cpu.Manufacturer
    cores = [int]$cpu.NumberOfCores
    threads = [int]$cpu.NumberOfLogicalProcessors
    maxMhz = [int]$cpu.MaxClockSpeed
    socket = $cpu.SocketDesignation
    cacheL2 = [int]$cpu.L2CacheSize
    cacheL3 = [int]$cpu.L3CacheSize
  }
}
if ($bb) { $out.board = @{ manufacturer = $bb.Manufacturer; product = $bb.Product; version = $bb.Version } }
if ($bios) {
  $out.bios = @{ version = $bios.SMBIOSBIOSVersion; manufacturer = $bios.Manufacturer; date = $bios.ReleaseDate.ToString('yyyy-MM-dd') }
}

# SMBIOS memory-type codes. Anything unlisted is reported as its raw number
# rather than guessed at.
$types = @{ 20 = 'DDR'; 21 = 'DDR2'; 22 = 'DDR2 FB-DIMM'; 24 = 'DDR3'; 26 = 'DDR4'; 34 = 'DDR5'; 35 = 'DDR5'; codes = 1 }
$sticks = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object {
  $t = $types[[int]$_.SMBIOSMemoryType]
  if (-not $t) { $t = 'Type ' + $_.SMBIOSMemoryType }
  @{
    size = [double]$_.Capacity
    speed = [int]$_.Speed
    configuredSpeed = [int]$_.ConfiguredClockSpeed
    type = $t
    slot = $_.DeviceLocator
    manufacturer = $_.Manufacturer
    part = ($_.PartNumber -replace '\\s+$', '')
  }
})
$out.memory = $sticks

# WMI caps AdapterRAM at 4GB, so real VRAM comes from the driver key.
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  $vram = [double]$_.AdapterRAM
  @{
    name = $_.Name
    vendor = $_.AdapterCompatibility
    vram = $vram
    driver = $_.DriverVersion
    driverDate = $(if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null })
    resolution = $(if ($_.CurrentHorizontalResolution) { "$($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" } else { $null })
    refresh = [int]$_.CurrentRefreshRate
  }
})
# Pair each driver key to its adapter by name. The keys are not enumerated in
# the same order as WMI reports the adapters, and matching them by index hands
# the discrete card whatever the integrated one has.
try {
  $keys = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*'
  foreach ($k in $keys) {
    $size = [double]$k.'HardwareInformation.qwMemorySize'
    if ($size -le 0) { continue }
    $desc = [string]$k.DriverDesc
    foreach ($g in $gpus) {
      if ($g.name -eq $desc -and $size -gt $g.vram) { $g.vram = $size }
    }
  }
} catch {}
$out.gpus = $gpus

$out.drives = @(Get-PhysicalDisk | ForEach-Object {
  @{
    name = $_.FriendlyName
    size = [double]$_.Size
    media = [string]$_.MediaType
    bus = [string]$_.BusType
    health = [string]$_.HealthStatus
    serial = $_.SerialNumber
  }
})

$out.adapters = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  @{
    name = $_.Name
    description = $_.InterfaceDescription
    speed = [double]$_.Speed
    mac = $_.MacAddress
    wireless = [bool]($_.PhysicalMediaType -like '*802.11*')
  }
})

ConvertTo-Json -InputObject $out -Compress -Depth 6
`;

/* The telemetry that does change, streamed a line at a time. */
const PS_LOOP = `
$ErrorActionPreference = 'SilentlyContinue'
$maxMhz = (Get-CimInstance Win32_Processor | Select-Object -First 1).MaxClockSpeed
$nv = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
$i = 0
while ($true) {
  $out = @{}

  try {
    $net = Get-NetAdapterStatistics | Where-Object { $_.ReceivedBytes -gt 0 -or $_.SentBytes -gt 0 }
    $out.rx = [double](($net | Measure-Object -Property ReceivedBytes -Sum).Sum)
    $out.tx = [double](($net | Measure-Object -Property SentBytes -Sum).Sum)
  } catch {}

  # One Get-Counter call for all three: three separate calls cost a second each.
  try {
    $c = (Get-Counter -Counter '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec','\\Processor Information(_Total)\\% Processor Performance' -MaxSamples 1).CounterSamples
    $out.diskRead = [double]$c[0].CookedValue
    $out.diskWrite = [double]$c[1].CookedValue
    if ($maxMhz -and $c[2].CookedValue -gt 0) { $out.cpuMhz = [int]($maxMhz * $c[2].CookedValue / 100) }
  } catch {}

  if ($nv) {
    try {
      $raw = (nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,clocks.current.graphics,clocks.current.memory,memory.used,memory.total,fan.speed,power.draw --format=csv,noheader,nounits | Select-Object -First 1)
      if ($raw) {
        $g = $raw -split ','
        $num = { param($v) $t = $v.Trim(); if ($t -match '^[0-9.]+$') { [double]$t } else { $null } }
        $out.gpu = @{
          util = & $num $g[0]; temp = & $num $g[1]
          clock = & $num $g[2]; memClock = & $num $g[3]
          memUsed = & $num $g[4]; memTotal = & $num $g[5]
          fan = & $num $g[6]; power = & $num $g[7]
          source = 'nvidia-smi'
        }
      }
    } catch {}
  } else {
    # Vendor-neutral fallback: usage only, which is all this counter knows.
    try {
      $eng = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -MaxSamples 1).CounterSamples | Measure-Object -Property CookedValue -Sum
      $out.gpu = @{ util = [math]::Min(100, [math]::Round($eng.Sum, 1)); source = 'counter' }
    } catch {}
  }

  if ($i % 5 -eq 0) {
    try {
      $b = Get-CimInstance Win32_Battery | Select-Object -First 1
      if ($b) { $out.battery = [int]$b.EstimatedChargeRemaining; $out.batteryStatus = [int]$b.BatteryStatus }
    } catch {}
    try {
      $t = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object -First 1
      if ($t) { $out.temp = [math]::Round((($t.CurrentTemperature / 10) - 273.15), 1) }
    } catch {}
    # Almost always empty on a desktop; kept because it costs nothing and a
    # workstation or server board really does answer.
    try {
      $out.fans = @(Get-CimInstance Win32_Fan | Where-Object { $_.DesiredSpeed -gt 0 -or $_.VariableSpeed } | ForEach-Object {
        @{ name = $_.Name; rpm = [int]$_.DesiredSpeed; ok = [bool]($_.Status -eq 'OK') }
      })
    } catch {}
  }

  if ($i % 15 -eq 0) {
    try {
      $out.disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
        @{ name = $_.DeviceID; label = $_.VolumeName; size = [double]$_.Size; free = [double]$_.FreeSpace }
      })
    } catch {}
  }

  $i++
  ConvertTo-Json -InputObject $out -Compress -Depth 5
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
    this.extra = {};          // most recent values from the streaming helper
    this.running = false;
    this.inventoryCache = null;
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

  /** Per-core busy percentages, for the little core grid. */
  sampleCores() {
    const cpus = os.cpus();
    const now = cpus.map(c => ({
      idle: c.times.idle,
      total: c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    }));
    let out = new Array(now.length).fill(0);
    if (this.lastCores && this.lastCores.length === now.length) {
      out = now.map((core, i) => {
        const idle = core.idle - this.lastCores[i].idle;
        const total = core.total - this.lastCores[i].total;
        return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
      });
    }
    this.lastCores = now;
    return out;
  }

  snapshot() {
    const total = os.totalmem();
    const free = os.freemem();
    const disks = (this.extra.disks || []).map(d => ({
      name: d.name,
      label: d.label || '',
      size: d.size,
      free: d.free,
      used: d.size - d.free,
      percent: d.size > 0 ? ((d.size - d.free) / d.size) * 100 : 0
    }));

    const gpu = this.extra.gpu || null;

    return {
      cpu: this.sampleCpu(),
      cores: os.cpus().length,
      coreLoad: this.sampleCores(),
      cpuMhz: typeof this.extra.cpuMhz === 'number' ? this.extra.cpuMhz : null,
      memory: { total, free, used: total - free, percent: ((total - free) / total) * 100 },
      uptime: os.uptime(),
      disks,
      diskIo: {
        read: typeof this.extra.diskRead === 'number' ? this.extra.diskRead : 0,
        write: typeof this.extra.diskWrite === 'number' ? this.extra.diskWrite : 0
      },
      gpu,
      fans: this.extra.fans || [],
      battery: typeof this.extra.battery === 'number' ? this.extra.battery : null,
      charging: this.extra.batteryStatus === 2 || this.extra.batteryStatus === 6,
      temp: typeof this.extra.temp === 'number' ? this.extra.temp : null,
      net: this.extra.net || { down: 0, up: 0 },
      netTotal: this.lastNet ? { rx: this.lastNet.rx, tx: this.lastNet.tx } : { rx: 0, tx: 0 },
      host: `${os.type()} ${os.release()}`,
      ts: Date.now()
    };
  }

  /**
   * The machine's fixed description. Queried once and kept: none of it changes
   * while the app is open, and the WMI calls behind it are slow enough that
   * polling them would be felt.
   */
  inventory() {
    if (this.inventoryCache) return this.inventoryCache;

    this.inventoryCache = new Promise(resolve => {
      const base = {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        type: os.type(),
        totalMemory: os.totalmem(),
        cpuModel: (os.cpus()[0] || {}).model || 'Unknown',
        cpuCount: os.cpus().length,
        versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome }
      };

      if (process.platform !== 'win32') { resolve(base); return; }

      execFile('powershell.exe', [...PS_ARGS, PS_INVENTORY],
        { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 25000 },
        (err, stdout) => {
          if (err || !stdout) { resolve(base); return; }
          try {
            resolve({ ...base, ...JSON.parse(stdout.trim()) });
          } catch (_) {
            resolve(base);
          }
        });
    }).catch(() => ({ hostname: os.hostname(), platform: process.platform }));

    return this.inventoryCache;
  }

  startPowerShell() {
    if (this.ps || process.platform !== 'win32') return;
    try {
      this.ps = spawn('powershell.exe', [...PS_ARGS, PS_LOOP],
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
    for (const key of ['disks', 'battery', 'batteryStatus', 'temp', 'cpuMhz', 'diskRead', 'diskWrite', 'gpu', 'fans']) {
      if (payload[key] !== undefined) this.extra[key] = payload[key];
    }

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
    this.sampleCores();
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
