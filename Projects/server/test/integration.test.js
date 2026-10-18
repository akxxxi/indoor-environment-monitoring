import test from 'node:test';
import assert from 'node:assert/strict';
import { connectAsync } from 'mqtt';
import { startApp } from '../src/app.js';
import { DEFAULT_THRESHOLDS } from '../src/config.js';
import { DEVICE, topic, quiet, delay, waitFor, temporaryDatabase, cleanTemporaryDatabase, testConfig, message } from './helpers.js';

async function openSse(base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/events?device_id=${DEVICE}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const frames = [];
  let buffer = '';
  const pump = (async () => {
    try {
      for await (const bytes of response.body) {
        buffer += Buffer.from(bytes).toString();
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          frames.push({ name, data: data ? JSON.parse(data) : null, raw: frame });
        }
      }
    } catch (error) { if (error.name !== 'AbortError') throw error; }
  })();
  return { frames, async close() { controller.abort(); await pump; } };
}

test('real MQTT/HTTP/SSE: persistence, rejection, transaction failure, latest, curves, settings and shutdown', { timeout: 30000 }, async t => {
  const path = temporaryDatabase();
  const config = { ...testConfig(path), staleAfterMs: 1000 };
  let app = await startApp(config, quiet);
  let client;
  let sse;
  t.after(async () => {
    if (sse) await sse.close();
    if (client) await client.endAsync(true);
    await app.close();
    cleanTemporaryDatabase(path);
  });
  let base = `http://127.0.0.1:${app.http.address().port}/api/v1`;
  const get = async route => {
    const response = await fetch(base + route);
    return { status: response.status, body: await response.json() };
  };
  const put = async value => {
    const response = await fetch(`${base}/devices/${DEVICE}/thresholds`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
    });
    return { status: response.status, body: await response.json() };
  };
  const acks = [];
  const connect = async () => {
    client = await connectAsync(`mqtt://127.0.0.1:${app.mqtt.server.address().port}`, {
      protocolVersion: 4, clientId: 'server-integration-test', reconnectPeriod: 0,
    });
    client.on('message', (name, payload, packet) => {
      if (name === topic('ack')) acks.push({ ...JSON.parse(payload.toString()), qos: packet.qos, retain: packet.retain });
    });
    await client.subscribeAsync(topic('ack'), { qos: 1 });
  };
  const publish = async (value, options = {}) => {
    const begin = acks.length;
    await client.publishAsync(options.topic ?? topic('telemetry'), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), {
      qos: options.qos ?? 1, retain: options.retain ?? false,
    });
    if (options.noAck) { await delay(100); assert.equal(acks.length, begin); return; }
    await waitFor(() => acks.length > begin);
    return acks[begin];
  };
  const latestRoute = `/devices/${DEVICE}/latest`;
  await t.test('health and empty/unregistered device responses', async () => {
    assert.deepEqual(await get('/health'), { status: 200, body: { data: { status: 'ok', mqtt: true, database: true } } });
    assert.deepEqual((await get(latestRoute)).body, { data: null });
    assert.equal((await get('/devices/unknown/latest')).status, 404);
    assert.equal((await get(`/devices/${DEVICE}/series`)).body.data.length, 0);
    assert.equal((await get('/events')).status, 400);
  });
  await connect();
  sse = await openSse(base);
  let first;
  let firstAck;
  await t.test('stored ACK, canonical duplicate, conflict and exactly one measurement event', async () => {
    first = message(1);
    firstAck = await publish(first);
    assert.equal(firstAck.status, 'stored');
    assert.equal(firstAck.qos, 1);
    assert.equal(firstAck.retain, false);
    const reordered = Object.fromEntries(Object.entries(first).reverse());
    reordered.metrics = Object.fromEntries(Object.entries(first.metrics).reverse());
    const duplicate = await publish(JSON.stringify(reordered, null, 1));
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(duplicate.stored_at, firstAck.stored_at);
    const conflict = await publish({ ...first, source: 'hardware' });
    assert.equal(conflict.status, 'rejected');
    assert.equal(conflict.error.code, 'MESSAGE_CONFLICT');
    assert.equal(conflict.stored_at, undefined);
    await waitFor(() => sse.frames.some(f => f.name === 'measurement.created'));
    assert.equal(sse.frames.filter(f => f.name === 'measurement.created').length, 1);
    const latest = (await get(latestRoute)).body.data;
    assert.equal(latest.seq, 1);
    assert.equal(latest.device.online, true);
    assert.equal(latest.device.stale, false);
    assert.equal(latest.time_quality, 'device');
    const event = sse.frames.find(f => f.name === 'measurement.created').data;
    assert.equal(event.data, undefined);
    assert.equal(event.id, latest.id);
    assert.deepEqual(event.metrics, first.metrics);
  });
  await t.test('real COMMIT failure causes no application ACK or measurement event and retry recovers', async () => {
    app.store.db.exec(`CREATE TABLE guard (device_id TEXT REFERENCES devices(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON measurements BEGIN INSERT INTO guard VALUES ('missing'); END;`);
    const count = sse.frames.filter(f => f.name === 'measurement.created').length;
    const value = message(2);
    await publish(value, { noAck: true });
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM measurements WHERE seq = 2').get().n, 0);
    assert.equal(sse.frames.filter(f => f.name === 'measurement.created').length, count);
    const health = await get('/health');
    assert.equal(health.status, 503);
    assert.equal(health.body.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.match(health.body.error.message, /database unavailable/);
    app.store.db.exec('DROP TRIGGER fail_commit');
    assert.equal((await publish(value)).status, 'stored');
    assert.equal((await get('/health')).status, 200);
  });
  await t.test('bad schema/identity/time/retain/QoS rejected, malformed and oversized input cannot crash process', async () => {
    const badValues = [
      [message(10, new Date(Date.now() + 60000).toISOString()), {}, 'INVALID_TIMESTAMP'],
      [{ ...message(11), room_id: 'wrong-room' }, {}, 'IDENTITY_MISMATCH'],
      [message(12, undefined, { humidity_rh: 101 }), {}, 'INVALID_PAYLOAD'],
      [message(13), { retain: true }, 'INVALID_PAYLOAD'],
      [message(14), { qos: 0 }, 'INVALID_PAYLOAD'],
      [message(15), { topic: 'envmon/v1/devices/another-device/telemetry' }, 'IDENTITY_MISMATCH'],
      [{ ...message(16), extra: true }, {}, 'INVALID_PAYLOAD'],
      [message(17, undefined, { co2_ppm: 1.5 }), {}, 'INVALID_PAYLOAD'],
      [message(18, '2026-02-30T00:00:00Z'), {}, 'INVALID_TIMESTAMP'],
    ];
    for (const [value, options, code] of badValues) {
      const ack = await publish(value, options);
      assert.equal(ack.status, 'rejected');
      assert.equal(ack.error.code, code);
    }
    await publish('{bad-json', { noAck: true });
    await publish(Buffer.from([0xff, 0xfe]), { noAck: true });
    await publish(' '.repeat(1025), { noAck: true });
    assert.equal((await get('/health')).status, 200);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM measurements').get().n, 2);
  });
  await t.test('SQL curves average valid samples, preserve null, exclude unknown-time and right boundary', async () => {
    const start = Date.now() - 3600000;
    const values = [100, 300, null, 900];
    for (let i = 0; i < values.length; i++) {
      await publish(message(30 + i, new Date(start + i * 1000).toISOString(), { co2_ppm: values[i] }));
    }
    const query = new URLSearchParams({ start: new Date(start).toISOString(), end: new Date(start + 3000).toISOString(), metric: 'co2_ppm', max_points: '2' });
    const response = await get(`/devices/${DEVICE}/series?${query}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.meta.bucket_seconds, 2);
    assert.deepEqual(response.body.data.map(({ value, count }) => ({ value, count })), [{ value: 200, count: 2 }, { value: null, count: 0 }]);
    assert.equal((await get(latestRoute)).body.data.seq, 2);
    const limited = await get(`/devices/${DEVICE}/series?max_points=1`);
    assert.ok(limited.body.data.length <= 1);
    assert.equal((await get(`/devices/${DEVICE}/series?max_points=1201`)).status, 400);
    assert.equal((await get(`/devices/${DEVICE}/series?metric=pm25_ug_m3`)).status, 400);
    assert.equal((await get(`/devices/${DEVICE}/series?start=2026-10-01T00:00:00Z&end=2026-10-09T00:00:00Z`)).status, 400);
  });
  let savedConfig;
  await t.test('threshold validation, persistence, events, fresh alarm trigger and recovery', async () => {
    const current = (await get(`/devices/${DEVICE}/thresholds`)).body.data;
    assert.deepEqual(current, DEFAULT_THRESHOLDS);
    const { version, ...replacement } = current;
    replacement.rules.co2_ppm.upper = 1100;
    const invalid = structuredClone(replacement);
    invalid.rules.humidity_rh.hysteresis = 100;
    assert.equal((await put(invalid)).status, 400);
    assert.equal((await put(current)).status, 400);
    const result = await put(replacement);
    assert.equal(result.status, 200);
    savedConfig = result.body.data;
    assert.equal(savedConfig.version, 2);
    await waitFor(() => sse.frames.some(f => f.name === 'thresholds.updated'));
    for (let i = 0; i < 3; i++) {
      await publish(message(50 + i, new Date(Date.now() + i * 10).toISOString(), { co2_ppm: 1300 }));
      await delay(15);
    }
    assert.equal((await get(latestRoute)).body.data.alarms[0].state, 'high');
    await waitFor(() => sse.frames.some(f => f.name === 'alarm.changed'));
    for (let i = 0; i < 3; i++) {
      await publish(message(60 + i, new Date(Date.now() + i * 10).toISOString(), { co2_ppm: 1000 }));
      await delay(15);
    }
    assert.deepEqual((await get(latestRoute)).body.data.alarms, []);
  });
  await t.test('online differs from stale; historical replay and retained status do not refresh samples', async () => {
    await delay(1100);
    assert.equal((await get(latestRoute)).body.data.device.stale, true);
    await publish(message(70, new Date(Date.now() - 60000).toISOString(), { co2_ppm: 5000 }));
    const latest = (await get(latestRoute)).body.data;
    assert.equal(latest.seq, 62);
    assert.equal(latest.device.online, true);
    assert.equal(latest.device.stale, true);
    assert.deepEqual(latest.alarms, []);
    await client.publishAsync(topic('status'), JSON.stringify({ schema_version: 1, device_id: DEVICE, boot_id: 'abcdef01', state: 'online' }), { qos: 1, retain: true });
    assert.equal((await get(latestRoute)).body.data.device.stale, true);
    await client.endAsync(); client = null;
    await waitFor(() => app.service.state(DEVICE).online === false);
    await connect();
    await client.subscribeAsync(topic('status'), { qos: 1 });
    await delay(50);
    assert.equal((await get(latestRoute)).body.data.device.online, false);
    await publish(message(80, null));
    const unknown = (await get(latestRoute)).body.data;
    assert.equal(unknown.sampled_at, null);
    assert.equal(unknown.time_quality, 'received_only');
    assert.equal(unknown.effective_at, unknown.received_at);
    assert.equal(unknown.device.stale, true);
    const start = new Date(Date.now() - 100).toISOString();
    assert.deepEqual((await get(`/devices/${DEVICE}/series?start=${start}&end=${new Date(Date.now() + 100).toISOString()}`)).body.data, []);
  });
  await t.test('SSE heartbeat, disconnect cleanup, restart history and original duplicate confirmation', async () => {
    assert.ok(sse.frames.some(f => f.raw === ': heartbeat'));
    assert.ok(sse.frames.some(f => f.name === 'device.updated' && f.data.stale));
    await sse.close(); sse = null;
    await waitFor(() => app.events.clients.size === 0);
    await client.endAsync(); client = null;
    const previous = (await get(latestRoute)).body.data;
    await app.close();
    app = await startApp(config, quiet);
    base = `http://127.0.0.1:${app.http.address().port}/api/v1`;
    assert.deepEqual((await get(`/devices/${DEVICE}/thresholds`)).body.data, savedConfig);
    const restored = (await get(latestRoute)).body.data;
    assert.equal(restored.id, previous.id);
    assert.equal(restored.device.online, false);
    assert.deepEqual(restored.alarms, []);
    await connect();
    const ack = await publish(first);
    assert.equal(ack.status, 'duplicate');
    assert.equal(ack.stored_at, firstAck.stored_at);
    assert.equal((await get(latestRoute)).body.data.id, previous.id);
    assert.equal((await get('/health')).status, 200);
    const activeSse = await openSse(base);
    const idleSocket = (await import('node:net')).connect(app.mqtt.server.address().port, '127.0.0.1');
    idleSocket.on('error', () => {});
    await new Promise(resolve => idleSocket.once('connect', resolve));
    await app.close();
    await activeSse.close();
    idleSocket.destroy();
    assert.equal(app.http.listening, false);
    assert.equal(app.mqtt.server.listening, false);
    assert.equal(app.mqtt.broker.closed, true);
    assert.equal(app.events.clients.size, 0);
    assert.equal(app.store.healthy(), false);
  });
});

test('occupied HTTP port rolls back MQTT listener and database resources', async t => {
  const { createServer } = await import('node:net');
  const occupied = createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const path = temporaryDatabase();
  t.after(() => cleanTemporaryDatabase(path));
  const config = { ...testConfig(path), httpPort: occupied.address().port };
  await assert.rejects(startApp(config, quiet), { code: 'EADDRINUSE' });
});
