import test from 'node:test';
import assert from 'node:assert/strict';
import { addRecord, freshness, livePoints, newest, validateRange } from '../src/model.js';
const now = Date.parse('2026-10-16T12:00:00Z');
const record = (id, seconds, metrics = { co2_ppm: 720 }) => ({ id, effective_at: new Date(now + seconds * 1000).toISOString(), sampled_at: new Date(now + seconds * 1000).toISOString(), time_quality: 'device', metrics });

test('late historical uploads and stale REST snapshots do not roll latest backwards', () => {
  const current = record(5, 0);
  assert.equal(newest(current, record(9, -30)), current);
  assert.equal(newest(current, null), current);
  assert.equal(newest(current, record(4, 0)), current);
  assert.equal(newest(current, record(6, 2)).id, 6);
});
test('freshness expires without new events and unknown sample time never claims freshness', () => {
  const current = record(5, 0);
  assert.equal(freshness(current, { stale: false }, now + 9000), 'fresh');
  assert.equal(freshness(current, { stale: false }, now + 11000), 'stale');
  assert.equal(freshness({ ...current, sampled_at: null, time_quality: 'received_only' }, {}, now), 'unknown');
  assert.equal(freshness(null, {}, now), 'empty');
});
test('record ID de-duplication, bounded window, missing values and REST/SSE boundary', () => {
  const current = record(5, 0, { co2_ppm: null });
  let records = addRecord([], record(1, -700), now);
  assert.equal(records.length, 0);
  records = addRecord(records, current, now);
  assert.equal(addRecord(records, current, now).length, 1);
  const points = livePoints({ points: [{ time: record(2, -10).sampled_at, value: 800, count: 1 }], end: now - 5000 }, [...records, record(3, -10), { ...record(6, 0), time_quality: 'received_only' }], 'co2_ppm', now);
  assert.equal(points.length, 2);
  assert.equal(points[0].value, 800);
  assert.equal(points[1].value, null);
  assert.equal(points[1].count, 0);
});
test('history accepts seven days and rejects invalid, reversed or oversized ranges', () => {
  assert.equal(validateRange(now - 7 * 86400000, now), '');
  assert.match(validateRange(now - 7 * 86400000 - 1, now), /7 天/);
  assert.match(validateRange('bad', now), /完整/);
  assert.match(validateRange(now, now), /晚于/);
});
