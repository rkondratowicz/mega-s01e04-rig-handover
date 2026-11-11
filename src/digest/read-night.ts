import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, ReadNight } from './types.js';

type Instant = {
  second: number;
  leapSecond: boolean;
  fraction: string;
};

type Event = {
  at: string;
  instant: Instant;
  job: string;
  status: DigestStatus;
  owner: string | null;
  error?: string;
  line: number;
};

// RFC 3339 permits :60 only at an inserted UTC leap second. Extend this set if
// another insertion is announced; a possible June/December date alone is not valid.
const leapSecondDates = new Set([
  '1972-06-30', '1972-12-31', '1973-12-31', '1974-12-31', '1975-12-31',
  '1976-12-31', '1977-12-31', '1978-12-31', '1979-12-31', '1981-06-30',
  '1982-06-30', '1983-06-30', '1985-06-30', '1987-12-31', '1989-12-31',
  '1990-12-31', '1992-06-30', '1993-06-30', '1994-06-30', '1995-12-31',
  '1997-06-30', '1998-12-31', '2005-12-31', '2008-12-31', '2012-06-30',
  '2015-06-30', '2016-12-31',
]);

function parseInstant(at: string): Instant | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(at);
  if (!match || match[0] !== at) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 60) return null;

  let offsetMinutes = 0;
  if (offset !== 'Z' && offset !== 'z') {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (offset[0] === '+' ? 1 : -1);
  }

  // setUTCFullYear avoids Date.UTC's special treatment of years 00 through 99.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, Math.min(second, 59), 0);
  const utcSecond = date.getTime() / 1000 - offsetMinutes * 60;
  const leapSecond = second === 60;
  if (leapSecond) {
    const utcDate = new Date(utcSecond * 1000);
    if (utcDate.getUTCHours() !== 23 || utcDate.getUTCMinutes() !== 59
      || !leapSecondDates.has(utcDate.toISOString().slice(0, 10))) return null;
  }
  return {
    second: utcSecond,
    leapSecond,
    // Keep precision beyond milliseconds; normalized decimal fractions sort as strings.
    fraction: (fraction ?? '').replace(/0+$/, ''),
  };
}

function parseEvent(text: string, line: number): Event | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string'
    || typeof record.job !== 'string' || record.job.trim() === ''
    || (record.status !== 'ok' && record.status !== 'retry' && record.status !== 'fail')
    || (typeof record.owner !== 'string' && record.owner !== null)
    || ('error' in record && typeof record.error !== 'string')) return null;

  const instant = parseInstant(record.at);
  if (!instant) return null;
  return {
    at: record.at,
    instant,
    job: record.job,
    status: record.status,
    owner: record.owner,
    error: record.error as string | undefined,
    line,
  };
}

function compareEvents(a: Event, b: Event): number {
  if (a.instant.second !== b.instant.second) return a.instant.second - b.instant.second;
  // An inserted second follows all fractions of :59, but precedes the next :00.
  if (a.instant.leapSecond !== b.instant.leapSecond) return a.instant.leapSecond ? 1 : -1;
  if (a.instant.fraction !== b.instant.fraction) {
    return a.instant.fraction < b.instant.fraction ? -1 : 1;
  }
  return a.line - b.line;
}

export const readNight: ReadNight = (runsDir, night) => {
  // The length check also rejects the final newline allowed by JavaScript's $ anchor.
  if (night.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(night)) return null;

  let text: string;
  try {
    text = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const events: Event[] = [];
  let badLines = 0;
  for (const [line, textLine] of text.split('\n').entries()) {
    if (textLine.trim() === '') continue;
    const event = parseEvent(textLine, line);
    if (event) events.push(event);
    else badLines += 1;
  }

  const counts = { ok: 0, retry: 0, fail: 0 };
  const jobs = new Map<string, DigestRow>();
  for (const event of events.sort(compareEvents)) {
    counts[event.status] += 1;
    const row = jobs.get(event.job);
    if (row) {
      row.owner = event.owner;
      row.runs += 1;
      row.retries += Number(event.status === 'retry');
      row.failures += Number(event.status === 'fail');
      row.lastStatus = event.status;
      if (event.error !== undefined) row.lastError = event.error;
      row.lastAt = event.at;
    } else {
      jobs.set(event.job, {
        job: event.job,
        owner: event.owner,
        runs: 1,
        retries: Number(event.status === 'retry'),
        failures: Number(event.status === 'fail'),
        lastStatus: event.status,
        lastError: event.error ?? null,
        firstAt: event.at,
        lastAt: event.at,
      });
    }
  }

  const rows = [...jobs.values()].sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return { rows, badLines, counts };
};
