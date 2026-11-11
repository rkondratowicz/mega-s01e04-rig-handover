import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const night = '2026-10-28';
const configBase = {
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
};

let runsDir: string;

async function writeNight(contents: string, nightName = night): Promise<void> {
  await writeFile(join(runsDir, `${nightName}.jsonl`), contents, 'utf8');
}

function htmlRows(html: string): Map<string, string> {
  const rows = new Map<string, string>();
  const rowPattern = /<tr\b[^>]*\bdata-job="([^"]*)"[^>]*>[\s\S]*?<\/tr>/gi;

  for (const match of html.matchAll(rowPattern)) {
    rows.set(decodeHtmlAttribute(match[1]), match[0]);
  }

  return rows;
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
    const named: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
    };

    if (code[0] !== '#') return named[code.toLowerCase()];

    const numeric = code[1]?.toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return String.fromCodePoint(numeric);
  });
}

function expectWarningMark(row: string): void {
  expect(row).toMatch(/warning|warn|attention|danger|fail(?:ed|ure)?|⚠|❗/i);
}

describe('digest routes', () => {
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'rig-digest-routes-'));
  });

  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  it('serves escaped HTML and matching JSON rows with warning marks and original offsets', async () => {
    await writeNight([
      JSON.stringify({ at: '2026-10-28T08:00:00-04:00', job: 'a<&', status: 'retry', owner: 'R&D' }),
      JSON.stringify({ at: '2026-10-28T08:01:00-04:00', job: 'a<&', status: 'retry', owner: 'R&D' }),
      JSON.stringify({ at: '2026-10-28T08:02:00-04:00', job: 'a<&', status: 'retry', owner: 'R&D' }),
      JSON.stringify({ at: '2026-10-28T08:04:00-04:00', job: 'a<&', status: 'ok', owner: null }),
      JSON.stringify({ at: '2026-10-28T08:03:00-04:00', job: 'm-recovered', status: 'fail', owner: 'R&D', error: '<broken>&' }),
      JSON.stringify({ at: '2026-10-28T08:04:00-04:00', job: 'm-recovered', status: 'ok', owner: 'R&D' }),
      JSON.stringify({ at: '2026-10-28T09:00:00+05:30', job: 'zeta', status: 'ok', owner: 'Sam' }),
    ].join('\n'));

    const app = createApp({ ...configBase, runsDir });
    const [pageResponse, jsonResponse] = await Promise.all([
      app.request(`/digest/${night}`),
      app.request(`/api/digest/${night}`),
    ]);
    const html = await pageResponse.text();
    const digest = await jsonResponse.json() as NightDigest;

    expect(pageResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(Object.keys(digest).sort()).toEqual(['badLines', 'counts', 'rows']);
    expect(digest.rows.map((row) => row.job)).toEqual(['a<&', 'm-recovered', 'zeta']);
    expect(digest).toEqual({
      badLines: 0,
      counts: { ok: 3, retry: 3, fail: 1 },
      rows: [
        {
          job: 'a<&',
          owner: null,
          runs: 4,
          retries: 3,
          failures: 0,
          lastStatus: 'ok',
          lastError: null,
          firstAt: '2026-10-28T08:00:00-04:00',
          lastAt: '2026-10-28T08:04:00-04:00',
        },
        {
          job: 'm-recovered',
          owner: 'R&D',
          runs: 2,
          retries: 0,
          failures: 1,
          lastStatus: 'ok',
          lastError: '<broken>&',
          firstAt: '2026-10-28T08:03:00-04:00',
          lastAt: '2026-10-28T08:04:00-04:00',
        },
        {
          job: 'zeta',
          owner: 'Sam',
          runs: 1,
          retries: 0,
          failures: 0,
          lastStatus: 'ok',
          lastError: null,
          firstAt: '2026-10-28T09:00:00+05:30',
          lastAt: '2026-10-28T09:00:00+05:30',
        },
      ],
    });

    expect(html).toContain('—');
    expect(html).toContain('2026-10-28T08:00:00-04:00');
    expect(html).toContain('2026-10-28T08:04:00-04:00');
    expect(html).toContain('2026-10-28T09:00:00+05:30');
    expect(html).toContain('&lt;broken&gt;&amp;');
    expect(html).not.toContain('<broken>&');

    const renderedRows = htmlRows(html);
    expect([...renderedRows.keys()]).toEqual(digest.rows.map((row) => row.job));
    expectWarningMark(renderedRows.get('a<&') ?? '');
    expectWarningMark(renderedRows.get('m-recovered') ?? '');
  });

  it('returns a 404 for an absent night on both routes', async () => {
    const app = createApp({ ...configBase, runsDir });
    const [pageResponse, jsonResponse] = await Promise.all([
      app.request(`/digest/${night}`),
      app.request(`/api/digest/${night}`),
    ]);

    expect(pageResponse.status).toBe(404);
    expect(jsonResponse.status).toBe(404);
  });

  it('renders an empty or whitespace-only night as nothing ran', async () => {
    await writeNight(' \n\t\n');

    const app = createApp({ ...configBase, runsDir });
    const [pageResponse, jsonResponse] = await Promise.all([
      app.request(`/digest/${night}`),
      app.request(`/api/digest/${night}`),
    ]);
    const html = await pageResponse.text();
    const digest = await jsonResponse.json();

    expect(pageResponse.status).toBe(200);
    expect(html).toContain('nothing ran');
    expect(jsonResponse.status).toBe(200);
    expect(digest).toEqual({
      rows: [],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('counts malformed JSON and invalid schemas without dropping valid jobs', async () => {
    await writeNight([
      '{not json',
      JSON.stringify({ at: '2026-10-28T08:00:00Z', job: 'missing-owner', status: 'ok' }),
      JSON.stringify({ at: '2026-10-28T08:01:00Z', job: 'invalid-status', status: 'queued', owner: 'Ari' }),
      JSON.stringify({ at: '2026-10-28T08:02:00Z', job: 'valid-job', status: 'ok', owner: 'Lee' }),
    ].join('\n'));

    const app = createApp({ ...configBase, runsDir });
    const [pageResponse, jsonResponse] = await Promise.all([
      app.request(`/digest/${night}`),
      app.request(`/api/digest/${night}`),
    ]);
    const html = await pageResponse.text();
    const digest = await jsonResponse.json() as NightDigest;

    expect(pageResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(digest).toMatchObject({
      badLines: 3,
      counts: { ok: 1, retry: 0, fail: 0 },
      rows: [{ job: 'valid-job' }],
    });
    expect(digest.rows.map((row) => row.job)).toEqual(['valid-job']);
    expect(html).toContain('valid-job');
    expect(html).not.toContain('missing-owner');
    expect(html).not.toContain('invalid-status');
    expect(htmlRows(html).has('valid-job')).toBe(true);
  });
});
