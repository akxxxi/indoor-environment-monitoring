import mqtt from 'mqtt';
import { readConfig } from './config.js';
import { Outbox } from './outbox.js';
import { SimulatorNode } from './node.js';

const log = message => console.log(`${new Date().toISOString()} ${message}`);
let node;
let shuttingDown = false;
async function shutdown(error) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (error) { console.error(error); process.exitCode = 1; }
  try { await node?.stop(); } catch (closeError) { console.error(closeError); process.exitCode = 1; }
  if (process.connected) process.disconnect();
}
try {
  const config = readConfig();
  node = new SimulatorNode({ config, outbox: new Outbox(config.dbPath, config.maxPending), connect: mqtt.connect, log,
    onSettled: ack => { if (process.connected) process.send({ type: 'ack', ack }); } });
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.on('message', message => { if (message?.type === 'stop') void shutdown(); });
  process.once('disconnect', () => void shutdown());
  process.once('uncaughtException', error => void shutdown(error));
  process.once('unhandledRejection', error => void shutdown(error));
  node.start();
} catch (error) { await shutdown(error); }
