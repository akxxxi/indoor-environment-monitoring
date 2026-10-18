import { test, expect } from '@playwright/test';

const DEVICE_ID = 'classroom-001-node-001';
const config = { version: 1, consecutive_samples: 3, rules: {
  temperature_c: { enabled: true, lower: 16, upper: 30, hysteresis: 1 },
  humidity_rh: { enabled: true, lower: 30, upper: 70, hysteresis: 3 },
  co2_ppm: { enabled: true, lower: null, upper: 1000, hysteresis: 100 },
  dust_ug_m3: { enabled: true, lower: null, upper: 100, hysteresis: 10 },
  illuminance_lux: { enabled: true, lower: 200, upper: null, hysteresis: 20 },
} };
function measurement(id = 100, offset = 0) {
  const time = new Date(Date.now() + offset).toISOString();
  return { schema_version: 1, id, device_id: DEVICE_ID, room_id: 'classroom-001', boot_id: '7c9a21f0', seq: id, source: 'simulator', sampled_at: time, effective_at: time, received_at: time, stored_at: time, time_quality: 'device', metrics: { temperature_c: 24.6, humidity_rh: null, co2_ppm: 720, dust_ug_m3: 28, illuminance_lux: 430 }, device: { online: true, stale: false, last_seen_at: time }, alarms: [] };
}
async function fixtures(page, { empty = false } = {}) {
  const state = { latest: empty ? null : measurement(), config: structuredClone(config), seriesCalls: [], putBody: null, failPut: false, latestGate: null, seriesGate: null };
  await page.addInitScript(() => {
    window.__streamStats = { created: 0, active: 0, maxActive: 0, timers: new Set() };
    const nativeSetInterval = window.setInterval.bind(window), nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = (fn, ms, ...args) => { const id = nativeSetInterval(fn, ms, ...args); if (ms === 1000) window.__streamStats.timers.add(id); return id; };
    window.clearInterval = (id) => { window.__streamStats.timers.delete(id); nativeClearInterval(id); };
    window.EventSource = class extends EventTarget {
      constructor(url) { super(); this.url = url; this.closed = false; window.__streamStats.created++; window.__streamStats.active++; window.__streamStats.maxActive = Math.max(window.__streamStats.maxActive, window.__streamStats.active); window.__stream = this; queueMicrotask(() => { if (!this.closed) this.onopen?.(); }); }
      close() { if (!this.closed) { this.closed = true; window.__streamStats.active--; } }
      emit(type, data) { this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); }
      disconnect() { this.onerror?.(); }
      reconnect() { this.onopen?.(); }
    };
    document.addEventListener('DOMContentLoaded', () => { const banner = document.createElement('div'); banner.textContent = '自动化验证 fixture · 非真实后端'; banner.style.cssText = 'background:#fff0c2;padding:6px;text-align:center;font-size:11px'; document.body.prepend(banner); });
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/latest')) {
      const snapshot = structuredClone(state.latest);
      if (state.latestGate) await state.latestGate;
      return route.fulfill({ json: { data: snapshot } });
    }
    if (url.pathname.endsWith('/thresholds')) {
      if (route.request().method() === 'GET' && state.failThresholdGet) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: '阈值服务暂不可用。' } } });
      if (route.request().method() === 'PUT') {
        state.putBody = route.request().postDataJSON();
        if (state.failPut) return route.fulfill({ status: 400, json: { error: { code: 'INVALID_THRESHOLDS', message: '恢复区间无效，请调整上下限。' } } });
        state.config = { ...state.putBody, version: state.config.version + 1 };
      }
      return route.fulfill({ json: { data: state.config } });
    }
    if (url.pathname.endsWith('/series')) {
      state.seriesCalls.push(Object.fromEntries(url.searchParams));
      if (state.seriesGate) await state.seriesGate;
      return route.fulfill({ json: { data: empty ? [] : [0, 1, 2, 3, 4].map((n) => ({ time: new Date(Date.now() - (5 - n) * 2000).toISOString(), value: n === 2 ? null : 700 + n * 5, count: n === 2 ? 0 : 1 })), meta: { metric: url.searchParams.get('metric'), bucket_seconds: 2 } } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Unknown test request' } } });
  });
  return state;
}
const emit = (page, type, data) => page.evaluate(({ type, data }) => window.__stream.emit(type, data), { type, data });

test('real connection failure shows explicit errors and no invented readings', async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.abort('connectionrefused'));
  await page.goto('/');
  await expect(page.getByText('暂时无法同步最新快照')).toBeVisible();
  await expect(page.getByText('连接失败 · 自动重试')).toBeVisible();
  await expect(page.getByTestId('value-co2_ppm')).toContainText('—');
  await expect(page.getByText('曲线暂时无法加载')).toBeVisible();
});

