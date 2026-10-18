import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { AlarmState } from '../src/alarms.js';
import { DEFAULT_THRESHOLDS } from '../src/config.js';
import { canonicalJson, parseSeries, validateTelemetry, validateThresholds } from '../src/validation.js';
import { DEVICE, message, temporaryDatabase, cleanTemporaryDatabase } from './helpers.js';

test('deduplication compares full canonical business content and survives restart', t => {
  const path = temporaryDatabase(t);
  let store = new Store(path, 'classroom-001', DEVICE);
  t.after(() => { store.close(); cleanTemporaryDatabase(path); });
  const original = message();
  const first = store.store(original, new Date().toISOString());
  assert.equal(first.status, 'stored');
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.metrics = Object.fromEntries(Object.entries(original.metrics).reverse());
  assert.equal(canonicalJson(original), canonicalJson(reordered));
  const duplicate = store.store(reordered, new Date().toISOString());
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.record.stored_at, first.record.stored_at);
  assert.throws(() => store.store({ ...original, source: 'hardware' }, new Date().toISOString()), { code: 'MESSAGE_CONFLICT' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM measurements').get().n, 1);
  const changed = structuredClone(DEFAULT_THRESHOLDS);
  delete changed.version;
  changed.rules.co2_ppm.upper = 1200;
  const saved = store.saveThresholds(DEVICE, validateThresholds(changed));
  store.close();
  store = new Store(path, 'classroom-001', DEVICE);
  assert.equal(store.latest(DEVICE).id, first.record.id);
  assert.deepEqual(store.thresholds(DEVICE), saved);
  assert.equal(store.store(original, new Date().toISOString()).status, 'duplicate');
});

test('a COMMIT failure rolls back the row and emits no stored result', t => {
  const store = new Store(':memory:', 'classroom-001', DEVICE);
  t.after(() => store.close());
  store.db.exec(`CREATE TABLE guard (device_id TEXT REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_commit AFTER INSERT ON measurements BEGIN INSERT INTO guard VALUES ('missing'); END;`);
  assert.throws(() => store.store(message(), new Date().toISOString()), /FOREIGN KEY/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM measurements').get().n, 0);
  store.db.exec('DROP TRIGGER fail_commit');
  assert.equal(store.store(message(), new Date().toISOString()).status, 'stored');
});

function alarmHarness() {
  const alarm = new AlarmState(structuredClone(DEFAULT_THRESHOLDS), 10000);
  const base = Date.now();
  let i = 0;
  return { alarm, sample(metrics, offset) {
    const ms = offset ?? base + (++i) * 10;
    const value = message(i, new Date(ms).toISOString(), metrics);
    return alarm.sample({ ...value, effective_at: value.sampled_at, time_quality: 'device' }, ms);
  } };
}

test('alarms require consecutive exceedance/recovery, enforce hysteresis and preserve on missing data', () => {
  const { alarm, sample } = alarmHarness();
  sample({ co2_ppm: 1100 });
  sample({ co2_ppm: 1100 });
  assert.deepEqual(alarm.alarms(), []);
  assert.equal(sample({ co2_ppm: 1100 }), true);
  assert.equal(alarm.alarms()[0].state, 'high');
  sample({ co2_ppm: 950 });
  sample({ co2_ppm: 900 });
  sample({ co2_ppm: null });
  sample({ co2_ppm: 900 });
  sample({ co2_ppm: 900 });
  assert.equal(alarm.alarms().length, 1);
  sample({ co2_ppm: 900 });
  assert.deepEqual(alarm.alarms(), []);
});

test('crossing directly to the opposite limit does not recover; low hysteresis works', () => {
  const { alarm, sample } = alarmHarness();
  for (let i = 0; i < 3; i++) sample({ temperature_c: 31 });
  for (let i = 0; i < 3; i++) sample({ temperature_c: 15 });
  assert.equal(alarm.alarms()[0].state, 'high');
  for (let i = 0; i < 3; i++) sample({ temperature_c: 29 });
  assert.deepEqual(alarm.alarms(), []);
  for (let i = 0; i < 3; i++) sample({ temperature_c: 15 });
  assert.equal(alarm.alarms()[0].state, 'low');
  for (let i = 0; i < 3; i++) sample({ temperature_c: 16.5 });
  assert.equal(alarm.alarms().length, 1);
  for (let i = 0; i < 3; i++) sample({ temperature_c: 17 });
  assert.deepEqual(alarm.alarms(), []);
});

test('rule updates reset pending counts, retain active alarms, and require subsequent samples', () => {
  const { alarm, sample } = alarmHarness();
  sample({ co2_ppm: 1100 }); sample({ co2_ppm: 1100 });
  alarm.configure(structuredClone(DEFAULT_THRESHOLDS));
  sample({ co2_ppm: 1100 });
  assert.deepEqual(alarm.alarms(), []);
  sample({ co2_ppm: 1100 }); sample({ co2_ppm: 1100 });
  const next = structuredClone(DEFAULT_THRESHOLDS);
  next.rules.co2_ppm.enabled = false;
  alarm.configure(next);
  sample({ co2_ppm: null });
  assert.equal(alarm.alarms().length, 1);
  sample({ co2_ppm: 720 }); sample({ co2_ppm: 720 });
  assert.equal(alarm.alarms().length, 1);
  sample({ co2_ppm: 720 });
  assert.deepEqual(alarm.alarms(), []);
});

test('old, repeated-time, unknown-time samples cannot trigger and freshness gaps reset pending counters', () => {
  const { alarm, sample } = alarmHarness();
  const base = Date.now();
  sample({ co2_ppm: 1200 }, base);
  sample({ co2_ppm: 1200 }, base);
  sample({ co2_ppm: 1200 }, base - 1);
  assert.deepEqual(alarm.alarms(), []);
  sample({ co2_ppm: 1200 }, base + 11000);
  sample({ co2_ppm: 1200 }, base + 11001);
  assert.deepEqual(alarm.alarms(), []);
  const old = message(100, new Date(base).toISOString(), { co2_ppm: 1200 });
  assert.equal(alarm.sample({ ...old, effective_at: old.sampled_at, time_quality: 'device' }, base + 20000), false);
  assert.equal(alarm.sample({ ...old, sampled_at: null, time_quality: 'received_only' }, base), false);
});

test('schema, timestamp, threshold recovery intervals and curve range constraints', () => {
  const now = Date.now();
  const value = message();
  const device = { room_id: 'classroom-001' };
  assert.equal(validateTelemetry(value, DEVICE, device, now), value);
  assert.throws(() => validateTelemetry(message(1, '2026-02-30T00:00:00Z'), DEVICE, device, now), { code: 'INVALID_TIMESTAMP' });
  assert.throws(() => validateTelemetry(message(1, new Date(now + 6000).toISOString()), DEVICE, device, now), { code: 'INVALID_TIMESTAMP' });
  assert.throws(() => validateTelemetry(message(1, null, { co2_ppm: Infinity }), DEVICE, device, now), { code: 'INVALID_PAYLOAD' });
  assert.throws(() => validateTelemetry({ ...value, room_id: 'wrong' }, DEVICE, device, now), { code: 'IDENTITY_MISMATCH' });
  const config = structuredClone(DEFAULT_THRESHOLDS);
  delete config.version;
  config.rules.temperature_c.hysteresis = 8;
  assert.throws(() => validateThresholds(config), { code: 'INVALID_THRESHOLDS' });
  assert.throws(() => parseSeries({ start: '2026-10-01T00:00:00Z', end: '2026-10-09T00:00:00Z' }), { code: 'INVALID_QUERY' });
  assert.throws(() => parseSeries({ max_points: '1201' }), { code: 'INVALID_QUERY' });
  assert.throws(() => parseSeries({ start: '2026-10-01' }), { code: 'INVALID_QUERY' });
});
