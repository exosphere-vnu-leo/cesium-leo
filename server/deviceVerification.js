import crypto from 'node:crypto';

export class DeviceVerificationRegistry {
  constructor(nodes = new Map()) {
    this.records = new Map();
    for (const node of nodes.values()) {
      if (node.type === 'router') this.provisionRouter(node);
    }
  }

  provisionRouter(node) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    const macAddress = normalizeMacAddress(node.macAddress);
    node.macAddress = macAddress;
    node.originalMacAddress = macAddress;

    this.records.set(String(node.id), {
      deviceId: String(node.id),
      hardwareSerial: node.hardwareSerial,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
      encryptedMacHex: encryptWithPrivateKey(macAddress, privateKey)
    });
  }

  verifyMac(deviceId, macAddress) {
    const record = this.records.get(String(deviceId));
    if (!record) {
      const error = new Error(`Unknown router id: ${deviceId}`);
      error.statusCode = 404;
      throw error;
    }

    const normalizedMac = normalizeMacAddress(macAddress);
    const encryptedCandidate = encryptWithPrivateKey(normalizedMac, record.privateKeyPem);
    if (encryptedCandidate !== record.encryptedMacHex) {
      const error = new Error('MAC verification failed: encrypted MAC differs from server baseline');
      error.statusCode = 409;
      throw error;
    }
    return normalizedMac;
  }
}

export function normalizeMacAddress(value) {
  const hex = String(value ?? '').replace(/[^a-fA-F0-9]/g, '').toUpperCase();
  if (hex.length !== 12) {
    const error = new Error('MAC address must contain 12 hexadecimal digits');
    error.statusCode = 400;
    throw error;
  }
  return hex.match(/.{1,2}/g).join(':');
}

function encryptWithPrivateKey(value, privateKeyPem) {
  return crypto.sign('RSA-SHA256', Buffer.from(value), privateKeyPem).toString('hex');
}
