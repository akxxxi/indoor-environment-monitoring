import { createServer } from 'node:http';
import { Store } from './db.js';
import { Events } from './events.js';
import { TelemetryService } from './service.js';
import { createMqtt } from './mqtt.js';
import { createHttp } from './http.js';

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const fail = error => { server.off('listening', done); reject(error); };
    const done = () => { server.off('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', done);
    server.listen(port, host);
  });
}

export async function startApp(config, logger = console) {
  const store = new Store(config.databasePath, config.roomId, config.deviceId);
  const events = new Events(config.heartbeatMs);
  const service = new TelemetryService(store, config, events);
  let mqtt;
  let http;
  let closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      service.close();
      events.close();
      const httpClosed = http ? new Promise(resolve => {
        http.close(resolve);
        http.closeAllConnections();
      }) : Promise.resolve();
      try {
        if (mqtt) await mqtt.close();
        await httpClosed;
      } finally { store.close(); }
    })();
    return closePromise;
  };
  try {
    mqtt = await createMqtt(service, config, logger);
    http = createServer(createHttp(service, events, mqtt, config, logger));
    await listen(mqtt.server, config.mqttPort, config.mqttHost);
    await listen(http, config.httpPort, config.httpHost);
    http.on('error', error => logger.error('HTTP listener error:', error.message));
    mqtt.server.on('error', error => logger.error('MQTT listener error:', error.message));
    return { store, events, service, mqtt, http, close };
  } catch (error) {
    await close();
    throw error;
  }
}
