import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp } from '../Projects/server/src/app.js';
import { readConfig } from '../Projects/server/src/config.js';

// No HTTP routing fixtures or replacement EventSource: Chromium uses real REST/SSE.
const root = fileURLToPath(new URL('../', import.meta.url));
const requireWeb = createRequire(new URL('../Projects/web/package.json', import.meta.url));
const { chromium, expect } = requireWeb('@playwright/test');
mkdirSync(join(root, 'tmp', 'integration'), { recursive: true });
const dir = mkdtempSync(join(root, 'tmp', 'integration', 'run-'));
const DEVICE = 'classroom-001-node-001', endpoint = `/api/v1/devices/${DEVICE}`;
const results = [], processes = new Set();
let app, browser, config;
const quiet = { log() {}, warn() {}, error(...args) { console.error(...args); } };
async function wait(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
function pass(name, detail = {}) { results.push({ name, ...detail }); console.log(`PASS ${name}`); }
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function child(script, env, cwd = root, args = []) {
  const proc = fork(join(root, script), args, { cwd, env: { ...process.env, ...env }, silent: true, execArgv: [], windowsHide: true });
  const state = { proc, output: '', messages: [], exited: false };
  proc.stdout.on('data', data => { state.output += data; });
  proc.stderr.on('data', data => { state.output += data; });
  proc.on('message', message => state.messages.push(message));
  proc.on('error', error => { state.output += error.stack; });
  state.done = new Promise(resolve => proc.once('close', code => { state.exited = true; state.code = code; resolve(code); }));
  processes.add(state);
  return state;
}
async function stop(state, force = false) {
  if (!state || state.exited) return;
  if (!force && state.proc.connected) state.proc.send({ type: 'stop' });
  else state.proc.kill('SIGKILL');
  const timer = setTimeout(() => state.proc.kill('SIGKILL'), 8000);
  try { await state.done; } finally { clearTimeout(timer); }
}
function queueRows(path) {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY id").all(); }
  finally { db.close(); }
}
function storedRows() { return app.store.db.prepare('SELECT * FROM measurements ORDER BY id').all(); }
async function json(base, path, options) {
  const response = await fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function released(ports) {
  for (const port of ports) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(resolve));
    });
  }
}

