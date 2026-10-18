// A deliberately small test peer, NOT the application backend: no HTTP, schema
// validation, persistence, alarms or production broker. It only speaks the MQTT
// packets needed to exercise this client's transport and application-ACK logic.
import { createServer } from 'node:net';
import packet from 'mqtt-packet';

export class MqttPeer {
  sockets = new Set();
  received = [];
  statuses = [];
  unique = new Map();
  errors = [];
  withholdNext = false;
  repeatAck = true;
  nextId = 1;
  async listen(port = 0) {
    this.server = createServer(socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => {});
      const parser = packet.parser({ protocolVersion: 4 });
      let subscribed = false;
      const send = value => { if (!socket.destroyed) socket.write(packet.generate(value)); };
      socket.on('data', buffer => parser.parse(buffer));
      parser.on('error', error => { this.errors.push(error.message); socket.destroy(); });
      parser.on('packet', value => {
        if (value.cmd === 'connect') {
          if (value.protocolVersion !== 4 || value.will?.retain !== true || value.will?.qos !== 1) this.errors.push('CONNECT / will 不符合协议');
          send({ cmd: 'connack', returnCode: 0, sessionPresent: false });
        } else if (value.cmd === 'subscribe') {
          setTimeout(() => {
            subscribed = true;
            send({ cmd: 'suback', messageId: value.messageId, granted: value.subscriptions.map(() => 1) });
          }, 80);
        } else if (value.cmd === 'pingreq') send({ cmd: 'pingresp' });
        else if (value.cmd === 'disconnect') socket.end();
        else if (value.cmd === 'publish') {
          if (value.qos === 1) send({ cmd: 'puback', messageId: value.messageId });
          if (value.topic.endsWith('/status')) { this.statuses.push(JSON.parse(value.payload.toString())); return; }
          if (!value.topic.endsWith('/telemetry')) return;
          if (!subscribed) this.errors.push('SUBACK 前收到 telemetry');
          if (value.qos !== 1 || value.retain) this.errors.push('telemetry QoS/retain 错误');
          const payload = value.payload.toString();
          const message = JSON.parse(payload);
          this.received.push({ message, payload, at: Date.now() });
          const key = `${message.device_id}/${message.boot_id}/${message.seq}`;
          const existing = this.unique.get(key);
          if (existing && existing.payload !== payload) this.errors.push('重试改写原始 payload');
          const storedAt = existing?.storedAt ?? new Date().toISOString();
          this.unique.set(key, { payload, storedAt });
          if (this.withholdNext) { this.withholdNext = false; return; }
          const ack = { schema_version: 1, device_id: message.device_id, boot_id: message.boot_id,
            seq: message.seq, status: existing ? 'duplicate' : 'stored', stored_at: storedAt };
          this.lastAck = ack;
          const reply = () => send({ cmd: 'publish', topic: value.topic.replace(/telemetry$/, 'ack'),
            payload: JSON.stringify(ack), qos: 1, retain: false, dup: false, messageId: this.nextId++ });
          reply();
          if (this.repeatAck) reply();
        }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    this.port = this.server.address().port;
    return this.port;
  }
  async close() {
    if (!this.server?.listening) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise(resolve => this.server.close(resolve));
  }
}
