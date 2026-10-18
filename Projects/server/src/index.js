import { readConfig } from './config.js';
import { startApp } from './app.js';

try {
  const config = readConfig();
  const app = await startApp(config);
  console.log(`HTTP http://${config.httpHost}:${app.http.address().port}/api/v1`);
  console.log(`MQTT mqtt://${config.mqttHost}:${app.mqtt.server.address().port} (3.1.1)`);
  console.log(`SQLite ${config.databasePath}`);
  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    console.log(`Closing (${signal})...`);
    try { await app.close(); } catch (error) { console.error(error); process.exitCode = 1; }
    if (process.connected) process.disconnect();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('message', message => { if (message?.type === 'stop') void stop('launcher'); });
  process.on('disconnect', () => void stop('launcher disconnected'));
} catch (error) {
  console.error(`Startup failed: ${error.code ?? ''} ${error.message}`);
  if (error.code === 'EADDRINUSE') console.error('HTTP/MQTT port is occupied. Stop the owning process or change HTTP_PORT/MQTT_PORT.');
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
