import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { createRadioServer } from '../server.js';

const execFileAsync = promisify(execFile);

async function createAudioSegment(duration = 1) {
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', String(duration), '-c:a', 'aac', '-f', 'mpegts', 'pipe:1',
  ], { encoding: 'buffer' });
  return stdout;
}

function station(url, id = 'kissfm') {
  return { id, url, icon: 'kissfm.png' };
}

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('streams upstream audio and preserves its content type', async (t) => {
  const audio = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x02]);
  const upstreamUrl = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/aacp' });
    res.end(audio);
  }));
  const url = await listen(t, createRadioServer({ stations: [station(upstreamUrl)] }));

  const response = await fetch(`${url}/kissfm?player=web`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/aacp');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), audio);
});

test('rejects unknown routes and unsupported methods', async (t) => {
  const url = await listen(t, createRadioServer());

  const missing = await fetch(`${url}/missing`);
  assert.equal(missing.status, 404);
  await missing.text();

  const unsupported = await fetch(`${url}/kissfm`, { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET');
  await unsupported.text();
});

test('status returns the default station configuration as JSON', async (t) => {
  const url = await listen(t, createRadioServer());
  const expected = JSON.parse(await readFile(new URL('../stations.json', import.meta.url), 'utf8'));

  const response = await fetch(`${url}/status`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), expected);
});

test('status returns the active station list, including an empty list', async (t) => {
  for (const stations of [
    [station('https://example.com/first', 'first'), station('https://example.com/second', 'second')],
    [],
  ]) {
    const url = await listen(t, createRadioServer({ stations }));
    const response = await fetch(`${url}/status?refresh=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), stations);
  }
});

test('status rejects unsupported methods and does not create subroutes', async (t) => {
  const url = await listen(t, createRadioServer());
  const unsupported = await fetch(`${url}/status`, { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET');
  await unsupported.text();

  const missing = await fetch(`${url}/status/icon`);
  assert.equal(missing.status, 404);
  await missing.text();
});

test('reserves the status station ID for the root status endpoint', () => {
  assert.throws(() => createRadioServer({
    stations: [station('https://example.com/audio', 'status')],
  }), /reserved for the status endpoint/);
});

test('returns 502 and logs upstream HTTP failures', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const upstreamUrl = await listen(t, createServer((req, res) => {
    res.writeHead(503);
    res.end('Unavailable');
  }));
  const url = await listen(t, createRadioServer({ stations: [station(upstreamUrl)] }));

  const response = await fetch(`${url}/kissfm`);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Radio stream unavailable\n');
  assert.equal(errors.mock.callCount(), 1);
});

test('returns 502 when the upstream connection fails', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const upstreamUrl = await listen(t, createServer((req) => {
    req.socket.destroy();
  }));
  const url = await listen(t, createRadioServer({ stations: [station(upstreamUrl)] }));

  const response = await fetch(`${url}/kissfm`);
  assert.equal(response.status, 502);
  await response.text();
  assert.equal(errors.mock.callCount(), 1);
});

test('closes the client connection and logs interrupted upstream audio', {
  timeout: 5000,
}, async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  let upstreamResponse;
  const upstreamUrl = await listen(t, createServer((req, res) => {
    upstreamResponse = res;
    res.writeHead(200, { 'Content-Type': 'audio/aac' });
    res.write('first audio chunk');
  }));
  const url = await listen(t, createRadioServer({ stations: [station(upstreamUrl)] }));

  await new Promise((resolve, reject) => {
    const request = get(`${url}/kissfm`, (response) => {
      response.once('aborted', resolve);
      response.on('error', (error) => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      response.once('data', () => upstreamResponse.destroy());
    });
    request.on('error', reject);
  });
  assert.equal(errors.mock.callCount(), 1);
});

test('streams immediately and cancels upstream when the client disconnects', {
  timeout: 5000,
}, async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const upstreamUrl = await listen(t, createServer((req, res) => {
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'Content-Type': 'audio/aac' });
    res.write('first audio chunk');
  }));
  const url = await listen(t, createRadioServer({ stations: [station(upstreamUrl)] }));

  await new Promise((resolve, reject) => {
    const request = get(`${url}/kissfm`, (response) => {
      response.once('data', (chunk) => {
        assert.equal(chunk.toString(), 'first audio chunk');
        response.destroy();
        resolve();
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });
  await closed;
});

test('converts an HLS master playlist with relative segments into decodable MP3', {
  timeout: 15000,
}, async (t) => {
  const segment = await createAudioSegment();
  const upstreamUrl = await listen(t, createServer((req, res) => {
    if (req.url.startsWith('/master.m3u8')) {
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nmedia/playlist.m3u8\n');
    } else if (req.url === '/media/playlist.m3u8') {
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n');
    } else if (req.url === '/media/segment.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(segment);
    } else {
      res.writeHead(404);
      res.end();
    }
  }));
  const url = await listen(t, createRadioServer({
    stations: [station(`${upstreamUrl}/master.m3u8?token=test`, 'radiozu')],
  }));

  const response = await fetch(`${url}/radiozu`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  const audio = Buffer.from(await response.arrayBuffer());
  const decoded = execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0', '-f', 's16le', 'pipe:1',
  ], { encoding: 'buffer' });
  decoded.child.stdin.end(audio);
  const { stdout } = await decoded;
  assert.ok(stdout.length > 0, 'converted stream must decode into audio samples');
});

test('returns 502 and logs FFmpeg errors for an invalid HLS playlist', {
  timeout: 15000,
}, async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const upstreamUrl = await listen(t, createServer((req, res) => {
    res.end('not an HLS playlist');
  }));
  const url = await listen(t, createRadioServer({
    stations: [station(`${upstreamUrl}/invalid.m3u8`, 'radiozu')],
  }));

  const response = await fetch(`${url}/radiozu`);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Radio stream unavailable\n');
  assert.equal(errors.mock.callCount(), 1);
  assert.match(errors.mock.calls[0].arguments[1].message, /FFmpeg exited/);
});

test('stops HLS conversion and closes the upstream connection on client disconnect', {
  timeout: 15000,
}, async (t) => {
  const segment = await createAudioSegment(8);
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const upstreamUrl = await listen(t, createServer((req, res) => {
    if (req.url === '/live.m3u8') {
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXTINF:8,\nsegment.ts\n');
    } else {
      res.on('close', upstreamClosed);
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(segment);
    }
  }));
  const url = await listen(t, createRadioServer({
    stations: [station(`${upstreamUrl}/live.m3u8`, 'radiozu')],
  }));
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${url}/radiozu`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const { value, done } = await response.body.getReader().read();
  assert.ok(!done && value.length > 0);
  controller.abort();
  await closed;
});

test('cancels HLS startup when a listener disconnects before audio is available', {
  timeout: 5000,
}, async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  let upstreamRequested;
  const requested = new Promise((resolve) => { upstreamRequested = resolve; });
  let upstreamClosed;
  const closed = new Promise((resolve) => { upstreamClosed = resolve; });
  const upstreamUrl = await listen(t, createServer((req, res) => {
    res.on('close', upstreamClosed);
    upstreamRequested();
  }));
  const url = await listen(t, createRadioServer({
    stations: [station(`${upstreamUrl}/pending.m3u8`, 'radiozu')],
  }));
  const request = get(`${url}/radiozu`);
  request.on('error', (error) => assert.equal(error.code, 'ECONNRESET'));
  t.after(() => request.destroy());

  await requested;
  request.destroy();
  await closed;
  assert.equal(errors.mock.callCount(), 0);
});

test('creates independent stream and icon endpoints for configured stations', async (t) => {
  const upstreamUrl = await listen(t, createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/aac' });
    res.end(req.url);
  }));
  const url = await listen(t, createRadioServer({
    stations: [
      station(`${upstreamUrl}/first`, 'first'),
      station(`${upstreamUrl}/second`, 'second'),
    ],
  }));
  const expectedIcon = await readFile(new URL('../icons/kissfm.png', import.meta.url));

  for (const id of ['first', 'second']) {
    const audio = await fetch(`${url}/${id}`);
    assert.equal(audio.status, 200);
    assert.equal(await audio.text(), `/${id}`);

    const icon = await fetch(`${url}/${id}/icon?version=1`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.equal(icon.headers.get('content-length'), String(expectedIcon.length));
    assert.deepEqual(Buffer.from(await icon.arrayBuffer()), expectedIcon);
  }

  for (const path of ['/kissfm', '/kissfm/icon', '/first/icon/extra', '/icons/kissfm.png']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 404);
    await response.text();
  }
});

