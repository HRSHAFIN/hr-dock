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
 * mean anything. The response carries the datacentre that served it.
 *
 * How it measures, because the method is the difference between a number and
 * a guess:
 *
 *   - Several streams at once. One TCP connection cannot fill a fast line: it
 *     is bounded by window size over round-trip time, so a single stream
 *     under-reports badly on a distant server. Measured on the development
 *     machine: 51 Mbps down on one stream against 78 on four, and 83 Mbps up
 *     against 166. Four saturates; eight adds nothing.
 *   - A warm-up is thrown away. The first second and a half is TCP feeling out
 *     the path, and counting it drags the average below what the line does.
 *   - Throughput is bytes over wall-clock across a fixed window, not the size
 *     of one transfer over its own duration.
 *   - Every response is checked. The endpoint refuses payloads of 100MB and
 *     up with a 403 and a one-byte body, and it will rate-limit a burst the
 *     same way; counting those bodies as data is how a speed test reports
 *     nonsense with total confidence.
 *   - Latency rides on a kept-alive connection, so it is round-trip time
 *     rather than the cost of a fresh TLS handshake. It is taken twice: once
 *     with the line quiet, once while the download is saturating it.
 */
const https = require('https');
const { EventEmitter } = require('events');

const HOST = 'speed.cloudflare.com';
const UP = '/__up';
const DOWN = bytes => `/__down?bytes=${bytes}`;

// Anything from 100MB up is refused outright, so each stream asks for less and
// is simply cut off when the measurement window closes.
const CHUNK_BYTES = 50e6;
// Uploads go in smaller pieces: each one is only counted once the server
// acknowledges it, so the pieces have to land often enough to fill the window.
const UPLOAD_BYTES = 8e6;
const STREAMS = 4;
const WARMUP_MS = 1500;
const WINDOW_MS = 6000;

// A plain Node request carries no user agent and gets slower service.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
};

// Kept alive so latency probes measure the network rather than a handshake.
const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

const BLOCK = Buffer.alloc(256 * 1024, 0x61);

