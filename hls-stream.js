import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import ffmpegPath from 'ffmpeg-static';

export async function openHlsStream(url, { signal }) {
  signal.throwIfAborted();
  if (!ffmpegPath) {
    throw new Error('FFmpeg is not available for this platform');
  }

  const output = new PassThrough();
  const ready = once(output, 'readable');
  const converter = spawn(ffmpegPath, [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-rw_timeout', '10000000',
    '-i', url,
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-f', 'mp3',
    '-flush_packets', '1',
    'pipe:1',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let diagnostics = '';
  converter.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-8192);
  });
  converter.stdout.pipe(output, { end: false });
  converter.stdout.once('error', (error) => output.destroy(error));
  converter.once('error', (error) => output.destroy(error));

  const onAbort = () => output.destroy(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  output.once('close', () => {
    if (converter.exitCode === null && converter.signalCode === null) {
      converter.kill();
    }
  });
  converter.once('close', (code) => {
    signal.removeEventListener('abort', onAbort);
    if (code === 0) {
      output.end();
    } else {
      output.destroy(new Error(`FFmpeg exited with code ${code}: ${diagnostics.trim()}`));
    }
  });

  await ready;
  if (output.readableLength === 0) {
    output.destroy();
    throw new Error('FFmpeg produced no audio');
  }
  return output;
}
