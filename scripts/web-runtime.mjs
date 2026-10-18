import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = fileURLToPath(new URL('../Projects/web/', import.meta.url));
process.chdir(webRoot);
const require = createRequire(new URL('../Projects/web/package.json', import.meta.url));
let server, stopping = false;
async function stop() {
  stopping = true;
  if (server) await new Promise(resolve => {
    server.httpServer.close(resolve);
    server.httpServer.closeAllConnections();
  });
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('message', message => { if (message?.type === 'stop') void stop(); });
process.on('disconnect', () => void stop());
try {
  const { build, preview } = await import(pathToFileURL(require.resolve('vite')).href);
  await build();
  if (!stopping) {
    server = await preview({ preview: { host: '127.0.0.1', port: Number(process.env.ENVMON_WEB_PORT || 5173), strictPort: true } });
    console.log(`Web http://127.0.0.1:${server.httpServer.address().port}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  await stop();
}
