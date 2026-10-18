import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Outbox } from '../src/outbox.js';
import { Generator } from '../src/generator.js';
import { readConfig } from '../src/config.js';
import { serializeTelemetry } from '../src/contract.js';

const config = readConfig({});
const ackFor = (message, status = 'stored') => ({ schema_version: 1, device_id: message.device_id,
  boot_id: message.boot_id, seq: message.seq, status, stored_at: new Date().toISOString() });

test('SQLite 重开保留原始标识、时间、顺序和尝试次数；只按匹配的完整应用 ACK 出队', () => {
  const dir = mkdtempSync(join(tmpdir(), 'envmon-outbox-'));
  const path = join(dir, 'outbox.sqlite');
  let box = new Outbox(path, 2);
  try {
    const generator = new Generator(config);
    const first = generator.next();
    const second = generator.next();
    assert.equal(box.enqueue(first), true);
    assert.equal(box.enqueue(second), true);
    assert.equal(box.enqueue(generator.next()), false);
    const payload = box.head().payload;
    box.attempted(box.head().id);
    box.close();
    box = new Outbox(path, 2);
    assert.equal(box.count(), 2);
    assert.equal(box.head().payload, payload);
    assert.equal(box.head().attempts, 1);
    assert.throws(() => box.assertIdentity('other-device', config.roomId), /其他设备/);
    assert.equal(box.settle({ ...ackFor(first), boot_id: 'aaaaaaaa' }), false);
    assert.equal(box.settle({ ...ackFor(first), stored_at: undefined }), false);
    assert.equal(box.count(), 2);
    assert.equal(box.settle(ackFor(first)), true);
    assert.equal(box.settle(ackFor(first)), false);
    assert.equal(box.head().payload, JSON.stringify(second));
    assert.equal(box.settle(ackFor(second, 'duplicate')), true);
    assert.equal(box.count(), 0);
  } finally { box.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('永久 rejected 保留原因并让后续消息成为队首', () => {
  const box = new Outbox(':memory:');
  try {
    const generator = new Generator(config);
    const first = generator.next();
    const second = generator.next();
    box.enqueue(first); box.enqueue(second);
    const ack = { ...ackFor(first, 'rejected'), error: { code: 'MESSAGE_CONFLICT', message: '相同标识不同内容' } };
    delete ack.stored_at;
    assert.equal(box.settle(ack), true);
    assert.equal(box.settle(ack), false);
    assert.equal(box.head().payload, JSON.stringify(second));
    assert.equal(box.summary().rejected, 1);
    assert.equal(box.summary().recent_rejections[0].rejection_code, 'MESSAGE_CONFLICT');
  } finally { box.close(); }
});

test('固定种子复现四种情景趋势，启动标识独立；demo 连续超限及恢复且通过共用 Schema', () => {
  for (const scenario of ['normal', 'co2_high', 'dust_high', 'demo']) {
    const a = new Generator({ ...config, scenario });
    const b = new Generator({ ...config, scenario });
    assert.notEqual(a.bootId, b.bootId);
    const readings = [];
    for (let i = 0; i < 80; i++) {
      const left = a.next();
      const right = b.next();
      assert.deepEqual(left.metrics, right.metrics);
      serializeTelemetry(left);
      readings.push(left.metrics);
    }
    if (scenario === 'demo') {
      assert.ok(readings.slice(15, 25).every(m => m.co2_ppm > 1000 && m.dust_ug_m3 > 100));
      assert.ok(readings.slice(33, 40).every(m => m.co2_ppm <= 900 && m.dust_ug_m3 <= 90));
    }
  }
  const invalid = new Generator(config).next();
  invalid.metrics.pm25_ug_m3 = 10;
  assert.throws(() => serializeTelemetry(invalid), /多余字段/);
  assert.throws(() => readConfig({ SIMULATION_SCENARIO: 'missing' }), /仅支持/);
});
