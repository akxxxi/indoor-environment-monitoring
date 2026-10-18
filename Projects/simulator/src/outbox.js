import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serializeTelemetry, validAck } from './contract.js';

export class Outbox {
  constructor(path, maxPending = 43200) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.maxPending = maxPending;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL, boot_id TEXT NOT NULL, seq INTEGER NOT NULL,
        payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT,
        rejection_code TEXT, rejection_message TEXT, rejected_at TEXT,
        UNIQUE(device_id, boot_id, seq)
      );
      CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, id);`);
  }
  count() { return this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='pending'").get().n; }
  enqueue(message) {
    const payload = serializeTelemetry(message);
    if (this.count() >= this.maxPending) return false;
    this.db.prepare('INSERT INTO outbox(device_id, boot_id, seq, payload) VALUES (?, ?, ?, ?)')
      .run(message.device_id, message.boot_id, message.seq, payload);
    return true;
  }
  head() { return this.db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY id LIMIT 1").get(); }
  assertIdentity(deviceId, roomId) {
    if (this.db.prepare("SELECT id FROM outbox WHERE state='pending' AND (device_id<>? OR json_extract(payload, '$.room_id')<>?) LIMIT 1").get(deviceId, roomId)) {
      throw new Error('待发队列包含其他设备/教室数据；请先使用原身份补传，或为新身份设置不同 QUEUE_DB_PATH');
    }
  }
  attempted(id) {
    this.db.prepare("UPDATE outbox SET attempts=attempts+1, last_attempt_at=? WHERE id=? AND state='pending'").run(new Date().toISOString(), id);
  }
  settle(ack) {
    if (!validAck(ack)) return false;
    const params = [ack.device_id, ack.boot_id, ack.seq];
    if (ack.status === 'rejected') {
      return this.db.prepare(`UPDATE outbox SET state='rejected', rejection_code=?, rejection_message=?, rejected_at=?
        WHERE device_id=? AND boot_id=? AND seq=? AND state='pending'`)
        .run(ack.error.code, ack.error.message, new Date().toISOString(), ...params).changes === 1;
    }
    return this.db.prepare("DELETE FROM outbox WHERE device_id=? AND boot_id=? AND seq=? AND state='pending'").run(...params).changes === 1;
  }
  summary() {
    return { pending: this.count(), rejected: this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE state='rejected'").get().n,
      oldest: this.head() ?? null,
      recent_rejections: this.db.prepare("SELECT device_id, boot_id, seq, rejection_code, rejection_message, rejected_at FROM outbox WHERE state='rejected' ORDER BY id DESC LIMIT 10").all() };
  }
  close() { this.db.close(); }
}
