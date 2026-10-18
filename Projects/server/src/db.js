import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_THRESHOLDS, METRICS } from './config.js';
import { canonicalJson, InputError } from './validation.js';

export class Store {
  constructor(path, roomId, deviceId) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 1000 });
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS thresholds (
          device_id TEXT PRIMARY KEY REFERENCES devices(id), config TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS measurements (
          id INTEGER PRIMARY KEY,
          device_id TEXT NOT NULL REFERENCES devices(id),
          boot_id TEXT NOT NULL, seq INTEGER NOT NULL,
          content TEXT NOT NULL, sampled_at TEXT,
          received_at TEXT NOT NULL, stored_at TEXT NOT NULL,
          effective_ms INTEGER NOT NULL,
          time_quality TEXT NOT NULL CHECK(time_quality IN ('device', 'received_only')),
          temperature_c REAL, humidity_rh REAL, co2_ppm INTEGER, dust_ug_m3 REAL, illuminance_lux REAL,
          UNIQUE(device_id, boot_id, seq)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS measurements_time ON measurements(device_id, effective_ms DESC, id DESC);
      `);
      this.transaction(() => {
        this.db.prepare('INSERT OR IGNORE INTO rooms(id) VALUES (?)').run(roomId);
        this.db.prepare('INSERT OR IGNORE INTO devices(id, room_id) VALUES (?, ?)').run(deviceId, roomId);
        this.db.prepare('INSERT OR IGNORE INTO thresholds(device_id, config) VALUES (?, ?)').run(deviceId, JSON.stringify(DEFAULT_THRESHOLDS));
      });
      if (this.device(deviceId).room_id !== roomId) throw new Error('Existing device room differs from DEFAULT_ROOM_ID; use matching configuration');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  device(id) { return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id); }
  devices() { return this.db.prepare('SELECT * FROM devices').all(); }
  healthy() {
    try { return this.db.prepare('SELECT 1 AS ok').get().ok === 1; } catch { return false; }
  }
  thresholds(id) { return JSON.parse(this.db.prepare('SELECT config FROM thresholds WHERE device_id = ?').get(id).config); }
  saveThresholds(id, config) {
    return this.transaction(() => {
      const next = { version: this.thresholds(id).version + 1, ...config };
      this.db.prepare('UPDATE thresholds SET config = ? WHERE device_id = ?').run(JSON.stringify(next), id);
      return next;
    });
  }

  store(value, receivedAt) {
    const content = canonicalJson(value);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM measurements WHERE device_id = ? AND boot_id = ? AND seq = ?')
        .get(value.device_id, value.boot_id, value.seq);
      if (existing) {
        if (existing.content !== content) throw new InputError('MESSAGE_CONFLICT', 'Message identity already exists with different content');
        return { status: 'duplicate', record: this.record(existing) };
      }
      const storedAt = new Date().toISOString();
      const effectiveMs = Date.parse(value.sampled_at ?? receivedAt);
      const quality = value.sampled_at === null ? 'received_only' : 'device';
      const result = this.db.prepare(`INSERT INTO measurements (
        device_id, boot_id, seq, content, sampled_at, received_at, stored_at, effective_ms, time_quality,
        temperature_c, humidity_rh, co2_ppm, dust_ug_m3, illuminance_lux
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        value.device_id, value.boot_id, value.seq, content, value.sampled_at, receivedAt, storedAt, effectiveMs, quality,
        ...METRICS.map(key => value.metrics[key]),
      );
      return { status: 'stored', record: this.record(this.db.prepare('SELECT * FROM measurements WHERE id = ?').get(result.lastInsertRowid)) };
    });
  }

  record(row) {
    if (!row) return null;
    return {
      ...JSON.parse(row.content), id: row.id,
      received_at: row.received_at, stored_at: row.stored_at,
      effective_at: new Date(row.effective_ms).toISOString(), time_quality: row.time_quality,
    };
  }
  latest(id) {
    return this.record(this.db.prepare('SELECT * FROM measurements WHERE device_id = ? ORDER BY effective_ms DESC, id DESC LIMIT 1').get(id));
  }
  lastReceived(id) {
    return this.db.prepare('SELECT received_at FROM measurements WHERE device_id = ? ORDER BY id DESC LIMIT 1').get(id)?.received_at ?? null;
  }
  series(id, { metric, start, end, bucketSeconds }) {
    // Metric is allowlisted here as well, because it becomes an SQL identifier.
    if (!METRICS.includes(metric)) throw new InputError('INVALID_QUERY', 'Unknown metric');
    const rows = this.db.prepare(`SELECT CAST((effective_ms - ?) / ? AS INTEGER) AS bucket,
      AVG(${metric}) AS value, COUNT(${metric}) AS count FROM measurements
      WHERE device_id = ? AND time_quality = 'device' AND effective_ms >= ? AND effective_ms < ?
      GROUP BY bucket ORDER BY bucket`).all(start, bucketSeconds * 1000, id, start, end);
    return {
      data: rows.map(row => ({ time: new Date(start + row.bucket * bucketSeconds * 1000).toISOString(), value: row.value, count: row.count })),
      meta: { metric, bucket_seconds: bucketSeconds, start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    };
  }
  close() { this.db.close(); }
}
