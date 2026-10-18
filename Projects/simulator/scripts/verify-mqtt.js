import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import mqtt from 'mqtt';
import { MqttPeer } from '../test/support/mqtt-peer.js';
import { readConfig } from '../src/config.js';
import { Outbox } from '../src/outbox.js';
import { SimulatorNode } from '../src/node.js';

async function until(predicate, description, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`验证超时：${description}`);
    await delay(25);
  }
}
const peer = new MqttPeer();
const dir = mkdtempSync(join(tmpdir(), 'envmon-mqtt-'));
const dbPath = join(dir, 'outbox.sqlite');
let node;
try {
  const port = await peer.listen();
  const config = { ...readConfig({}), mqttUrl: `mqtt://127.0.0.1:${port}`, dbPath,
    reconnectMs: 150, ackTimeoutMs: 250, retryBaseMs: 100 };
  const outbox = new Outbox(dbPath);
  node = new SimulatorNode({ config, outbox, connect: mqtt.connect, log: line => console.log(line) });
  node.start();
  await until(() => peer.unique.size >= 10 && outbox.count() === 0, '默认 2000ms 周期连续上传 10 条', 24000);
  console.log('PASS: 连续 10 条真实 TCP/MQTT 上传及应用 ACK 出队（2000ms 采样）');

  peer.withholdNext = true;
  node.sample();
  await until(() => outbox.count() === 0, 'PUBACK 后丢失应用 ACK，超时重试获得 duplicate');
  assert.equal(peer.lastAck.status, 'duplicate');
  assert.ok(peer.received.length > peer.unique.size);
  console.log('PASS: PUBACK 不出队，超时沿用原文重试，duplicate 与重复 ACK 幂等');

  await peer.close();
  await until(() => !node.ready, '检测断线');
  const before = outbox.count();
  await delay(4200);
  assert.ok(outbox.count() >= before + 2);
  const queued = outbox.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY id").all().map(row => row.payload);
  const receivedBefore = peer.received.length;
  const reconnectAt = Date.now();
  await peer.listen(port);
  await until(() => outbox.count() === 0, '恢复连接并排空积压');
  assert.deepEqual(peer.received.slice(receivedBefore, receivedBefore + queued.length).map(row => row.payload), queued);
  assert.ok(Date.now() - reconnectAt < 2000, '补传不应逐条等待 2 秒');
  console.log(`PASS: 断线继续每 2 秒采样，${queued.length} 条原始消息按序快速补传并排空`);

  await node.stop();
  node = undefined;
  assert.ok(peer.statuses.some(value => value.state === 'online'));
  assert.equal(peer.statuses.at(-1).state, 'offline');
  assert.deepEqual(peer.errors, []);
  console.log(`PASS: online/offline 与遗嘱配置；测试对端唯一消息 ${peer.unique.size} 条，MQTT 到达 ${peer.received.length} 次`);
  console.log('说明：这是独立 MQTT 测试对端；未替代或验证项目后端的数据库入库。');
} finally {
  await node?.stop();
  await peer.close();
  rmSync(dir, { recursive: true, force: true });
}