/** Mbps from a byte count and a millisecond duration. */
const mbps = (bytes, ms) => (ms <= 0 ? 0 : (bytes * 8) / (ms / 1000) / 1e6);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The middle value, which a single stalled sample cannot move. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** One request whose body is counted rather than kept. */
function pull(bytes, onBytes, stopped) {
  return new Promise(resolve => {
    const req = https.request(
      { host: HOST, path: DOWN(bytes), method: 'GET', headers: HEADERS, agent, timeout: 30000 },
      res => {
        if (res.statusCode !== 200) { res.resume(); resolve({ rejected: res.statusCode }); return; }
        const colo = res.headers['cf-meta-colo'] || null;
        res.on('data', chunk => {
          onBytes(chunk.length);
          if (stopped()) req.destroy();
        });
        res.on('close', () => resolve({ colo }));
      });
    req.on('error', () => resolve({ failed: true }));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

/**
 * One request that writes until the window closes.
 *
 * Nothing is counted here. Handing a buffer to `write()` is not the same as
 * putting it on the wire — the socket and the TLS layer will accept megabytes
 * that have not left the machine, and a request destroyed at the end of the
 * window takes whatever is still queued with it. Counting writes reported this
 * line at 598 Mbps up against 79 down. The meter is the socket's own
 * `bytesWritten`, read by the caller.
 */
function push(bytes, onDelivered) {
  return new Promise(resolve => {
    const req = https.request(
      {
        host: HOST,
        path: UP,
        method: 'POST',
        agent,
        timeout: 60000,
        headers: { ...HEADERS, 'content-type': 'application/octet-stream', 'content-length': bytes }
      },
      res => {
        res.resume();
        if (res.statusCode !== 200) { resolve({ rejected: res.statusCode }); return; }
        res.on('end', () => {
          // The response is the receipt: only now is this payload known to
          // have arrived, so only now is it counted.
          onDelivered(bytes);
          resolve({ colo: res.headers['cf-meta-colo'] || null });
        });
      });

    req.on('error', () => resolve({ failed: true }));
    req.on('timeout', () => { req.destroy(); resolve({ failed: true }); });
    req.end(BLOCK.length >= bytes ? BLOCK.subarray(0, bytes) : Buffer.alloc(bytes, 0x61));
  });
}

/**
 * Run several streams at once and measure what arrives during the window,
 * after the warm-up has been discarded.
 */
async function measure(direction, onProgress) {
  let bytes = 0;
  let finished = false;
  const stopped = () => finished;

  // A download is counted as it arrives, which is the truth of it. An upload is
  // counted only when the server answers, because nothing else proves the bytes
  // got there: handing a buffer to write() puts it in a queue, and both the
  // socket's own counter and the queue will happily report a line at 646 Mbps
  // up against 79 down.
  const meter = () => bytes;
  const size = direction === 'down' ? CHUNK_BYTES : UPLOAD_BYTES;
  const move = direction === 'down'
    ? stop => pull(size, n => { bytes += n; }, stop)
    : () => push(size, n => { bytes += n; });

  // Each worker keeps a transfer in flight for the whole window. Firing one
  // request per stream and waiting is not enough: on a fast line a 50MB
  // transfer finishes mid-window, and every stream that has run out leaves the
  // measurement counting a connection that is no longer carrying anything.
  // That alone made the upload figure swing between 85 and 166 Mbps.
  const results = [];
  const streams = [];
  for (let i = 0; i < STREAMS; i++) {
    streams.push((async () => {
      while (!stopped()) {
        const result = await move(stopped);
        results.push(result);
        if (result.rejected || result.failed) break;   // do not hammer a server saying no
      }
    })());
    await sleep(100);                    // stagger, so they do not collide at the start
  }

  await sleep(WARMUP_MS);
  const from = meter();
  const started = Date.now();

  // Report as it goes, so the dial moves while the window is open.
  const ticker = setInterval(() => {
    const elapsed = Date.now() - started;
    if (elapsed > 300 && onProgress) onProgress(mbps(meter() - from, elapsed));
  }, 400);

  await sleep(direction === 'down' ? WINDOW_MS : WINDOW_MS + 2000);
  clearInterval(ticker);

  const moved = meter() - from;
  const elapsed = Date.now() - started;
  finished = true;

  await Promise.all(streams);
  const rejected = results.filter(r => r.rejected).length;
  const colo = (results.find(r => r.colo) || {}).colo || null;

  if (!moved) {
    const status = rejected ? results.find(r => r.rejected).rejected : 0;
    const leg = direction === 'down' ? 'download' : 'upload';
    // A refusal has to say so. Measuring the body of a 429 is exactly how a
    // speed test ends up reporting a confident, meaningless number.
    if (status === 429) {
      throw new Error('the test server is rate-limiting this connection — '
        + 'wait a few minutes and run it again');
    }
    throw new Error(status
      ? `the test server refused the ${leg} (HTTP ${status})`
      : `no data moved during the ${leg}`);
  }

  return { speed: mbps(moved, elapsed), bytes: moved, colo, rejected };
}

/**
 * Time to first byte over a connection that is already open, so the figure is
 * round-trip time and not a handshake.
 *
 * Taken twice during a run: once with the line quiet, and once while the
 * download is saturating it. The quiet figure is what people mean by latency;
 * the busy one is what a call sounds like while someone else is downloading,
 * and the gap between them is bufferbloat.
 */
async function latency(samples = 11, whileActive) {
  const times = [];
  let colo = null;

  for (let i = 0; whileActive ? whileActive() : i < samples; i++) {
    const started = process.hrtime.bigint();
    const result = await new Promise(resolve => {
      const req = https.request(
        { host: HOST, path: DOWN(0), method: 'GET', headers: HEADERS, agent, timeout: 10000 },
        res => {
          const ttfb = Number(process.hrtime.bigint() - started) / 1e6;
          res.resume();
          res.on('end', () => resolve({ ttfb, ok: res.statusCode === 200, colo: res.headers['cf-meta-colo'] }));
        });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });

    if (result && result.ok) {
      times.push(result.ttfb);
      if (result.colo) colo = result.colo;
    }
    if (whileActive && times.length > 60) break;   // a stuck transfer is no reason to probe forever
  }

  if (!times.length) return { ping: null, jitter: null, colo };

  // Drop the first: even on a kept-alive agent it may open the connection.
  const useful = times.length > 2 ? times.slice(1) : times;

  // The median, not the mean. This line sits at about 55ms and then throws the
  // occasional 800ms stall, and one of those drags an average to three times
  // the truth. The middle sample is what the connection actually does.
  const ping = median(useful);

  // Jitter as the median step between consecutive samples, for the same
  // reason: a single stall is not how much the latency wobbles.
  const steps = [];
  for (let i = 1; i < useful.length; i++) steps.push(Math.abs(useful[i] - useful[i - 1]));

  return { ping, jitter: steps.length ? median(steps) : 0, colo };
}

class SpeedTest extends EventEmitter {
  constructor() {
    super();
    this.running = false;
  }

  async run() {
    if (this.running) throw new Error('A speed test is already running');
    this.running = true;
    const started = Date.now();

    try {
      this.emit('phase', { phase: 'latency' });
      const idle = await latency();

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
        bytesDown: down.bytes,
        bytesUp: up.bytes,
        ping: loaded.ping === null ? idle.ping : loaded.ping,   // under load
        idle: idle.ping,                  // with the line quiet
        jitter: idle.jitter,
        streams: STREAMS,
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
