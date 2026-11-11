import type { Hono } from 'hono';
import { readNight } from './read-night.js';
import type { RigConfig } from '../config.js';

export function registerDigestJson(app: Hono, config: RigConfig): void {
  app.get('/api/digest/:night', (c) => {
    const digest = readNight(config.runsDir, c.req.param('night'));

    if (digest === null) {
      return c.json({ error: 'night not found' }, 404);
    }

    return c.json(digest, 200);
  });
}
