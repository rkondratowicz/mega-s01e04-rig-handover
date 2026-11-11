import type { Hono } from 'hono';
import { lane } from '../lane.js';
import { Layout } from '../views/layout.js';
import { DigestPage } from '../views/digest.js';
import type { RigConfig } from '../config.js';
import { readNight } from './read-night.js';

export function registerDigestPage(app: Hono, config: RigConfig): void {
  app.get('/digest/:night', (c) => {
    const night = c.req.param('night');
    const digest = readNight(config.runsDir, night);

    if (digest === null) return c.notFound();

    return c.html(
      <Layout title={`digest · ${night}`} lane={lane()}>
        <DigestPage night={night} digest={digest} />
      </Layout>,
    );
  });
}
