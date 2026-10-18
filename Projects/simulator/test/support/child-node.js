// IPC is confined to this verification wrapper; the normal CLI uses OS signals.
import '../../src/index.js';
process.on('message', message => {
  if (message === 'stop') {
    process.emit('SIGTERM');
    process.disconnect();
  }
});
