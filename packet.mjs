// Shared packet framing. No forensic key or decoding logic is needed for delivery.
export const idBytes = 16;
export const nonceBytes = 12;
export const tagBytes = 16;
export const packetBytes = nonceBytes + idBytes + tagBytes;

export function validAssetId(assetId) {
  return typeof assetId === 'string' && /^[a-f0-9]{32}$/.test(assetId);
}
