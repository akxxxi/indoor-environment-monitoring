import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const projectDir = fileURLToPath(new URL('../', import.meta.url));
export const METRICS = ['temperature_c', 'humidity_rh', 'co2_ppm', 'dust_ug_m3', 'illuminance_lux'];

export function readConfig(env = process.env) {
  function integer(key, fallback, min, max) {
    const raw = env[key] ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer in [${min}, ${max}]`);
    }
    return value;
  }
  const roomId = env.DEFAULT_ROOM_ID ?? 'classroom-001';
  const deviceId = env.DEFAULT_DEVICE_ID ?? 'classroom-001-node-001';
  for (const id of [roomId, deviceId]) {
    if (id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error('Invalid default room/device ID');
  }
  return {
    httpHost: env.HTTP_HOST ?? '127.0.0.1',
    httpPort: integer('HTTP_PORT', 3000, 0, 65535),
    mqttHost: env.MQTT_HOST ?? '127.0.0.1',
    mqttPort: integer('MQTT_PORT', 1883, 0, 65535),
    databasePath: resolve(projectDir, env.SQLITE_PATH ?? './data/environment.sqlite'),
    roomId, deviceId,
    maxPayloadBytes: integer('MQTT_MAX_PAYLOAD_BYTES', 1024, 1, 1024),
    staleAfterMs: integer('DEVICE_STALE_AFTER_MS', 10000, 1, 3600000),
    heartbeatMs: integer('SSE_HEARTBEAT_MS', 15000, 10, 60000),
    corsOrigin: env.CORS_ORIGIN ?? 'http://127.0.0.1:5173',
  };
}

export const DEFAULT_THRESHOLDS = {
  version: 1,
  consecutive_samples: 3,
  rules: {
    temperature_c: { enabled: true, lower: 16, upper: 30, hysteresis: 1 },
    humidity_rh: { enabled: true, lower: 30, upper: 70, hysteresis: 3 },
    co2_ppm: { enabled: true, lower: null, upper: 1000, hysteresis: 100 },
    dust_ug_m3: { enabled: true, lower: null, upper: 100, hysteresis: 10 },
    illuminance_lux: { enabled: true, lower: 200, upper: null, hysteresis: 20 },
  },
};
