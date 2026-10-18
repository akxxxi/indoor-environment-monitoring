export const DEVICE_ID = 'classroom-001-node-001';
export const WINDOW_MS = 10 * 60 * 1000;
export const STALE_MS = 10 * 1000;
export const METRICS = [
  { key: 'temperature_c', name: '温度', unit: '°C', digits: 1, icon: 'temperature', description: '温度变化，冷暖有度' },
  { key: 'humidity_rh', name: '相对湿度', unit: '%RH', digits: 1, icon: 'humidity', description: '感知空气中的水分' },
  { key: 'co2_ppm', name: 'CO₂ 浓度', unit: 'ppm', digits: 0, icon: 'air', description: '关注教室通风状况' },
  { key: 'dust_ug_m3', name: '粉尘浓度估算值', unit: 'μg/m³', digits: 1, icon: 'dust', description: 'GP2Y1010 粉尘估算' },
  { key: 'illuminance_lux', name: '光照强度', unit: 'lx', digits: 0, icon: 'sun', description: '观察学习空间的明亮度' },
];
export const metricByKey = (key) => METRICS.find((metric) => metric.key === key) || METRICS[2];
export const formatValue = (value, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
export function formatTime(value, withDate = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return '暂无记录';
  return new Date(value).toLocaleString('zh-CN', { ...(withDate ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