try {
  const webPort = await freePort();
  config = { ...readConfig({}), databasePath: join(dir, 'environment.sqlite'), httpPort: 0, mqttPort: 0, heartbeatMs: 300 };
  app = await startApp(config, quiet);
  config = { ...config, httpPort: app.http.address().port, mqttPort: app.mqtt.server.address().port };
  const httpUrl = `http://127.0.0.1:${config.httpPort}`, webUrl = `http://127.0.0.1:${webPort}`;
  const web = child('scripts/web-runtime.mjs', { ENVMON_WEB_PORT: String(webPort), DEV_API_TARGET: httpUrl, VITE_API_BASE_URL: '/api/v1' });
  await wait(async () => {
    assert.ok(!web.exited, web.output);
    try { return (await fetch(`${webUrl}/api/v1/health`)).ok; } catch { return false; }
  }, 'web proxy ready');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__events = []; window.__streams = 0; window.__maxStreams = 0;
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        this.__closed = false;
        window.__streams++; window.__maxStreams = Math.max(window.__maxStreams, window.__streams);
        for (const type of ['measurement.created', 'device.updated', 'alarm.changed', 'thresholds.updated']) {
          this.addEventListener(type, event => window.__events.push({ type, data: JSON.parse(event.data) }));
        }
      }
      close() { if (!this.__closed) { this.__closed = true; window.__streams--; } super.close(); }
    };
  });
  await page.goto(webUrl);
  await expect(page.getByText('实时连接已建立')).toBeVisible();
  await expect(page.getByTestId('value-co2_ppm')).toContainText('—');
  pass('真实后端空库、网页代理和原生 SSE 连接');

  // Drop one committed ACK inside this test broker to exercise the actual outbox retry.
  const originalPublish = app.mqtt.broker.publish.bind(app.mqtt.broker);
  let dropped;
  app.mqtt.broker.publish = (packet, callback) => {
    if (!dropped && packet.topic.endsWith('/ack')) {
      dropped = JSON.parse(packet.payload.toString()); callback?.(null); return;
    }
    return originalPublish(packet, callback);
  };
  const queueDb = join(dir, 'outbox.sqlite');
  const simEnv = { MQTT_URL: `mqtt://127.0.0.1:${config.mqttPort}`, QUEUE_DB_PATH: queueDb,
    UPLOAD_INTERVAL_MS: '200', MQTT_RECONNECT_MS: '200', ACK_TIMEOUT_MS: '600', RETRY_BASE_MS: '100',
    DEVICE_ID: DEVICE, ROOM_ID: 'classroom-001', SIMULATION_SCENARIO: 'demo' };
  let sim = child('Projects/simulator/src/index.js', simEnv, join(root, 'Projects/simulator'));
  await wait(() => sim.messages.some(message => message.type === 'ack' && message.ack.status === 'duplicate'), 'lost ACK duplicate retry');
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM measurements WHERE boot_id=? AND seq=?').get(dropped.boot_id, dropped.seq).n, 1);
  await expect(page.getByText('数据新鲜', { exact: true })).toBeVisible();
  await expect(page.getByText('设备在线', { exact: true })).toBeVisible();
  await expect(page.getByText('虚拟数据 · 模拟节点')).toBeVisible();
  await wait(() => page.evaluate(() => window.__events.filter(event => event.type === 'measurement.created').length >= 4), 'real measurements');
  pass('真实 MQTT→SQLite→ACK→SSE→网页；丢 ACK 后 duplicate 重试且仅存一条');

  await expect(page.getByText('2 项指标需要留意')).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: join(dir, 'desktop-alarm.png'), fullPage: true });
  await expect(page.getByText('暂无活动报警', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(/后端已确认报警恢复/)).toBeVisible();
  await stop(sim);
  const snapshot = (await json(httpUrl, `${endpoint}/latest`)).data;
  for (const [metric, value] of Object.entries(snapshot.metrics)) {
    const digits = ['temperature_c', 'humidity_rh', 'dust_ug_m3'].includes(metric) ? 1 : 0;
    await expect(page.getByTestId(`value-${metric}`).locator('span').first()).toHaveText(value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  await expect(page.getByText('设备离线', { exact: true })).toBeVisible();
  pass('五项网页读数与 REST 完全一致；CO₂/粉尘报警触发、恢复及节点离线事件');

  await page.getByRole('button', { name: '阈值设置', exact: true }).click();
  await page.getByLabel('CO₂ 浓度上限').fill('1100');
  await page.getByRole('button', { name: '保存阈值', exact: true }).click();
  await expect(page.getByText(/已保存到后端 · 配置版本 2/)).toBeVisible();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  assert.equal((await json(webUrl, `${endpoint}/thresholds`)).data.rules.co2_ppm.upper, 1100);
  await page.reload();
  await page.getByRole('button', { name: '阈值设置', exact: true }).click();
  await expect(page.getByLabel('CO₂ 浓度上限')).toHaveValue('1100');
  await page.keyboard.press('Escape');
  pass('网页阈值 PUT、SQLite 持久保存和刷新回读');

  const start = new Date(Date.now() - 3600000).toISOString(), end = new Date().toISOString();
  for (const metric of Object.keys(snapshot.metrics)) {
    const query = new URLSearchParams({ metric, start, end, max_points: '600' });
    const series = (await json(webUrl, `${endpoint}/series?${query}`)).data;
    assert.ok(series.length > 0);
    const raw = storedRows();
    const count = series.reduce((sum, point) => sum + point.count, 0);
    const average = series.reduce((sum, point) => sum + point.value * point.count, 0) / count;
    assert.equal(count, raw.length);
    assert.ok(Math.abs(average - raw.reduce((sum, row) => sum + row[metric], 0) / raw.length) < 1e-8);
  }
  await page.getByRole('tab', { name: '历史查询' }).click();
  await expect(page.getByText(/\d+ 个有效聚合点/)).toBeVisible();
  await expect(page.locator('.chart-canvas svg')).toHaveCount(1);
  await page.screenshot({ path: join(dir, 'desktop-history.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('tab', { name: '实时看板' }).click();
  await page.screenshot({ path: join(dir, 'mobile-live.png'), fullPage: true });
  pass('五项历史桶均值/样本数与数据库一致；真实历史图及手机布局');

  // Take the backend away, let the real process queue samples, then kill/restart it.
  await app.close(); app = undefined;
  sim = child('Projects/simulator/src/index.js', { ...simEnv, SIMULATION_SCENARIO: 'normal' }, join(root, 'Projects/simulator'));
  await wait(() => queueRows(queueDb).length >= 5, 'offline backlog');
  await stop(sim, true);
  const queuedBefore = queueRows(queueDb);
  sim = child('Projects/simulator/src/index.js', { ...simEnv, SIMULATION_SCENARIO: 'normal' }, join(root, 'Projects/simulator'));
  await wait(() => queueRows(queueDb).length > queuedBefore.length, 'restart preserves queue');
  assert.deepEqual(queueRows(queueDb).slice(0, queuedBefore.length).map(row => row.payload), queuedBefore.map(row => row.payload));
  assert.notEqual(JSON.parse(queueRows(queueDb).at(-1).payload).boot_id, JSON.parse(queuedBefore[0].payload).boot_id);
  await expect(page.getByText('连接失败 · 自动重试')).toBeVisible();
  await expect(page.getByText('数据已过期', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  pass('后端断开时继续持久采样；节点强制终止/重启保留原 payload；网页过期提示');
  const queued = queueRows(queueDb);
  app = await startApp(config, quiet);
  assert.equal(app.store.thresholds(DEVICE).rules.co2_ppm.upper, 1100);
  await wait(() => queued.every(row => app.store.db.prepare('SELECT 1 FROM measurements WHERE boot_id=? AND seq=?').get(row.boot_id, row.seq)), 'all queued rows replayed');
  for (const row of queued) {
    const saved = app.store.db.prepare('SELECT content FROM measurements WHERE boot_id=? AND seq=?').get(row.boot_id, row.seq);
    assert.deepEqual(JSON.parse(saved.content), JSON.parse(row.payload));
  }
  await wait(() => queueRows(queueDb).length === 0, 'outbox drains');
  await expect(page.getByText('实时连接已建立')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('数据新鲜', { exact: true })).toBeVisible();
  await expect(page.getByText('设备在线', { exact: true })).toBeVisible();
  const recent = (await json(httpUrl, `${endpoint}/latest`)).data;
  assert.ok(Date.parse(recent.sampled_at) >= Date.parse(snapshot.sampled_at));
  assert.ok(await page.evaluate(() => window.__maxStreams === 1));
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.screenshot({ path: join(dir, 'desktop-reconnected.png'), fullPage: true });
  pass('后端重启恢复历史/阈值；全部离线原文补传、队列清零、浏览器单 SSE 自动重连', { replayed: queued.length });
  await stop(sim); await browser.close(); browser = undefined;
  await stop(web); await app.close(); app = undefined;
  await released([config.httpPort, config.mqttPort, webPort]);

  const ports = [await freePort(), await freePort(), await freePort()];
  const launcherArgs = ['--no-open', '--http-port', String(ports[0]), '--mqtt-port', String(ports[1]), '--web-port', String(ports[2]), '--data-dir', join(dir, 'launcher')];
  let launcher = child('scripts/start.mjs', {}, root, launcherArgs);
  await wait(() => { assert.ok(!launcher.exited, launcher.output); return launcher.messages.some(message => message.type === 'ready'); }, 'launcher ready', 45000);
  let ready = launcher.messages.find(message => message.type === 'ready');
  assert.equal((await json(ready.webUrl, '/api/v1/health')).data.status, 'ok');
  const first = (await json(ready.httpUrl, `${endpoint}/latest`)).data;
  await stop(launcher);
  assert.equal(launcher.code, 0, launcher.output);
  await released(ports);
  pass('一键启动：三个真实子进程、构建/代理/入库就绪、统一正常停止及端口释放');

  launcher = child('scripts/start.mjs', {}, root, launcherArgs);
  await wait(() => { assert.ok(!launcher.exited, launcher.output); return launcher.messages.some(message => message.type === 'ready'); }, 'launcher restart ready', 45000);
  ready = launcher.messages.find(message => message.type === 'ready');
  assert.ok((await json(ready.httpUrl, `${endpoint}/latest`)).data.id > first.id);
  // Kill only the test-owned node; the supervisor must stop its remaining children.
  process.kill(ready.processes.simulator, 'SIGKILL');
  await wait(() => launcher.exited, 'launcher unexpected-child cleanup');
  assert.equal(launcher.code, 1, launcher.output);
  await released(ports);
  pass('一键启动重复运行保留历史；子进程异常退出自动停止其余服务');

  const occupied = createServer();
  await new Promise(resolve => occupied.listen(ports[0], '127.0.0.1', resolve));
  try {
    launcher = child('scripts/start.mjs', {}, root, launcherArgs);
    await wait(() => launcher.exited, 'occupied port fails');
    assert.equal(launcher.code, 1);
    assert.match(launcher.output, /端口.*无法使用/);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  await released(ports);
  pass('端口占用明确报错，不遗留 MQTT/网页进程');
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: true, time: new Date().toISOString(), results }, null, 2));
  console.log(`\n全部 ${results.length} 组联调通过。截图/数据库/报告: ${dir}`);
} catch (error) {
  console.error(error);
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ passed: false, error: error.stack, results }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  for (const state of [...processes].reverse()) {
    await stop(state);
    writeFileSync(join(dir, `process-${state.proc.pid}.log`), state.output);
  }
  if (app) await app.close();
}
