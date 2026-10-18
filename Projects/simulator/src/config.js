import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const scenarios = ['normal', 'co2_high', 'dust_high', 'demo'];

export function readConfig(env = process.env) {
  function integer(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${name} 必须为 ${min} 至 ${max} 的整数`);
    }
    return value;
  }
  function identity(name, fallback) {
    const value = env[name] ?? fallback;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 64) {
      throw new Error(`${name} 必须符合共用协议的小写设备/教室标识格式`);
    }
    return value;
  }
  const scenario = env.SIMULATION_SCENARIO ?? 'normal';
  if (!scenarios.includes(scenario)) throw new Error(`SIMULATION_SCENARIO 仅支持 ${scenarios.join(', ')}`);
  const mqttUrl = env.MQTT_URL ?? 'mqtt://127.0.0.1:1883';
  if (!['mqtt:', 'mqtts:'].includes(new URL(mqttUrl).protocol)) throw new Error('MQTT_URL 必须使用 mqtt:// 或 mqtts://');
  return {
    mqttUrl,
    deviceId: identity('DEVICE_ID', 'classroom-001-node-001'),
    roomId: identity('ROOM_ID', 'classroom-001'),
    intervalMs: integer('UPLOAD_INTERVAL_MS', 2000, 50, 3600000),
    seed: env.SIMULATION_SEED ?? '20261016',
    scenario,
    dbPath: resolve(projectRoot, env.QUEUE_DB_PATH ?? './data/outbox.sqlite'),
    maxPending: integer('QUEUE_MAX_RECORDS', 43200),
    ackTimeoutMs: integer('ACK_TIMEOUT_MS', 10000, 50),
    retryBaseMs: integer('RETRY_BASE_MS', 1000, 50, 30000),
    reconnectMs: integer('MQTT_RECONNECT_MS', 2000, 100, 30000),
  };
}
