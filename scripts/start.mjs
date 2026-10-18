import { fork, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [], logStreams = [];
let stopping = false, stopPromise, startupError;
const args = process.argv.slice(2);
const options = { httpPort: 3000, mqttPort: 1883, webPort: 5173, intervalMs: 2000, scenario: 'normal', open: true };
const names = { '--http-port': 'httpPort', '--mqtt-port': 'mqttPort', '--web-port': 'webPort', '--interval-ms': 'intervalMs', '--scenario': 'scenario', '--data-dir': 'dataDir' };

async function shutdown(code = 0) {
  if (stopPromise) return stopPromise;
  stopping = true;
  process.exitCode = code;
  stopPromise = (async () => {
    // Reverse order keeps the broker alive until the node's offline status is sent.
    for (const entry of [...children].reverse()) {
      if (entry.exited) continue;
      if (entry.child.connected) entry.child.send({ type: 'stop' }, () => {});
      else entry.child.kill();
      const timer = setTimeout(() => entry.child.kill('SIGKILL'), 6000);
      await entry.done;
      clearTimeout(timer);
    }
    await Promise.all(logStreams.map(stream => new Promise(resolve => stream.end(resolve))));
    console.log('[系统] 已停止。历史数据、阈值和待发队列已保留。');
    if (process.connected) process.disconnect();
  })();
  return stopPromise;
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('message', message => { if (message?.type === 'stop') void shutdown(); });
process.on('disconnect', () => void shutdown());

async function available(port) {
  await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', error => reject(new Error(`端口 ${port} 无法使用 (${error.code})。请关闭占用它的旧服务，或用 --http-port / --mqtt-port / --web-port 指定空闲端口。`)));
    socket.listen(port, '127.0.0.1', () => socket.close(resolve));
  });
}
async function until(check, label, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (startupError) throw startupError;
    if (stopping) throw new Error('启动已取消');
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`${label}超时，请检查日志。`);
}
async function healthy(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    return response.ok && body.data?.status === 'ok' && body.data.mqtt === true && body.data.database === true;
  } catch { return false; }
}
function run(name, script, cwd, env, execArgv = [], argv = [], finite = false) {
  const log = createWriteStream(join(options.logDir, `${name}.log`), { flags: 'a' });
  logStreams.push(log);
  log.on('error', error => { console.error(`日志写入失败: ${error.message}`); void shutdown(1); });
  const child = fork(script, argv, { cwd, env: { ...process.env, ...env }, execArgv, silent: true, windowsHide: true });
  const entry = { child, name, exited: false };
  entry.done = new Promise(resolve => child.once('close', (code, signal) => {
    entry.exited = true;
    resolve();
    if (!stopping && (!finite || code !== 0)) {
      startupError = new Error(`${name} 退出 (code=${code}, signal=${signal})。日志: ${options.logDir}`);
      console.error(startupError.message);
      void shutdown(1);
    }
  }));
  child.on('error', error => { startupError = error; console.error(error.message); void shutdown(1); });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { log.write(chunk); process.stdout.write(`[${name}] ${chunk}`); });
  }
  children.push(entry);
  return entry;
}
async function dependencies(project) {
  const cwd = join(root, 'Projects', project);
  const manifest = JSON.parse(readFileSync(join(cwd, 'package.json')));
  const require = createRequire(join(cwd, 'package.json'));
  try {
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) require.resolve(name);
    if (!existsSync(join(cwd, 'node_modules'))) throw new Error('Missing local install');
    return;
  } catch { console.log(`[系统] 安装 ${project} 的锁定依赖 (npm ci)...`); }
  // Invoke npm's JS entry directly, so Windows never needs shell quoting or an execution-policy change.
  const npmCandidates = [
    join(process.execPath, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npm = npmCandidates.find(existsSync);
  if (!npm) throw new Error(`找不到 npm-cli.js。请在 Projects/${project} 手动执行 npm ci 后重试。`);
  if (stopping) throw new Error('启动已取消');
  const entry = run(`install-${project}`, npm, cwd, {}, [], ['ci'], true);
  await entry.done;
  if (startupError) throw startupError;
}

try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open') options.open = false;
    else if (names[args[i]] && args[i + 1] && !args[i + 1].startsWith('--')) options[names[args[i]]] = args[++i];
    else throw new Error(`未知参数或缺少值: ${args[i]}`);
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 15) throw new Error('请使用 Node.js >=24.15.0 <25（项目基线 24.15.0）。');
  for (const key of ['httpPort', 'mqttPort', 'webPort', 'intervalMs']) {
    options[key] = Number(options[key]);
    const max = key === 'intervalMs' ? 3600000 : 65535;
    if (!Number.isInteger(options[key]) || options[key] < (key === 'intervalMs' ? 50 : 1) || options[key] > max) throw new Error(`${key} 数值无效`);
  }
  if (new Set([options.httpPort, options.mqttPort, options.webPort]).size !== 3) throw new Error('HTTP、MQTT 和网页必须使用不同端口。');
  if (!['normal', 'demo', 'co2_high', 'dust_high'].includes(options.scenario)) throw new Error('scenario 必须为 normal、demo、co2_high 或 dust_high');
  options.logDir = join(root, 'tmp', 'runtime', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
  mkdirSync(options.logDir, { recursive: true });
  console.log(`[系统] 日志: ${options.logDir}`);
  for (const port of [options.httpPort, options.mqttPort, options.webPort]) await available(port);
  for (const project of ['server', 'web', 'simulator']) await dependencies(project);
  if (stopping) throw new Error('启动已取消');
  const httpUrl = `http://127.0.0.1:${options.httpPort}`;
  const webUrl = `http://127.0.0.1:${options.webPort}`;
  const dataDir = options.dataDir && resolve(root, options.dataDir);
  const serverDb = dataDir ? join(dataDir, 'environment.sqlite') : join(root, 'Projects/server/data/environment.sqlite');
  const queueDb = dataDir ? join(dataDir, 'outbox.sqlite') : join(root, 'Projects/simulator/data/outbox.sqlite');
  run('server', join(root, 'Projects/server/src/index.js'), join(root, 'Projects/server'), {
    HTTP_HOST: '127.0.0.1', HTTP_PORT: String(options.httpPort), MQTT_HOST: '127.0.0.1', MQTT_PORT: String(options.mqttPort),
    DEFAULT_DEVICE_ID: 'classroom-001-node-001', DEFAULT_ROOM_ID: 'classroom-001', SQLITE_PATH: serverDb, CORS_ORIGIN: webUrl,
  }, ['--env-file-if-exists=.env']);
  await until(() => healthy(`${httpUrl}/api/v1/health`), '后端就绪');
  run('web', join(root, 'scripts/web-runtime.mjs'), join(root, 'Projects/web'), {
    DEV_API_TARGET: httpUrl, VITE_API_BASE_URL: '/api/v1', ENVMON_WEB_PORT: String(options.webPort),
  });
  await until(() => healthy(`${webUrl}/api/v1/health`), '网页代理就绪');
  let confirmed = false;
  const simulator = run('simulator', join(root, 'Projects/simulator/src/index.js'), join(root, 'Projects/simulator'), {
    MQTT_URL: `mqtt://127.0.0.1:${options.mqttPort}`, DEVICE_ID: 'classroom-001-node-001', ROOM_ID: 'classroom-001',
    UPLOAD_INTERVAL_MS: String(options.intervalMs), SIMULATION_SCENARIO: options.scenario, QUEUE_DB_PATH: queueDb,
  }, ['--env-file-if-exists=.env']);
  simulator.child.on('message', message => {
    if (message?.type === 'ack' && ['stored', 'duplicate'].includes(message.ack?.status)) confirmed = true;
  });
  await until(() => confirmed, '虚拟节点入库确认');
  console.log(`\n[系统] 启动成功，已收到真实入库 ACK。\n网页: ${webUrl}\n采样: ${options.intervalMs}ms / ${options.scenario}\n按 Ctrl+C 统一停止；请保留此窗口。\n`);
  if (process.connected) process.send({ type: 'ready', webUrl, httpUrl, serverDb, queueDb, logDir: options.logDir,
    processes: Object.fromEntries(children.filter(entry => !entry.exited).map(entry => [entry.name, entry.child.pid])) });
  if (options.open) {
    const browser = process.platform === 'win32'
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', webUrl], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('xdg-open', [webUrl], { detached: true, stdio: 'ignore' });
    browser.on('error', error => console.error(`请手动打开 ${webUrl} (${error.message})`));
    browser.unref();
  }
} catch (error) {
  if (!stopping) console.error(`[系统] ${error.message}`);
  await shutdown(stopping ? (process.exitCode || 0) : 1);
}
