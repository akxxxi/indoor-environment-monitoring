import { DEVICE_ID } from './metrics.js';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '');
const devicePath = `/devices/${encodeURIComponent(DEVICE_ID)}`;

export async function request(path, { signal, ...options } = {}) {
  const timeout = AbortSignal.timeout(12000);
  const response = await fetch(`${API_BASE}${path}`, {
    ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message || `服务暂不可用（HTTP ${response.status}），请检查后端连接。`);
  if (!payload || !Object.hasOwn(payload, 'data')) throw new Error('后端返回格式不符合接口约定。');
  return payload;
}

export const getLatest = (signal) => request(`${devicePath}/latest`, { signal });
export const getThresholds = (signal) => request(`${devicePath}/thresholds`, { signal });
export const putThresholds = (config, signal) => request(`${devicePath}/thresholds`, { method: 'PUT', body: JSON.stringify(config), signal });
export const getSeries = (metric, start, end, signal) => request(`${devicePath}/series?${new URLSearchParams({ metric, start: new Date(start).toISOString(), end: new Date(end).toISOString(), max_points: '600' })}`, { signal });
