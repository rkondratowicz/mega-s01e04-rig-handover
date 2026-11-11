import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readNight } from '../src/digest/read-night.js';

vi.mock('node:fs', { spy: true });

const root = fileURLToPath(new URL('../', import.meta.url));
const night = '2026-10-28';
const baseEvent = { at: '2026-10-28T23:00:00+01:00', job: 'job', status: 'ok', owner: 'rook' };
const emptyDigest = { rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
const temporaryDirs: string[] = [];

function runsDir(): string {
  const dir = fs.mkdtempSync(join(root, '.digest-reader-test-'));
  temporaryDirs.push(dir);
  return dir;
}

function writeLog(lines: unknown[], identifier = night): string {
  const dir = runsDir();
  fs.writeFileSync(join(dir, `${identifier}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n'));
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readNight', () => {
  it('reads the real fixture without changing it: five jobs, one bad line, event counts', () => {
    const digest = readNight(join(root, 'runs'), night);
    expect(digest).toEqual({
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        {
          job: 'digest/render', owner: null, runs: 1, retries: 0, failures: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00',
        },
        {
          job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, failures: 0,
          lastStatus: 'ok', lastError: 'upstream 503',
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
        },
        {
          job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, failures: 0,
          lastStatus: 'ok', lastError: 'lock held',
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00',
        },
        {
          job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, failures: 1,
          lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00',
        },
        {
          job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, failures: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00',
        },
      ],
    });
    expect(digest?.rows.reduce((sum, row) => sum + row.runs, 0)).toBe(15);
  });

  it('orders events by instant, breaking ties by line, and retains offsets and failures after recovery', () => {
    const dir = writeLog([
      { ...baseEvent, at: '2026-10-29T05:30:00+02:00', owner: 'previous owner' },
      { ...baseEvent, at: '2026-10-29T03:20:00Z', status: 'retry', error: 'latest supplied error' },
      { ...baseEvent, at: '2026-10-29T04:15:00+01:00', status: 'fail', error: 'older error' },
      { ...baseEvent, at: '2026-10-29T03:30:00Z', owner: null },
      { ...baseEvent, at: '2026-10-29T05:00:00+02:00', status: 'retry', error: 'first error' },
    ]);
    expect(readNight(dir, night)).toEqual({
      badLines: 0,
      counts: { ok: 2, retry: 2, fail: 1 },
      rows: [{
        job: 'job', owner: null, runs: 5, retries: 2, failures: 1,
        lastStatus: 'ok', lastError: 'latest supplied error',
        firstAt: '2026-10-29T05:00:00+02:00', lastAt: '2026-10-29T03:30:00Z',
      }],
    });
  });

  it('uses the later line for equal instants, including errors supplied as empty strings', () => {
    const dir = writeLog([
      { ...baseEvent, at: '2026-10-28T23:00:00.100Z', status: 'fail', error: 'earlier line' },
      { ...baseEvent, at: '2026-10-29T00:00:00.1+01:00', status: 'retry', owner: '', error: '' },
    ]);
    expect(readNight(dir, night)?.rows).toEqual([{
      job: 'job', owner: '', runs: 2, retries: 1, failures: 1,
      lastStatus: 'retry', lastError: '',
      firstAt: '2026-10-28T23:00:00.100Z', lastAt: '2026-10-29T00:00:00.1+01:00',
    }]);
  });

  it('compares fractional seconds without losing precision after milliseconds', () => {
    const dir = writeLog([
      { ...baseEvent, at: '2026-10-28T23:00:00.1234567891Z', owner: 'latest' },
      { ...baseEvent, at: '2026-10-28T23:00:00.123456789Z', status: 'retry', error: 'old tie' },
      { ...baseEvent, at: '2026-10-28T23:00:00.123456788Z', owner: 'earliest' },
      { ...baseEvent, at: '2026-10-28T23:00:00.1234567890Z', error: 'new tie' },
    ]);
    expect(readNight(dir, night)?.rows[0]).toEqual({
      job: 'job', owner: 'latest', runs: 4, retries: 1, failures: 0,
      lastStatus: 'ok', lastError: 'new tie',
      firstAt: '2026-10-28T23:00:00.123456788Z', lastAt: '2026-10-28T23:00:00.1234567891Z',
    });
  });

  it('keeps exact arbitrary nonblank job strings safe and sorts with JS string comparison', () => {
    const jobs = ['__proto__', 'constructor', 'toString', 'a', 'Z', 'A', ' a ', 'job/with/slashes', 'é'];
    const dir = writeLog(jobs.flatMap(job => [
      { ...baseEvent, job, status: 'fail', error: 'first' },
      { ...baseEvent, job, owner: null },
    ]));
    const digest = readNight(dir, night);
    expect(digest?.rows.map(row => row.job)).toEqual([
      ' a ', 'A', 'Z', '__proto__', 'a', 'constructor', 'job/with/slashes', 'toString', 'é',
    ]);
    expect(digest?.counts).toEqual({ ok: 9, retry: 0, fail: 9 });
    for (const row of digest?.rows ?? []) {
      expect(row).toMatchObject({ owner: null, runs: 2, retries: 0, failures: 1, lastStatus: 'ok', lastError: 'first' });
    }
  });

  it('orders a real leap second between :59 and the next :00, including equivalent offsets', () => {
    const dir = writeLog([
      { ...baseEvent, at: '2017-01-01T00:00:00Z', owner: null },
      { ...baseEvent, at: '2016-12-31T23:59:60.3Z', status: 'fail', error: 'during leap second' },
      { ...baseEvent, at: '2016-12-31T23:59:59.99Z', status: 'retry', error: 'before leap second' },
      { ...baseEvent, at: '2017-01-01T00:59:60.300+01:00', error: 'later line at same instant' },
    ]);
    expect(readNight(dir, night)).toEqual({
      badLines: 0, counts: { ok: 2, retry: 1, fail: 1 },
      rows: [{
        job: 'job', owner: null, runs: 4, retries: 1, failures: 1,
        lastStatus: 'ok', lastError: 'later line at same instant',
        firstAt: '2016-12-31T23:59:59.99Z', lastAt: '2017-01-01T00:00:00Z',
      }],
    });
  });

  it.each([
    '0000-02-29T00:00:00Z',
    '0099-01-01T00:00:00Z',
    '2000-02-29T23:59:59.000000001Z',
    '2016-12-31T23:59:60Z',
    '2017-01-01T00:59:60+01:00',
    '2024-02-29t12:34:56z',
    '2026-10-28T23:00:00-05:30',
    '2026-10-28T23:00:00-00:00',
    '2026-10-28T23:00:00+23:59',
  ])('accepts a calendar-valid RFC 3339 timestamp without changing it: %s', at => {
    const dir = writeLog([{ ...baseEvent, at, owner: ' ', error: '', unknown: { ignored: true } }]);
    expect(readNight(dir, night)?.rows).toEqual([{
      job: 'job', owner: ' ', runs: 1, retries: 0, failures: 0,
      lastStatus: 'ok', lastError: '', firstAt: at, lastAt: at,
    }]);
  });

  it('rejects invalid JSON and schemas once per nonblank line without leaking into aggregates', () => {
    const { at, job, status, owner } = baseEvent;
    const invalid: unknown[] = [
      null, [], [baseEvent], 'string', 3, true, {},
      { job, status, owner }, { at, status, owner }, { at, job, owner }, { at, job, status },
      { ...baseEvent, at: null }, { ...baseEvent, job: null }, { ...baseEvent, job: 1 },
      { ...baseEvent, job: '' }, { ...baseEvent, job: ' \t\r\n ' },
      { ...baseEvent, status: 'unknown' }, { ...baseEvent, status: '__proto__' },
      { ...baseEvent, owner: 1 }, { ...baseEvent, owner: {} },
      { ...baseEvent, error: null }, { ...baseEvent, error: 1 },
    ];
    const invalidTimes = [
      '', 'not a date', '2026-10-28', '2026-10-28T23:00:00',
      '2026-10-28 23:00:00Z', '2026-10-28T23:00Z', '2026-10-28T23:00:00+0100',
      '2026-10-28T23:00:00.Z', '2026-10-28T23:00:00Z\n', ' 2026-10-28T23:00:00Z',
      '2026-02-29T12:00:00Z', '1900-02-29T12:00:00Z', '2026-02-30T12:00:00Z',
      '2026-04-31T12:00:00Z', '2026-00-01T12:00:00Z', '2026-13-01T12:00:00Z',
      '2026-10-00T12:00:00Z', '2026-10-32T12:00:00Z', '2026-10-28T24:00:00Z',
      '2026-10-28T12:60:00Z', '2026-10-28T12:00:61Z',
      '2026-10-28T12:00:60Z', '2016-12-30T23:59:60Z',
      '2016-12-31T22:59:60Z', '2017-01-01T00:59:60+02:00',
      '2026-10-28T12:00:00+24:00', '2026-10-28T12:00:00-01:60',
    ];
    invalid.push(...invalidTimes.map(at => ({ ...baseEvent, at, status: 'fail', owner: null, error: 'invalid' })));
    const dir = writeLog([baseEvent, ...invalid]);
    fs.appendFileSync(join(dir, `${night}.jsonl`), '\n{broken\n{"job":\n \t\r\n\n');
    expect(readNight(dir, night)).toEqual({
      counts: { ok: 1, retry: 0, fail: 0 }, badLines: invalid.length + 2,
      rows: [{
        job, owner, runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null,
        firstAt: at, lastAt: at,
      }],
    });
  });

  it.each(['', ' \t\r\n\n\t \r\n'])('returns an empty digest for an empty or whitespace-only file', text => {
    const dir = runsDir();
    fs.writeFileSync(join(dir, `${night}.jsonl`), text);
    expect(readNight(dir, night)).toEqual(emptyDigest);
  });

  it('ignores blank lines and accepts CRLF line endings', () => {
    const dir = runsDir();
    fs.writeFileSync(join(dir, `${night}.jsonl`), `\r\n \t\r\n${JSON.stringify(baseEvent)}\r\n\r\n`);
    expect(readNight(dir, night)).toMatchObject({ badLines: 0, counts: { ok: 1, retry: 0, fail: 0 } });
  });

  it('distinguishes an all-bad file from a missing file', () => {
    const dir = writeLog([null, { invalid: true }]);
    expect(readNight(dir, night)).toEqual({ ...emptyDigest, badLines: 2 });
    expect(readNight(dir, '2026-10-29')).toBeNull();
    expect(readNight(join(dir, 'missing-directory'), night)).toBeNull();
  });

  it('rejects invalid night identifiers before filesystem access', () => {
    const read = vi.mocked(fs.readFileSync);
    read.mockClear();
    for (const identifier of [
      '', '../2026-10-28', '2026-10-28/../../outside', '/2026-10-28', '2026-10-28.jsonl',
      '2026-1-28', ' 2026-10-28', '2026-10-28\n', '2026-10-28\r\n', '2026-10-28\0',
      '２０２６-１０-２８', '2026-10-28\\outside',
    ]) expect(readNight('irrelevant-directory', identifier)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('uses a matching night identifier literally, without normalizing its calendar date', () => {
    const dir = writeLog([baseEvent], '2026-02-30');
    expect(readNight(dir, '2026-02-30')?.rows[0].job).toBe('job');
  });

  it('propagates I/O errors other than ENOENT', () => {
    const dir = runsDir();
    fs.mkdirSync(join(dir, `${night}.jsonl`));
    expect(() => readNight(dir, night)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
    const notDirectory = join(dir, 'regular-file');
    fs.writeFileSync(notDirectory, 'not a directory');
    expect(() => readNight(notDirectory, night)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });
});
