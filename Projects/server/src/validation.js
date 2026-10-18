import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { METRICS } from './config.js';

const ajv = new Ajv2020({ allErrors: true, strict: true, strictNumbers: true });
addFormats(ajv);
const schema = JSON.parse(readFileSync(new URL('../../../Docs/contracts/telemetry.schema.json', import.meta.url), 'utf8'));
const validateSchema = ajv.compile(schema);

export class InputError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function identity(value) {
  if (value && typeof value.device_id === 'string' && value.device_id.length <= 64 &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.device_id) &&
      typeof value.boot_id === 'string' && /^[0-9a-f]{8,32}$/.test(value.boot_id) &&
      Number.isInteger(value.seq) && value.seq >= 0 && value.seq <= 4294967295) {
    return { schema_version: 1, device_id: value.device_id, boot_id: value.boot_id, seq: value.seq };
  }
  return null;
}

export function validateTelemetry(value, topicDevice, device, now) {
  if (!validateSchema(value)) {
    // Timestamp errors have a stable, actionable code for the sender.
    const timeError = validateSchema.errors.some(e => e.instancePath === '/sampled_at');
    throw new InputError(timeError ? 'INVALID_TIMESTAMP' : 'INVALID_PAYLOAD', ajv.errorsText(validateSchema.errors));
  }
  if (!device || value.device_id !== topicDevice || value.room_id !== device.room_id) {
    throw new InputError('IDENTITY_MISMATCH', 'Topic, registered device and room must match');
  }
  if (value.sampled_at !== null &&
      (!Number.isFinite(Date.parse(value.sampled_at)) || Date.parse(value.sampled_at) > now + 5000)) {
    throw new InputError('INVALID_TIMESTAMP', 'Sampling time is invalid or more than 5 seconds in the future');
  }
  return value;
}

// Schema rejects extra fields first; sorting all keys makes whitespace/key order irrelevant.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

export function validateThresholds(value) {
  const bad = message => { throw new InputError('INVALID_THRESHOLDS', message); };
  if (!keysAre(value, ['consecutive_samples', 'rules']) ||
      !Number.isInteger(value.consecutive_samples) || value.consecutive_samples < 1 || value.consecutive_samples > 1000 ||
      !keysAre(value.rules, METRICS)) bad('Expected consecutive_samples (1..1000) and all five rules, without version');
  for (const metric of METRICS) {
    const rule = value.rules[metric];
    if (!keysAre(rule, ['enabled', 'lower', 'upper', 'hysteresis']) || typeof rule.enabled !== 'boolean' ||
        !Number.isFinite(rule.hysteresis) || rule.hysteresis < 0 ||
        ![rule.lower, rule.upper].every(v => v === null || Number.isFinite(v))) bad(`Invalid rule for ${metric}`);
    const { lower, upper, hysteresis, enabled } = rule;
    if ((lower !== null && !Number.isFinite(lower + hysteresis)) ||
        (upper !== null && !Number.isFinite(upper - hysteresis))) bad(`${metric} recovery boundary must be finite`);
    if (enabled && lower === null && upper === null) bad(`${metric} requires at least one bound`);
    if (lower !== null && upper !== null && (lower >= upper || lower + hysteresis > upper - hysteresis)) {
      bad(`${metric} has no valid recovery interval`);
    }
    if (metric !== 'temperature_c') {
      if ([lower, upper].some(v => v !== null && (v < 0 || (metric === 'humidity_rh' && v > 100)))) bad(`${metric} bounds outside metric range`);
      if (upper !== null && upper - hysteresis < 0) bad(`${metric} recovery boundary is below zero`);
      if (metric === 'humidity_rh' && lower !== null && lower + hysteresis > 100) bad('Humidity recovery boundary exceeds 100');
    }
  }
  return structuredClone(value);
}

export function parseSeries(query, now = Date.now()) {
  const metric = query.metric ?? 'co2_ppm';
  if (typeof metric !== 'string' || !METRICS.includes(metric)) throw new InputError('INVALID_QUERY', 'Unknown metric');
  const parseTime = (raw, fallback) => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !ajv.formats['date-time'].validate(raw) || !Number.isFinite(Date.parse(raw))) {
      throw new InputError('INVALID_QUERY', 'Times must be RFC 3339 timestamps with a timezone');
    }
    return Date.parse(raw);
  };
  const end = parseTime(query.end, now);
  const start = parseTime(query.start, end - 3600000);
  if (start >= end || end - start > 7 * 86400000) throw new InputError('INVALID_QUERY', 'Range must be positive and at most 7 days');
  const raw = query.max_points ?? '600';
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1200) {
    throw new InputError('INVALID_QUERY', 'max_points must be an integer in [1, 1200]');
  }
  const bucketSeconds = Math.max(2, Math.ceil((end - start) / (Number(raw) * 1000)));
  return { metric, start, end, bucketSeconds };
}
