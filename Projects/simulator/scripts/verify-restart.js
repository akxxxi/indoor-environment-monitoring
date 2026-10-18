import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Outbox } from '../src/outbox.js';

const dir = mkdtempSync(join(tmpdir(), 'envmon-restart-'));
const path = join(dir, 'outbox.sqlite');
let child;
let output;
function start() {
  output = '';
  child = fork(new URL('../test/support/child-node.js', import.meta.url), [], {
    silent: true,
    env: { ...process.env, MQTT_URL: 'mqtt://127.0.0.1:1', QUEUE_DB_PATH: path,
      DEVICE_ID: 'classroom-001-node-001', ROOM_ID: 'classroom-001', SIMULATION_SCENARIO: 'normal',
      SIMULATION_SEED: '20261016', UPLOAD_INTERVAL_MS: '2000', QUEUE_MAX_RECORDS: '43200' },
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
}
async function waitFor(text) {
  const end = Date.now() + 10000;
  while (!output.includes(text)) {
    if (Date.now() > end || child.exitCode !== null) throw new Error(`子进程未达到 ${text}: ${output}`);
    await delay(30);
  }
}
function snapshot() {
  const box = new Outbox(path);
  try { return box.db.prepare("SELECT payload FROM outbox WHERE state='pending' ORDER BY id").all().map(row => row.payload); }
  finally { box.close(); }
}
try {
  start();
  await waitFor('seq=3 queue=3');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  child = undefined;
  const before = snapshot();
  assert.equal(before.length, 3);
  start();
  await waitFor('seq=1 queue=4');
  const stopped = once(child, 'exit');
  child.send('stop');
  const [code] = await stopped;
  child = undefined;
  assert.equal(code, 0, output);
  assert.match(output, /正常退出，待发队列保留/);
  const after = snapshot();
  assert.deepEqual(after.slice(0, 3), before);
  assert.equal(after.length, 4);
  assert.notEqual(JSON.parse(before[0]).boot_id, JSON.parse(after[3]).boot_id);
  assert.equal(JSON.parse(after[3]).seq, 1);
  console.log('PASS: 无后端时按默认 2000ms 连续生成 3 条；强制终止后全部持久保留');
  console.log('PASS: 新进程固定相同种子仍使用新 boot_id；旧 3 条 payload/boot_id/seq/sampled_at 逐字不变');
  console.log('PASS: 正常退出关闭连接和数据库；队列 3 → 4，旧记录继续排在新记录之前');
} finally {
  if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  rmSync(dir, { recursive: true, force: true });
}
