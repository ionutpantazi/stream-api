import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const KISSFM_URL = 'https://live.kissfm.ro/kissfm.aacp';
const UPSTREAM_TIMEOUT_MS = 10_000;

export function createRadioServer({ streamUrl = KISSFM_URL } = {}) {
  return createServer(async (req, res) => {
    if (req.url.split('?')[0] !== '/kissfm') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found\n');
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain' });
      res.end('Method not allowed\n');
      return;
    }

    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.once('close', onClose);
    const timeout = setTimeout(() => {
      controller.abort(new Error('Upstream connection timed out'));
    }, UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetch(streamUrl, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!upstream.ok || !upstream.body) {
        throw new Error(`Upstream returned HTTP ${upstream.status}`);
      }

      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'audio/aac',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const audio = Readable.fromWeb(upstream.body);
      audio.once('error', (error) => {
        if (!controller.signal.aborted) {
          console.error('Kiss FM stream interrupted:', error);
        }
      });
      await pipeline(audio, res);
    } catch (error) {
      if (!res.destroyed) {
        console.error('Kiss FM stream failed:', error);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Radio stream unavailable\n');
        } else {
          res.destroy();
        }
      }
    } finally {
      clearTimeout(timeout);
      res.off('close', onClose);
      controller.abort();
    }
  });
}
