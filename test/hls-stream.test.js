import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { openHlsStream } from '../hls-stream.js';

function mockConverter(t) {
  const converter = new EventEmitter();
  converter.stdout = new PassThrough();
  converter.stderr = new PassThrough();
  converter.exitCode = null;
  converter.signalCode = null;
  converter.kill = t.mock.fn(() => true);
  t.mock.method(childProcess, 'spawn', () => converter);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return converter;
}

test('reports the termination signal when FFmpeg exits without an exit code', async (t) => {
  const converter = mockConverter(t);
  const pending = openHlsStream('https://example.com/live.m3u8', {
    signal: new AbortController().signal,
  });
  converter.signalCode = 'SIGKILL';
  converter.emit('close', null, 'SIGKILL');

  await assert.rejects(pending, (error) => {
    assert.match(error.message, /FFmpeg terminated by signal SIGKILL: no stderr output/);
    assert.equal(error.code, 'ERR_FFMPEG_EXIT');
    assert.equal(error.exitCode, null);
    assert.equal(error.signal, 'SIGKILL');
    return true;
  });
});

test('retains FFmpeg diagnostics alongside a crash signal', async (t) => {
  const converter = mockConverter(t);
  const pending = openHlsStream('https://example.com/live.m3u8', {
    signal: new AbortController().signal,
  });
  converter.stderr.write('decoder crashed\n');
  converter.signalCode = 'SIGSEGV';
  converter.emit('close', null, 'SIGSEGV');

  await assert.rejects(pending, /terminated by signal SIGSEGV: decoder crashed/);
});

test('preserves the original cancellation reason when stopping FFmpeg', async (t) => {
  const converter = mockConverter(t);
  const controller = new AbortController();
  const pending = openHlsStream('https://example.com/live.m3u8', {
    signal: controller.signal,
  });
  const reason = new Error('Upstream connection timed out');
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(converter.kill.mock.callCount(), 1);
  converter.signalCode = 'SIGTERM';
  converter.emit('close', null, 'SIGTERM');
});
