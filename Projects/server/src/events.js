export class Events {
  constructor(heartbeatMs) {
    this.clients = new Set();
    this.timer = setInterval(() => {
      for (const client of this.clients) this.write(client, ': heartbeat\n\n');
    }, heartbeatMs);
    this.timer.unref();
  }
  write(client, text) {
    if (client.res.destroyed || client.res.writableEnded) {
      this.clients.delete(client);
      return;
    }
    // Drop slow consumers; EventSource reconnects and restores state from REST.
    if (!client.res.write(text)) {
      client.res.destroy();
      this.clients.delete(client);
    }
  }
  subscribe(id, req, res) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const client = { id, res };
    this.clients.add(client);
    this.write(client, ': connected\n\n');
    res.on('close', () => this.clients.delete(client));
  }
  send(name, data) {
    const text = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) if (client.id === data.device_id) this.write(client, text);
  }
  close() {
    clearInterval(this.timer);
    for (const { res } of this.clients) res.end();
    this.clients.clear();
  }
}
