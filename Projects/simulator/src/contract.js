import { readFileSync } from 'node:fs';

// Read the shared contract directly; no separately maintained schema copy.
const schema = JSON.parse(readFileSync(new URL('../../../Docs/contracts/telemetry.schema.json', import.meta.url), 'utf8'));
export const isUtcTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));

function check(value, rule, path) {
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  const matches = types.some(type => type === 'null' ? value === null
    : type === 'integer' ? Number.isSafeInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : typeof value === type);
  if (!matches) throw new Error(`${path}: 类型错误`);
  if ('const' in rule && value !== rule.const) throw new Error(`${path}: 固定值错误`);
  if (rule.enum && !rule.enum.includes(value)) throw new Error(`${path}: 枚举错误`);
  if (value === null) return;
  if (typeof value === 'object') {
    for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: 缺少字段`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(rule.properties, key)) throw new Error(`${path}.${key}: 多余字段`);
      check(child, rule.properties[key], `${path}.${key}`);
    }
  } else if (typeof value === 'string') {
    if (value.length < (rule.minLength ?? 0) || value.length > (rule.maxLength ?? Infinity)
      || (rule.pattern && !new RegExp(rule.pattern).test(value))
      || (rule.format === 'date-time' && !isUtcTime(value))) throw new Error(`${path}: 字符串格式错误`);
  } else if (typeof value === 'number' && (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity))) {
    throw new Error(`${path}: 数值范围错误`);
  }
}

export function serializeTelemetry(message) {
  check(message, schema, 'telemetry');
  if (message.source !== 'simulator') throw new Error('虚拟节点 source 必须为 simulator');
  const payload = JSON.stringify(message);
  if (Buffer.byteLength(payload) > 1024) throw new Error('telemetry 超出 1024 字节');
  return payload;
}

export function validAck(ack) {
  if (!ack || ack.schema_version !== 1 || typeof ack.device_id !== 'string'
    || !/^[0-9a-f]{8,32}$/.test(ack.boot_id) || !Number.isInteger(ack.seq) || ack.seq < 0 || ack.seq > 4294967295) return false;
  if (ack.status === 'stored' || ack.status === 'duplicate') return isUtcTime(ack.stored_at);
  return ack.status === 'rejected' && !Object.hasOwn(ack, 'stored_at')
    && typeof ack.error?.code === 'string' && ack.error.code.length > 0
    && typeof ack.error?.message === 'string' && ack.error.message.length > 0;
}

export const sameIdentity = (a, b) => a.device_id === b.device_id && a.boot_id === b.boot_id && a.seq === b.seq;
