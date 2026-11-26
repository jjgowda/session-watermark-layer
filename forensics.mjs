import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { idBytes, nonceBytes, packetBytes, tagBytes, validAssetId } from './packet.mjs';

function context(key, assetId) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Expected a 32-byte forensic key');
  if (!validAssetId(assetId)) throw new Error('Expected a prepared asset ID');
  return Buffer.from(`session-watermark/v2/${assetId}`);
}

export function sealSessionId(forensicKey, assetId, sessionId) {
  const aad = context(forensicKey, assetId);
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{32}$/.test(sessionId)) {
    throw new Error('Expected an opaque 16-byte lowercase hex session ID');
  }
  const nonce = randomBytes(nonceBytes);
  const cipher = createCipheriv('aes-256-gcm', forensicKey, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(sessionId, 'hex')), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

export function openSessionPacket(forensicKey, assetId, packet) {
  const aad = context(forensicKey, assetId);
  if (!Buffer.isBuffer(packet) || packet.length !== packetBytes) return null;

  const ciphertextEnd = nonceBytes + idBytes;
  const decipher = createDecipheriv('aes-256-gcm', forensicKey, packet.subarray(0, nonceBytes),
    { authTagLength: tagBytes });
  decipher.setAAD(aad);
  decipher.setAuthTag(packet.subarray(ciphertextEnd));
  const id = decipher.update(packet.subarray(nonceBytes, ciphertextEnd));
  try {
    decipher.final();
  } catch {
    return null;
  }
  return id.toString('hex');
}
