'use strict';
/**
 * HR Dock — internet speed test.
 *
 * This is the one part of the app besides the weather lookup that talks to a
 * server, and it cannot be otherwise: measuring a connection means moving real
 * bytes over it. It runs only when the button is pressed.
 *
 * Cloudflare's speed endpoints are the target — no account, no key, and a
 * point of presence close to almost anywhere, which is what makes a result
 * mean anything. The response carries the datacentre that served it, so the
 * result can say where it was measured against rather than claiming a number
 * out of nowhere.
 *
 * Method, so the figures can be read honestly:
 *   - latency is the time to first byte of an empty download, taken several
 *     times; jitter is the mean change between consecutive samples.
 *   - throughput is measured over increasing payloads until the transfer has
 *     run long enough to have left TCP slow-start behind, and the last, largest
 *     transfer is the one reported.
 */
const https = require('https');
const { EventEmitter } = require('events');

const HOST = 'speed.cloudflare.com';
const DOWN = bytes => `/__down?bytes=${bytes}`;
const UP = '/__up';

/** Mbps from a byte count and a millisecond duration. */
const mbps = (bytes, ms) => (ms <= 0 ? 0 : (bytes * 8) / (ms / 1000) / 1e6);

function request(options, body, onBytes) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let firstByte = null;
    let bytes = 0;

    const req = https.request({ host: HOST, ...options, timeout: 20000 }, res => {
      // The response headers are the first byte back. Waiting for a data chunk
      // instead would never resolve for an empty body — which is exactly what
      // the latency probe asks for.
      firstByte = process.hrtime.bigint();
      res.on('data', chunk => {
        bytes += chunk.length;
        if (onBytes) onBytes(bytes);
      });
      res.on('end', () => {
        const done = process.hrtime.bigint();
        resolve({
          bytes,
          status: res.statusCode,
          colo: res.headers['cf-meta-colo'] || null,
          ms: Number(done - started) / 1e6,
          ttfb: firstByte === null ? null : Number(firstByte - started) / 1e6
        });
      });
      res.resume();
    });

    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

/**
 * Time to first byte, several times over.
 *
 * Taken twice during a run: once with the line quiet, and once while the
 * download is saturating it. The quiet figure is the one people mean by
 * latency; the busy one is what a call actually sounds like while someone else
 * in the house is downloading, and the gap between them is bufferbloat.
 */
async function latency(samples = 6, whileActive) {
  const times = [];
  let colo = null;
  for (let i = 0; whileActive ? whileActive() : i < samples; i++) {
    try {
      const r = await request({ path: DOWN(0), method: 'GET' });
      if (r.ttfb !== null) times.push(r.ttfb);
      if (r.colo) colo = r.colo;
    } catch (_) { /* one lost sample does not sink the run */ }
    if (whileActive && times.length > 40) break;   // a stuck transfer is not a reason to probe forever
  }
  if (!times.length) return { ping: null, jitter: null, colo };

  // Discard the first: it pays for the TLS handshake, which is not latency.
  const useful = times.length > 1 ? times.slice(1) : times;
  const ping = useful.reduce((a, b) => a + b, 0) / useful.length;
  let jitter = 0;
  for (let i = 1; i < useful.length; i++) jitter += Math.abs(useful[i] - useful[i - 1]);
  jitter = useful.length > 1 ? jitter / (useful.length - 1) : 0;

  return { ping, jitter, colo };
}

/**
 * Grow the payload until a transfer lasts long enough to be a measurement
 * rather than a snapshot of slow-start. The last one is the answer.
 */
async function measure(direction, onProgress) {
  const sizes = direction === 'down'
    ? [1e6, 10e6, 25e6, 100e6]
    : [1e6, 5e6, 10e6, 25e6];
  let best = 0;
  let colo = null;

  for (const size of sizes) {
    const bytes = Math.round(size);
    let result;
    try {
      if (direction === 'down') {
        result = await request({ path: DOWN(bytes), method: 'GET' }, null,
          seen => onProgress && onProgress(mbps(seen, 1)));
      } else {
        const payload = Buffer.alloc(bytes, 0x61);
        result = await request({
          path: UP,
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'content-length': bytes }
        }, payload);
      }
    } catch (_) {
      break;                       // keep whatever the smaller runs established
    }

    if (result.colo) colo = result.colo;
    const moved = direction === 'down' ? result.bytes : bytes;
    const speed = mbps(moved, result.ms);
    if (speed > best) best = speed;
    if (onProgress) onProgress(speed);

    // Once a transfer has run for a couple of seconds the window is wide
    // enough; going bigger only spends the user's data allowance.
    if (result.ms > 2000) break;
  }

  return { speed: best, colo };
}

class SpeedTest extends EventEmitter {
  constructor() {
    super();
    this.running = false;
  }

  /**
   * Latency, then download, then upload. Progress is emitted per phase so the
   * dial can move while it works rather than sitting still for ten seconds.
   */
  async run() {
    if (this.running) throw new Error('A speed test is already running');
    this.running = true;
    const started = Date.now();

    try {
      this.emit('phase', { phase: 'latency' });
      const idle = await latency();

      // Probe latency alongside the download rather than after it: the number
      // only means anything while the line is under load.
      this.emit('phase', { phase: 'download' });
      let downloading = true;
      const loadedProbe = latency(0, () => downloading);
      const down = await measure('down', speed => this.emit('progress', { phase: 'download', speed }));
      downloading = false;
      const loaded = await loadedProbe;

      this.emit('phase', { phase: 'upload' });
      const up = await measure('up', speed => this.emit('progress', { phase: 'upload', speed }));

      const result = {
        id: 'st_' + started.toString(36),
        down: down.speed,                 // Mbps; the UI renders MB/s
        up: up.speed,
        ping: loaded.ping === null ? idle.ping : loaded.ping,   // under load
        idle: idle.ping,                  // with the line quiet
        jitter: idle.jitter,
        server: down.colo || up.colo || idle.colo || null,
        host: HOST,
        ts: started,
        took: Date.now() - started
      };
      this.emit('done', result);
      return result;
    } finally {
      this.running = false;
    }
  }
}

module.exports = { SpeedTest, mbps };
