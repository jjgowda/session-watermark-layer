import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fps, height, initMP4, prepareGOP, width } from './avc.mjs';
import { createLayer, newSessionId } from './layer.mjs';
import { openSessionPacket, sealSessionId } from './forensics.mjs';

const letters = {
  W: [17,17,17,21,21,27,17], A: [14,17,17,31,17,17,17],
  T: [31,4,4,4,4,4,4], E: [31,16,16,30,16,16,31],
  R: [30,17,17,30,20,18,17], M: [17,27,21,21,17,17,17],
  K: [17,18,20,24,20,18,17], L: [16,16,16,16,16,16,31],
  Y: [17,17,10,4,4,4,4], ' ': [0,0,0,0,0,0,0],
  '0': [14,17,19,21,25,17,14], '1': [4,12,4,4,4,4,14],
  '2': [14,17,1,2,4,8,31], '3': [30,1,1,14,1,1,30],
  '4': [2,6,10,18,31,2,2], '5': [31,16,16,30,1,1,30],
  '6': [14,16,16,30,17,17,14], '7': [31,1,2,4,8,8,8],
  '8': [14,17,17,14,17,17,14], '9': [14,17,17,15,1,1,14]
};
const segmentCount = 12;
function drawText(image, text, x, y, scale, ink) {
  for (const character of text) {
    for (const [row, mask] of letters[character].entries()) {
      for (let col = 0; col < 5; col++) {
        if (!(mask & (16 >> col))) continue;
        for (let dy = 0; dy < scale; dy++) {
          const start = (y + row * scale + dy) * width + x + col * scale;
          image.fill(ink, start, start + scale);
        }
      }
    }
    x += 6 * scale;
  }
}
function imageFor(index) {
  const image = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      image[y * width + x] = 36 + (y >> 3) + ((x * 17 + y * 23) % 7);
    }
  }
  drawText(image, 'WATERMARK', 17, 26, 3, 222);
  drawText(image, 'LAYER', 18, 59, 2, 176);
  drawText(image, String(index + 1).padStart(2, '0'), 16, 88, 5, 202);
  for (let y = 138; y < 141; y++) {
    const start = y * width + 17;
    image.fill(93, start, start + 157);
    image.fill(206, start, start + Math.floor(157 * (index + 1) / segmentCount));
  }
  return image;
}
const [command, directory, ...args] = process.argv.slice(2);
const file = (name) => join(directory, name);
const fragment = index => file(`segment-${index}.m4s`);
const readPlan = () => readFile(file('plan.json'), 'utf8').then(JSON.parse);

if (command === 'prepare' && directory && args.length === 0) {
  await mkdir(directory);
  await writeFile(file('init.mp4'), initMP4());
  const plan = { version: 2, assetId: randomBytes(16).toString('hex'), width, height, fps, segments: [] };
  for (let index = 0; index < segmentCount; index++) {
    const { media, offsets } = prepareGOP(imageFor(index), index);
    await writeFile(fragment(index), media);
    plan.segments.push({ bytes: media.length, sha256: createHash('sha256').update(media).digest('hex'), offsets });
  }
  await writeFile(file('plan.json'), JSON.stringify(plan));
} else if (command === 'keygen' && directory && args.length === 0) {
  await writeFile(directory, randomBytes(32), { mode: 0o600, flag: 'wx' });
} else if (command === 'session' && !directory) {
  console.log(newSessionId());
} else if (command === 'seal' && directory && args.length === 3) {
  const [forensicKeyPath, id, output] = args;
  const plan = await readPlan();
  const packet = sealSessionId(await readFile(forensicKeyPath), plan.assetId, id);
  await writeFile(output, packet, { mode: 0o600, flag: 'wx' });
} else if (command === 'render' && directory && (args.length === 1 || args.length === 3)) {
  const [output, keyPath, packetPath] = args;
  const plan = await readPlan();
  const layer = keyPath ? createLayer(await readFile(keyPath), plan) : null;
  const session = layer?.prepareSession(await readFile(packetPath));
  const parts = [await readFile(file('init.mp4'))];
  for (let index = 0; index < plan.segments.length; index++) {
    const base = await readFile(fragment(index));
    parts.push(session ? session.patchSegment(layer.loadSegment(index, base)) : base);
  }
  await writeFile(output, Buffer.concat(parts), { flag: 'wx' });
} else if (command === 'detect' && directory && args.length === 4) {
  const [keyPath, forensicKeyPath, referencePath, candidatePath] = args;
  const plan = await readPlan();
  const layer = createLayer(await readFile(keyPath), plan);
  const [reference, candidate] = await Promise.all([readFile(referencePath), readFile(candidatePath)]);
  const size = plan.width * plan.height;
  if (reference.length !== size * plan.segments.length ||
      candidate.length !== reference.length) throw new Error('Expected one decoded luma frame per segment');
  const pairs = plan.segments.map((_, index) => ({
    index,
    reference: reference.subarray(index * size, (index + 1) * size),
    candidate: candidate.subarray(index * size, (index + 1) * size)
  }));
  const packet = layer.readPacket(pairs);
  const sessionId = openSessionPacket(await readFile(forensicKeyPath), plan.assetId, packet);
  console.log(JSON.stringify({ sessionId }));
} else {
  throw new Error('See README.md for prepare, keygen, session, seal, render, and detect commands');
}
