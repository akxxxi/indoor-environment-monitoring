import { readConfig } from '../src/config.js';
import { Outbox } from '../src/outbox.js';

const config = readConfig();
const outbox = new Outbox(config.dbPath, config.maxPending);
try {
  console.log(JSON.stringify({ database: config.dbPath, ...outbox.summary() }, null, 2));
} finally { outbox.close(); }
