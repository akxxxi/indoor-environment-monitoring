import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { projectDir, readConfig } from '../src/config.js';

export const DEVICE = 'classroom-001-node-001';
export const topic = suffix => `envmon/v1/devices/${DEVICE}/${suffix}`;
export const quiet = { log() {}, warn() {}, error() {} };
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for condition');
    await delay(10);
  }
}
export function temporaryDatabase() {
  const root = resolve(projectDir, '.test-data');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'run-'));
  return join(directory, 'test.sqlite');
}
export function cleanTemporaryDatabase(path) {
  const root = resolve(projectDir, '.test-data');
  const target = resolve(path, '..');
  if (!target.startsWith(root + sep)) throw new Error('Unsafe temporary cleanup path');
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
export function testConfig(databasePath) {
  return { ...readConfig({}), databasePath, httpPort: 0, mqttPort: 0, heartbeatMs: 50 };
}
export function message(seq = 1, sampledAt = new Date().toISOString(), metrics = {}) {
  return {
    schema_version: 1, device_id: DEVICE, room_id: 'classroom-001', boot_id: 'abcdef01', seq,
    sampled_at: sampledAt, source: 'simulator',
    metrics: { temperature_c: 24, humidity_rh: 50, co2_ppm: 720, dust_ug_m3: 28, illuminance_lux: 430, ...metrics },
  };
}
