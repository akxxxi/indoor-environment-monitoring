import { randomBytes } from 'node:crypto';

export function createBootId() { return randomBytes(8).toString('hex'); }

export class Generator {
  constructor(config) {
    this.config = config;
    this.bootId = createBootId();
    this.seq = 0;
    this.tick = 0;
    this.phase = '';
    this.randomState = 2166136261;
    for (const char of String(config.seed)) this.randomState = Math.imul(this.randomState ^ char.charCodeAt(0), 16777619) >>> 0;
    this.values = { temperature_c: 24, humidity_rh: 48, co2_ppm: 700, dust_ug_m3: 28, illuminance_lux: 430 };
  }

  random() {
    let t = this.randomState = (this.randomState + 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  next() {
    if (this.seq === 4294967295) { this.bootId = createBootId(); this.seq = 0; }
    const { scenario, deviceId, roomId } = this.config;
    const cycle = this.tick % 40;
    this.phase = scenario === 'demo' ? (cycle < 10 ? 'normal' : cycle < 25 ? 'high' : 'recovery') : scenario;
    const co2High = scenario === 'co2_high' || this.phase === 'high';
    const dustHigh = scenario === 'dust_high' || this.phase === 'high';
    const wave = Math.sin(this.tick / 12);
    const targets = { temperature_c: 24 + wave * 0.8, humidity_rh: 48 + wave * 3,
      co2_ppm: co2High ? 1450 : 700, dust_ug_m3: dustHigh ? 180 : 28, illuminance_lux: 430 + wave * 25 };
    const noise = { temperature_c: 0.2, humidity_rh: 0.8, co2_ppm: 20, dust_ug_m3: 3, illuminance_lux: 8 };
    const metrics = {};
    for (const key of Object.keys(this.values)) {
      this.values[key] += (targets[key] - this.values[key]) * 0.32 + (this.random() - 0.5) * noise[key];
      metrics[key] = key === 'co2_ppm' ? Math.round(this.values[key]) : Math.round(this.values[key] * 10) / 10;
    }
    this.tick++;
    return { schema_version: 1, device_id: deviceId, room_id: roomId, boot_id: this.bootId,
      seq: ++this.seq, sampled_at: new Date().toISOString(), source: 'simulator', metrics };
  }
}