test('desktop live readings, null gap, late upload, duplicate IDs, one stream and reconnection', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const state = await fixtures(page);
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.goto('/');
  await expect(page.getByTestId('value-co2_ppm')).toContainText('720');
  await expect(page.getByTestId('value-humidity_rh')).toContainText('—');
  await expect(page.getByText('虚拟数据 · 模拟节点')).toBeVisible();
  await page.getByRole('button', { name: '温度', exact: true }).click();
  await page.getByRole('button', { name: 'CO₂ 浓度', exact: true }).click();
  const old = measurement(101, -60000); old.metrics.co2_ppm = 999;
  await emit(page, 'measurement.created', old);
  await expect(page.getByTestId('value-co2_ppm')).toContainText('720');
  state.latest = measurement(102); state.latest.metrics.co2_ppm = 845;
  await emit(page, 'measurement.created', state.latest); await emit(page, 'measurement.created', state.latest);
  await expect(page.getByTestId('value-co2_ppm')).toContainText('845');
  await page.evaluate(() => window.__stream.disconnect());
  await expect(page.getByText('连接失败 · 自动重试')).toBeVisible();
  const count = state.seriesCalls.length;
  await page.evaluate(() => window.__stream.reconnect());
  await expect(page.getByText('实时连接已建立')).toBeVisible();
  await expect.poll(() => state.seriesCalls.length).toBeGreaterThan(count);
  expect(await page.evaluate(() => ({ active: window.__streamStats.active, max: window.__streamStats.maxActive, timers: window.__streamStats.timers.size }))).toEqual({ active: 1, max: 1, timers: 1 });
  expect(errors).toEqual([]);
  await page.screenshot({ path: 'test-results/desktop-live.png', fullPage: true });
});

test('terminal EventSource failure creates a fresh subscription and restores REST state', async ({ page }) => {
  const state = await fixtures(page); await page.goto('/');
  await expect(page.getByTestId('value-co2_ppm')).toContainText('720');
  state.latest = measurement(104); state.latest.metrics.co2_ppm = 865;
  const before = await page.evaluate(() => window.__streamStats.created);
  await page.evaluate(() => { window.__stream.readyState = 2; window.__stream.disconnect(); });
  await expect.poll(() => page.evaluate(() => window.__streamStats.created)).toBeGreaterThan(before);
  await expect(page.getByText('实时连接已建立')).toBeVisible();
  await expect(page.getByTestId('value-co2_ppm')).toContainText('865');
  expect(await page.evaluate(() => ({ active: window.__streamStats.active, max: window.__streamStats.maxActive, timers: window.__streamStats.timers.size }))).toEqual({ active: 1, max: 1, timers: 1 });
});

test('time alone causes stale state; authoritative alarm events trigger recovery feedback', async ({ page }) => {
  await fixtures(page); await page.goto('/');
  await expect(page.getByText('数据新鲜', { exact: true })).toBeVisible();
  const alarm = { metric: 'co2_ppm', state: 'high', triggered_at: new Date().toISOString() };
  await emit(page, 'alarm.changed', { device_id: DEVICE_ID, alarms: [alarm] });
  await expect(page.getByText('1 项指标需要留意')).toBeVisible();
  await emit(page, 'alarm.changed', { device_id: DEVICE_ID, alarms: [] });
  await expect(page.getByText('CO₂ 浓度：后端已确认报警恢复。')).toBeVisible();
  await page.clock.install(); await page.clock.fastForward(11000);
  await expect(page.getByText('数据已过期', { exact: true }).first()).toBeVisible();
});

test('history uses only bounded series queries, validates seven days and shows empty results', async ({ page }) => {
  const state = await fixtures(page, { empty: true }); await page.goto('/');
  await page.getByRole('tab', { name: '历史查询' }).click();
  await expect(page.getByText('这个时间段还没有数据')).toBeVisible();
  for (const [label, hours] of [['最近 6 小时', 6], ['最近 24 小时', 24]]) {
    await page.getByRole('button', { name: label, exact: true }).click(); await page.getByRole('button', { name: '查询趋势' }).click();
    await expect(page.getByText('这个时间段还没有数据')).toBeVisible();
    const query = state.seriesCalls.at(-1);
    expect(Date.parse(query.end) - Date.parse(query.start)).toBe(hours * 3600000);
    expect(query.max_points).toBe('600');
  }
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('开始时间').fill('2026-10-01T00:00'); await page.getByLabel('结束时间').fill('2026-10-09T00:00');
  const before = state.seriesCalls.length; await page.getByRole('button', { name: '查询趋势' }).click();
  await expect(page.getByText('单次查询最长为 7 天，请缩小时间范围。')).toBeVisible(); expect(state.seriesCalls).toHaveLength(before);
});