test('serves the configured default station icon and rejects unsupported icon methods', async (t) => {
  const url = await listen(t, createRadioServer());
  const expectedIcon = await readFile(new URL('../icons/kissfm.png', import.meta.url));
  const icon = await fetch(`${url}/kissfm/icon`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await icon.arrayBuffer()), expectedIcon);

  const unsupported = await fetch(`${url}/kissfm/icon`, { method: 'POST' });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('allow'), 'GET');
  await unsupported.text();
});

test('logs missing configured icons and returns 500', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const url = await listen(t, createRadioServer({
    stations: [{ ...station('http://127.0.0.1'), icon: 'nonexistent-test-icon.png' }],
  }));
  const response = await fetch(`${url}/kissfm/icon`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Station icon unavailable\n');
  assert.equal(errors.mock.callCount(), 1);
});

test('rejects duplicate IDs, invalid URLs and icon paths outside the icons folder', () => {
  const valid = station('https://example.com/audio');
  assert.throws(() => createRadioServer({ stations: [valid, valid] }), /Duplicate station ID/);
  assert.throws(() => createRadioServer({
    stations: [{ ...valid, id: 'invalid/station' }],
  }), /Station IDs/);
  assert.throws(() => createRadioServer({
    stations: [{ ...valid, url: 'file:///audio' }],
  }), /HTTP or HTTPS/);
  for (const icon of ['../kissfm.png', '..\\kissfm.png']) {
    assert.throws(() => createRadioServer({
      stations: [{ ...valid, icon }],
    }), /supported icon filename/);
  }
});
