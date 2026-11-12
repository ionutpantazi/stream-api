import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import test from 'node:test';
import { createRadioServer } from '../server.js';

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
  const url = await listen(t, createRadioServer({ streamUrl: upstreamUrl }));

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

test('returns 502 and logs upstream HTTP failures', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const upstreamUrl = await listen(t, createServer((req, res) => {
    res.writeHead(503);
    res.end('Unavailable');
  }));
  const url = await listen(t, createRadioServer({ streamUrl: upstreamUrl }));

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
  const url = await listen(t, createRadioServer({ streamUrl: upstreamUrl }));

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
  const url = await listen(t, createRadioServer({ streamUrl: upstreamUrl }));

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
  const url = await listen(t, createRadioServer({ streamUrl: upstreamUrl }));

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