test('threshold form keeps engineering parameters, reports server error, and persists success', async ({ page }) => {
  const state = await fixtures(page); await page.goto('/');
  await page.getByRole('button', { name: '阈值设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.getByLabel('CO₂ 浓度上限').fill('1200');
  state.failPut = true; await page.getByRole('button', { name: '保存阈值', exact: true }).click();
  await expect(page.getByText('恢复区间无效，请调整上下限。')).toBeVisible();
  state.failPut = false; await page.getByRole('button', { name: '保存阈值', exact: true }).click();
  await expect(page.getByText(/已保存到后端 · 配置版本 2/)).toBeVisible();
  expect(state.putBody.version).toBeUndefined(); expect(state.putBody.rules.co2_ppm.upper).toBe(1200);
  expect(state.putBody.rules.co2_ppm.hysteresis).toBe(100); expect(state.putBody.consecutive_samples).toBe(3);
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByRole('button', { name: '阈值设置', exact: true }).click(); await expect(page.getByLabel('CO₂ 浓度上限')).toHaveValue('1200');
});

test('390 px mobile and reduced motion fit both views and threshold dialog', async ({ page }) => {
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await fixtures(page); await page.goto('/'); await expect(page.getByTestId('value-co2_ppm')).toContainText('720');
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(await fits()).toBe(true); await page.screenshot({ path: 'test-results/mobile-live.png', fullPage: true });
  await page.getByRole('button', { name: '阈值设置', exact: true }).click(); expect(await fits()).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-thresholds.png', fullPage: true }); await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '历史查询' }).click(); await page.getByRole('button', { name: '自定义', exact: true }).click();
  expect(await fits()).toBe(true); await page.screenshot({ path: 'test-results/mobile-history.png', fullPage: true }); expect(errors).toEqual([]);
});

test('in-flight REST snapshot cannot overwrite newer measurements or authoritative alarms', async ({ page }) => {
  const state = await fixtures(page); await page.goto('/');
  await expect(page.getByTestId('value-co2_ppm')).toContainText('720');
  let release; state.latestGate = new Promise((resolve) => { release = resolve; });
  const requested = page.waitForRequest('**/latest');
  await page.evaluate(() => window.__stream.reconnect()); await requested;
  const incoming = measurement(103, 1000); incoming.metrics.co2_ppm = 1300;
  await emit(page, 'measurement.created', incoming);
  await emit(page, 'alarm.changed', { device_id: DEVICE_ID, alarms: [{ metric: 'co2_ppm', state: 'high', triggered_at: incoming.sampled_at }] });
  release(); state.latestGate = null;
  await expect(page.getByTestId('value-co2_ppm')).toContainText('1,300');
  await expect(page.getByText('1 项指标需要留意')).toBeVisible();
  await page.waitForTimeout(200);
  await expect(page.getByText('1 项指标需要留意')).toBeVisible();
});

test('backfill committed inside an in-flight series interval triggers a new aggregate query', async ({ page }) => {
  const state = await fixtures(page); await page.goto('/');
  await expect(page.getByTestId('value-co2_ppm')).toContainText('720');
  let release; state.seriesGate = new Promise((resolve) => { release = resolve; });
  await page.evaluate(() => window.__stream.reconnect());
  await expect.poll(() => state.seriesCalls.length).toBeGreaterThan(1);
  const before = state.seriesCalls.length;
  await emit(page, 'measurement.created', measurement(104, -3000));
  state.seriesGate = null; release();
  await expect.poll(() => state.seriesCalls.length).toBeGreaterThan(before);
});

test('unknown sample time remains explicit and never becomes a fresh sample', async ({ page }) => {
  const state = await fixtures(page);
  state.latest = { ...measurement(), sampled_at: null, time_quality: 'received_only' };
  await page.goto('/');
  await expect(page.getByText('采样时间未知', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('仅接收时间', { exact: true })).toBeVisible();
  await expect(page.getByText('数据新鲜', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('value-co2_ppm')).toContainText('720');
});

test('successful threshold retry and save clears the earlier synchronization error', async ({ page }) => {
  const state = await fixtures(page); state.failThresholdGet = true;
  await page.goto('/');
  await expect(page.getByText('阈值同步失败，可在设置中重试。')).toBeVisible();
  await page.getByRole('button', { name: '阈值设置', exact: true }).click();
  await expect(page.getByText('阈值服务暂不可用。')).toBeVisible();
  state.failThresholdGet = false;
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.getByRole('button', { name: '保存阈值', exact: true }).click();
  await expect(page.getByText(/已保存到后端 · 配置版本 2/)).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.getByText('阈值同步失败，可在设置中重试。')).toHaveCount(0);
});
