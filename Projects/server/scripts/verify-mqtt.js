// A one-shot protocol check against an already running backend, not a simulator.
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { connectAsync } from 'mqtt';

const httpUrl = process.env.HTTP_URL ?? 'http://127.0.0.1:3000';
const mqttUrl = process.env.MQTT_URL ?? 'mqtt://127.0.0.1:1883';
const device = process.env.DEFAULT_DEVICE_ID ?? 'classroom-001-node-001';
const topic = `envmon/v1/devices/${device}`;
const sample = {
  schema_version: 1, device_id: device, room_id: process.env.DEFAULT_ROOM_ID ?? 'classroom-001',
  boot_id: randomBytes(8).toString('hex'), seq: 1, sampled_at: new Date().toISOString(), source: 'simulator',
  metrics: { temperature_c: 24.6, humidity_rh: 48.2, co2_ppm: 720, dust_ug_m3: 28, illuminance_lux: 430 },
};
let client;
const timeout = setTimeout(() => {
  console.error('Verification timed out: start server first and check HTTP_URL/MQTT_URL.');
  process.exitCode = 1;
  client?.end(true);
}, 10000);
try {
  const health = await fetch(`${httpUrl}/api/v1/health`);
  assert.equal(health.status, 200);
  console.log('health', JSON.stringify(await health.json()));
  client = await connectAsync(mqttUrl, { protocolVersion: 4, reconnectPeriod: 0, connectTimeout: 5000 });
  await client.subscribeAsync(`${topic}/ack`, { qos: 1 });
  const exchange = async value => {
    let listener;
    const ack = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        client.off('message', listener);
        reject(new Error('Application ACK timeout'));
      }, 3000);
      listener = (name, bytes) => {
        if (name !== `${topic}/ack`) return;
        const result = JSON.parse(bytes.toString());
        if (result.boot_id !== sample.boot_id || result.seq !== sample.seq) return;
        clearTimeout(deadline);
        client.off('message', listener);
        resolve(result);
      };
      client.on('message', listener);
    });
    await client.publishAsync(`${topic}/telemetry`, JSON.stringify(value), { qos: 1, retain: false });
    return ack;
  };
  const stored = await exchange(sample);
  assert.equal(stored.status, 'stored');
  console.log('stored', JSON.stringify(stored));
  const duplicate = await exchange(sample);
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.stored_at, stored.stored_at);
  console.log('duplicate', JSON.stringify(duplicate));
  const conflict = await exchange({ ...sample, source: 'hardware' });
  assert.equal(conflict.error.code, 'MESSAGE_CONFLICT');
  assert.equal(conflict.status, 'rejected');
  console.log('conflict', JSON.stringify(conflict));
  for (const endpoint of ['latest', 'thresholds']) {
    const response = await fetch(`${httpUrl}/api/v1/devices/${device}/${endpoint}`);
    assert.equal(response.status, 200);
    console.log(endpoint, JSON.stringify(await response.json()));
  }
  const query = new URLSearchParams({
    start: new Date(Date.parse(sample.sampled_at) - 1000).toISOString(),
    end: new Date(Date.parse(sample.sampled_at) + 1000).toISOString(), metric: 'co2_ppm', max_points: '600',
  });
  const series = await fetch(`${httpUrl}/api/v1/devices/${device}/series?${query}`);
  assert.equal(series.status, 200);
  const curve = await series.json();
  assert.ok(curve.data.some(point => point.count > 0));
  console.log('series', JSON.stringify(curve));
  console.log('PASS: MQTT stored/duplicate/conflict and HTTP responses verified. One test sample was stored.');
} catch (error) {
  console.error('Verification failed:', error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  if (client) await client.endAsync(true);
}
