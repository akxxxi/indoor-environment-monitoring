import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from '../src/config.js';
import { Outbox } from '../src/outbox.js';
import { SimulatorNode } from '../src/node.js';

class FakeClient extends EventEmitter {
  connected = false;
  published = [];
  subscribe(topic, options, callback) { this.suback = () => callback(null, [{ topic, qos: 1 }]); }
  publish(topic, payload, options, callback) {
    this.published.push({ topic, payload, options });
    callback?.(null); // MQTT PUBACK only, no application confirmation.
  }
  end(force, options, callback) { this.connected = false; callback?.(); }
  telemetry() { return this.published.filter(item => item.topic.endsWith('/telemetry')); }
}

test('SUBACK 前禁止发送；PUBACK 不出队；超时重发原文；匹配 ACK 后立即排空', async () => {
  const config = { ...readConfig({}), intervalMs: 100000, ackTimeoutMs: 50, retryBaseMs: 50 };
  const box = new Outbox(':memory:');
  const client = new FakeClient();
  const node = new SimulatorNode({ config, outbox: box, connect: () => client, log: () => {} });
  try {
    node.start();
    node.sample();
    assert.equal(box.count(), 2);
    client.connected = true;
    client.emit('connect');
    assert.equal(client.telemetry().length, 0);
    client.suback();
    assert.equal(client.telemetry().length, 1);
    assert.equal(box.count(), 2);
    await delay(130);
    assert.ok(client.telemetry().length >= 2);
    assert.equal(client.telemetry()[0].payload, client.telemetry()[1].payload);
    const first = JSON.parse(client.telemetry()[0].payload);
    const ack = { schema_version: 1, device_id: first.device_id, boot_id: first.boot_id,
      seq: first.seq, status: 'stored', stored_at: new Date().toISOString() };
    const reply = value => client.emit('message', `${node.baseTopic}/ack`, Buffer.from(JSON.stringify(value)), { retain: false });
    reply({ ...ack, boot_id: 'aaaaaaaa' });
    assert.equal(box.count(), 2);
    client.emit('message', `${node.baseTopic}/ack`, Buffer.from(JSON.stringify(ack)), { retain: true });
    assert.equal(box.count(), 2);
    reply(ack);
    reply(ack);
    await delay(0);
    assert.equal(box.count(), 1);
    const second = JSON.parse(client.telemetry().at(-1).payload);
    assert.equal(second.seq, first.seq + 1);
    reply({ ...ack, seq: second.seq, status: 'duplicate' });
    assert.equal(box.count(), 0);
  } finally { await node.stop(); }
});
