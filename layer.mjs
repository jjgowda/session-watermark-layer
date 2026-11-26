import { createHash, createHmac, randomBytes } from 'node:crypto';

import { idBytes, packetBytes, validAssetId } from './packet.mjs';

const payloadBits = packetBytes * 8;
const strength = 4;

function hmac(key, fields) {
  return createHmac('sha256', key).update(JSON.stringify(fields)).digest();
}

export function newSessionId() { return randomBytes(idBytes).toString('hex'); }

function frameSlots(key, assetId, segment, count) {
  const pool = Array.from({ length: count }, (_, index) => index);
  let counter = 0;
  let random = Buffer.alloc(0);
  let cursor = 0;
  function next() {
    if (cursor >= random.length) {
      random = hmac(key, ['session-watermark/v2/placement', assetId, segment, counter++]);
      cursor = 0;
    }
    const value = random.readUInt32BE(cursor);
    cursor += 4;
    return value;
  }
  const slots = Math.min(count, payloadBits * 2);
  const extra = slots - payloadBits;
  return Array.from({ length: slots }, (_, ordinal) => {
    const last = pool.length - 1;
    const index = next() % pool.length;
    const slot = pool[index];
    pool[index] = pool[last];
    pool.pop();
    const bit = ordinal < payloadBits ? ordinal : (ordinal - payloadBits + segment * extra) % payloadBits;
    return { slot, bit, polarity: (next() & 1) ? 1 : -1 };
  });
}

function slotCoordinates(slot) {
  const block = Math.floor(slot / 4);
  const sub = slot % 4;
  return { block, x: (sub % 2) * 8 + 1, y: Math.floor(sub / 2) * 8 + 2 };
}

function visitPair(x, y, stride, visit) {
  for (let dy = 0; dy < 3; dy++) {
    const start = (y + dy) * stride + x;
    for (let dx = 0; dx < 3; dx++) visit(start + dx, start + dx + 3);
  }
}

export function createLayer(key, plan) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Expected a 32-byte placement key');
  if (plan.version !== 2 || !validAssetId(plan.assetId)) throw new Error('Unsupported patch plan');
  key = Buffer.from(key);
  const { assetId, width, height } = plan;
  const segments = structuredClone(plan.segments);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width <= 0 || height <= 0 || width % 16 || height % 16) throw new Error('Invalid frame geometry');
  const columns = width / 16;
  const blockCount = columns * (height / 16);
  const candidateCount = blockCount * 4;
  if (candidateCount < payloadBits || !Array.isArray(segments) || !segments.length) {
    throw new Error('Not enough prepared samples for the watermark');
  }
  for (const { offsets, bytes, sha256 } of segments) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !/^[a-f0-9]{64}$/.test(sha256) ||
        !Array.isArray(offsets) || offsets.length !== blockCount ||
        offsets.some((offset, i) => !Number.isSafeInteger(offset) || offset < 0 ||
          offset + 256 > bytes || (i && offset < offsets[i - 1] + 256))) {
      throw new Error('Invalid media record in the patch plan');
    }
  }
  function operators(index) {
    const { offsets } = segments[index];
    return frameSlots(key, assetId, index, candidateCount).map(({ slot, bit, polarity }) => {
      const { block, x, y } = slotCoordinates(slot);
      const encoded = [];
      const decoded = [];
      const px = (block % columns) * 16 + x;
      const py = Math.floor(block / columns) * 16 + y;
      visitPair(x, y, 16, (a, b) => encoded.push(offsets[block] + a, offsets[block] + b));
      visitPair(px, py, width, (a, b) => decoded.push(a, b));
      return { bit, polarity, encoded, decoded };
    });
  }
  const prepared = new WeakMap();
  return {
    loadSegment(index, base) {
      const segment = segments[index];
      if (!segment || !Buffer.isBuffer(base) || base.length !== segment.bytes ||
          createHash('sha256').update(base).digest('hex') !== segment.sha256) {
        throw new Error('Segment does not match the patch plan');
      }
      const handle = Object.freeze({ index });
      prepared.set(handle, { bytes: Buffer.from(base), operations: operators(index) });
      return handle;
    },

    prepareSession(sealedPacket) {
      if (!Buffer.isBuffer(sealedPacket) || sealedPacket.length !== packetBytes) {
        throw new Error('Expected a sealed session packet from the issuer');
      }
      const bits = Buffer.from(sealedPacket);
      return {
        patchSegment(handle) {
          const segment = prepared.get(handle);
          if (!segment) throw new Error('Expected a segment loaded by this asset layer');
          const media = Buffer.from(segment.bytes);
          for (const { bit, polarity, encoded } of segment.operations) {
            const one = (bits[bit >> 3] >> (7 - (bit & 7))) & 1;
            const delta = (one ? 1 : -1) * polarity * strength;
            for (let i = 0; i < encoded.length; i += 2) {
              const a = encoded[i];
              const b = encoded[i + 1];
              if (media[a] < 24 || media[a] > 231 || media[b] < 24 || media[b] > 231) {
                throw new Error('The prepared sample has been changed');
              }
              media[a] += delta;
              media[b] -= delta;
            }
          }
          return media;
        }
      };
    },

    readPacket(frames) {
      const votes = new Float64Array(payloadBits);
      const seen = new Set();
      for (const { index, reference, candidate } of frames) {
        if (!segments[index] || seen.has(index) || reference.length !== width * height ||
            candidate.length !== width * height) throw new Error('Expected one aligned luma frame pair per segment');
        seen.add(index);
        for (const { bit, polarity, decoded } of operators(index)) {
          let difference = 0;
          for (let i = 0; i < decoded.length; i += 2) {
            const a = decoded[i];
            const b = decoded[i + 1];
            difference += (candidate[a] - candidate[b]) - (reference[a] - reference[b]);
          }
          votes[bit] += polarity * difference;
        }
      }
      const result = Buffer.alloc(packetBytes);
      if (!seen.size || votes.some(value => value === 0)) return null;
      for (let bit = 0; bit < payloadBits; bit++) {
        if (votes[bit] > 0) result[bit >> 3] |= 1 << (7 - (bit & 7));
      }
      return result;
    }
  };
}
