import { STALE_MS, WINDOW_MS } from './metrics.js';

export function recordTime(record) {
  return Date.parse(record?.effective_at || record?.sampled_at || record?.received_at) || 0;
}

// Historical uploads and late REST responses must never roll the cards back.
export function newest(current, incoming) {
  if (!incoming) return current;
  if (!current) return incoming;
  const delta = recordTime(incoming) - recordTime(current);
  return delta > 0 || (delta === 0 && Number(incoming.id) >= Number(current.id)) ? incoming : current;
}

export function freshness(record, device, now) {
  if (!record) return 'empty';
  if (record.time_quality !== 'device' || !Number.isFinite(Date.parse(record.sampled_at))) return 'unknown';
  return device?.stale || now - Date.parse(record.sampled_at) > STALE_MS ? 'stale' : 'fresh';
}

export function addRecord(records, record, now) {
  if (record.id == null || records.some((item) => item.id === record.id)) return records;
  return [...records, record].filter((item) => recordTime(item) >= now - WINDOW_MS).slice(-1200);
}

export function livePoints(series, records, metric, now) {
  const points = new Map();
  for (const point of series.points) {
    const time = Date.parse(point.time);
    if (time >= now - WINDOW_MS && time <= now) points.set(time, point);
  }
  for (const record of records) {
    const time = Date.parse(record.sampled_at);
    if (record.time_quality !== 'device' || !Number.isFinite(time) || time < series.end || time < now - WINDOW_MS || time > now) continue;
    points.set(time, { time: record.sampled_at, value: record.metrics?.[metric] ?? null, count: record.metrics?.[metric] == null ? 0 : 1 });
  }
  return [...points.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-1200);
}

export function validateRange(start, end) {
  const from = typeof start === 'number' ? start : Date.parse(start);
  const to = typeof end === 'number' ? end : Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '请选择完整的开始和结束时间。';
  if (from >= to) return '结束时间需要晚于开始时间。';
  if (to - from > 7 * 24 * 60 * 60 * 1000) return '单次查询最长为 7 天，请缩小时间范围。';
  return '';
}
