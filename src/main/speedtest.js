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
 *     machine: 51 Mbps down on one stream against 79 on four. Four saturates;
 *     eight adds nothing.
 *   - Download and upload are measured differently, because they can be
 *     trusted differently. A download is counted as it arrives, over a fixed
 *     window with the first 1.5s of slow-start discarded — the bytes are in
 *     hand, and the figure repeats to within 0.1 MB/s. An upload has no such
 *     ground truth: this endpoint answers before it has finished reading, so
 *     the same payload times at 2.6s and then 15.9s. That leg is run as whole
 *     transfers, several rounds of them, and the median is reported.
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
// Upload is measured as whole transfers, repeated, because a single reading
// against this endpoint means nothing. Three rounds is enough for the median
// to settle without spending a quarter of a gigabyte to find out.
const UPLOAD_BYTES = 10e6;
const UPLOAD_ROUNDS = 3;
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
 * One upload, resolved when the server answers.
 *
 * Nothing is counted from the writing side. Handing a buffer to write() is not
 * the same as putting it on the wire: the socket and the TLS layer will accept
 * megabytes that have not left the machine, and the socket's own written-bytes
 * counter is no better. Counting either reported this line at 646 Mbps up
 * against 79 Mbps down.
 */
function push(bytes) {
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
        res.on('end', () => resolve({ ok: true, colo: res.headers['cf-meta-colo'] || null }));
      });

    req.on('error', () => resolve({ failed: true }));
    req.on('timeout', () => { req.destroy(); resolve({ failed: true }); });
    req.end(BLOCK.length >= bytes ? BLOCK.subarray(0, bytes) : Buffer.alloc(bytes, 0x61));
  });
}

/**
 * Upload, measured as whole transfers rather than over a window.
 *
 * The endpoint will not say honestly when it has finished reading a body: the
 * same 25MB payload came back in 2.6s once and 15.9s the next time, and four
 * parallel 25MB uploads have reported anything between 25 and 598 Mbps. So a
 * single reading is worthless whatever it is counting.
 *
 * What does hold up is the median of several rounds. Three trials of this came
 * back at 204, 258 and 224 Mbps where the raw rounds inside them spanned 128
 * to 413 — the middle round is a number worth printing, and one round is not.
 */
async function measureUpload(onProgress) {
  const rounds = [];
  let colo = null;
  let lastStatus = 0;

  for (let round = 0; round < UPLOAD_ROUNDS; round++) {
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: STREAMS }, () => push(UPLOAD_BYTES)));

    const delivered = results.filter(r => r.ok);
    const refused = results.find(r => r.rejected);
    if (refused) lastStatus = refused.rejected;
    if (!delivered.length) continue;

    colo = colo || (delivered.find(r => r.colo) || {}).colo || null;
    const speed = mbps(delivered.length * UPLOAD_BYTES, Date.now() - started);
    rounds.push(speed);
    if (onProgress) onProgress(median(rounds));
    await sleep(600);
  }

  if (!rounds.length) {
    if (lastStatus === 429) {
      throw new Error('the test server is rate-limiting this connection — '
        + 'wait a few minutes and run it again');
    }
    throw new Error(lastStatus
      ? `the test server refused the upload (HTTP ${lastStatus})`
      : 'no data moved during the upload');
  }

  return {
    speed: median(rounds),
    bytes: rounds.length * STREAMS * UPLOAD_BYTES,
    rounds: rounds.length,
    colo
  };
}

/**
 * Download, measured over a fixed window with several streams running.
 *
 * Bytes are counted as they arrive, which for a download is the truth of it:
 * the data is in hand. Repeatable here to within 0.1 MB/s across runs.
 */
async function measureDownload(onProgress) {
  let bytes = 0;
  let finished = false;
  const stopped = () => finished;

  const meter = () => bytes;
  const move = stop => pull(CHUNK_BYTES, n => { bytes += n; }, stop);

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

  await sleep(WINDOW_MS);
  clearInterval(ticker);

  const moved = meter() - from;
  const elapsed = Date.now() - started;
  finished = true;

  await Promise.all(streams);
  const rejected = results.filter(r => r.rejected).length;
  const colo = (results.find(r => r.colo) || {}).colo || null;

  if (!moved) {
    const status = rejected ? results.find(r => r.rejected).rejected : 0;
    const leg = 'download';
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
      const down = await measureDownload( speed => this.emit('progress', { phase: 'download', speed }));
      downloading = false;
      const loaded = await loadedProbe;

      this.emit('phase', { phase: 'upload' });
      const up = await measureUpload(speed => this.emit('progress', { phase: 'upload', speed }));

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
        uploadRounds: up.rounds,
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
