import { Aedes } from 'aedes';
import { createServer } from 'node:net';
import { TextDecoder } from 'node:util';
import { identity, InputError } from './validation.js';

const decoder = new TextDecoder('utf-8', { fatal: true });
const telemetryTopic = /^envmon\/v1\/devices\/([a-z0-9]+(?:-[a-z0-9]+)*)\/telemetry$/;
const statusTopic = /^envmon\/v1\/devices\/([a-z0-9]+(?:-[a-z0-9]+)*)\/status$/;

export async function createMqtt(service, config, logger = console) {
  const broker = await Aedes.createBroker({ drainTimeout: 10000 });
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    broker.handle(socket);
  });
  const sendAck = ack => {
    if (service.closing || broker.closed) return;
    broker.publish({
      cmd: 'publish', topic: `envmon/v1/devices/${ack.device_id}/ack`,
      payload: Buffer.from(JSON.stringify(ack)), qos: 1, retain: false,
    }, error => { if (error) logger.error('ACK delivery failed:', error.message); });
  };

  broker.authorizePublish = (client, packet, callback) => {
    const match = telemetryTopic.exec(packet.topic);
    const status = statusTopic.exec(packet.topic);
    if (!match && !status) return callback(new Error('Only telemetry and status upload topics are allowed'));
    if (status) {
      // Status is a hint from a live connection. Ignore orphan/internal retained replay and LWT;
      // actual disconnect tracking below remains authoritative even when a will is malformed.
      try {
        if (client && client.connected && !client.closed && packet.payload.length <= config.maxPayloadBytes) {
          const value = JSON.parse(decoder.decode(packet.payload));
          if (value.schema_version === 1 && value.device_id === status[1] &&
              /^[0-9a-f]{8,32}$/.test(value.boot_id) && ['online', 'offline'].includes(value.state) &&
              service.devices.has(value.device_id)) service.seen(value.device_id, client, value.state === 'online');
        }
      } catch (error) { logger.warn('Invalid status:', error.message); }
      return callback(null);
    }
    let value;
    const wasRetained = packet.retain;
    // Invalid retained telemetry must never be saved by the broker for later replay.
    packet.retain = false;
    try {
      if (packet.payload.length > config.maxPayloadBytes) throw new InputError('INVALID_PAYLOAD', 'Telemetry exceeds 1024-byte payload budget');
      try { value = JSON.parse(decoder.decode(packet.payload)); }
      catch { throw new InputError('INVALID_PAYLOAD', 'Telemetry must be valid UTF-8 JSON'); }
      if (wasRetained) throw new InputError('INVALID_PAYLOAD', 'Retained telemetry is forbidden');
      if (packet.qos !== 1) throw new InputError('INVALID_PAYLOAD', 'Telemetry requires QoS 1');
      if (!client || !client.connected || client.closed) throw new InputError('INVALID_PAYLOAD', 'Telemetry requires a live client');
      sendAck(service.ingest(value, match[1], client));
    } catch (error) {
      if (error instanceof InputError) {
        // Oversize payloads are deliberately not parsed; malformed/unidentifiable input has no ACK.
        const id = identity(value);
        if (id) sendAck({ ...id, status: 'rejected', error: { code: error.code, message: error.message } });
        logger.warn('Telemetry rejected:', error.code, error.message);
      } else {
        // Transient storage errors must leave the sender's outbox intact for retry.
        logger.error('Telemetry storage failed; no application ACK:', error.message);
      }
    }
    // MQTT PUBACK only confirms transport receipt, including application-level rejections.
    callback(null);
  };
  broker.on('clientReady', client => {
    if (service.devices.has(client.id)) service.seen(client.id, client);
  });
  broker.on('clientDisconnect', client => service.disconnected(client));
  broker.on('clientError', (_client, error) => logger.warn('MQTT client error:', error.message));
  broker.on('connectionError', (_client, error) => logger.warn('MQTT connection error:', error.message));
  broker.on('error', error => logger.error('MQTT broker error:', error.message));

  return {
    broker, server,
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      // Destroy even sockets which have not sent CONNECT, so shutdown has a bounded duration.
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => broker.close(resolve));
      await closed;
    },
  };
}
