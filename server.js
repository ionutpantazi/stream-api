import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import configuredStations from './stations.json' with { type: 'json' };

const UPSTREAM_TIMEOUT_MS = 10_000;
const ICONS_DIRECTORY = fileURLToPath(new URL('./icons/', import.meta.url));
const ICON_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'],
]);

export function createRadioServer({ stations = configuredStations } = {}) {
  const routes = new Map();
  for (const station of stations) {
    if (typeof station.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(station.id)) {
      throw new Error('Station IDs must contain lowercase letters, digits or hyphens');
    }
    if (station.id === 'status') {
      throw new Error('Station ID "status" is reserved for the status endpoint');
    }
    if (routes.has(`/${station.id}`)) {
      throw new Error(`Duplicate station ID: ${station.id}`);
    }
    if (!['http:', 'https:'].includes(new URL(station.url).protocol)) {
      throw new Error(`Station ${station.id} must have an HTTP or HTTPS stream URL`);
    }
    if (typeof station.icon !== 'string' ||
        basename(station.icon) !== station.icon ||
        station.icon.includes('\\') ||
        !ICON_TYPES.has(extname(station.icon).toLowerCase())) {
      throw new Error(`Station ${station.id} must reference a supported icon filename`);
    }
    routes.set(`/${station.id}`, { station, isIcon: false });
    routes.set(`/${station.id}/icon`, { station, isIcon: true });
  }

  return createServer(async (req, res) => {
    const path = req.url.split('?')[0];
    const route = routes.get(path);
    if (!route && path !== '/status') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found\n');
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain' });
      res.end('Method not allowed\n');
      return;
    }

    if (path === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stations));
      return;
    }

    const { station, isIcon } = route;
    if (isIcon) {
      try {
        const icon = await readFile(join(ICONS_DIRECTORY, station.icon));
        if (!res.destroyed) {
          res.writeHead(200, {
            'Content-Type': ICON_TYPES.get(extname(station.icon).toLowerCase()),
            'Content-Length': icon.length,
          });
          res.end(icon);
        }
      } catch (error) {
        console.error(`Station ${station.id} icon failed:`, error);
        if (!res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Station icon unavailable\n');
        }
      }
      return;
    }

    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.once('close', onClose);
    const timeout = setTimeout(() => {
      controller.abort(new Error('Upstream connection timed out'));
    }, UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetch(station.url, {
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
          console.error(`Station ${station.id} stream interrupted:`, error);
        }
      });
      await pipeline(audio, res);
    } catch (error) {
      if (!res.destroyed) {
        console.error(`Station ${station.id} stream failed:`, error);
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
