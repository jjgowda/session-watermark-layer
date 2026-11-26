import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createLayer, newSessionId } from './layer.mjs';
import { openSessionPacket, sealSessionId } from './forensics.mjs';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node benchmark.mjs PREPARED_ASSET');
const planBytes = await readFile(join(directory, 'plan.json'));
const plan = JSON.parse(planBytes);
const base = await readFile(join(directory, 'segment-0.m4s'));
const key = randomBytes(32);
const layer = createLayer(key, plan);
const mismatched = Buffer.from(base);
mismatched[mismatched.length - 1] ^= 1;
assert.throws(() => layer.loadSegment(0, mismatched), /does not match/);
const loadStarted = performance.now();
const segment = layer.loadSegment(0, base);
const loadMilliseconds = performance.now() - loadStarted;
const forensicKey = randomBytes(32);
const id = newSessionId();
const packet = sealSessionId(forensicKey, plan.assetId, id);
assert.notDeepEqual(packet, sealSessionId(forensicKey, plan.assetId, id));
assert.equal(openSessionPacket(forensicKey, plan.assetId, packet), id);
assert.equal(openSessionPacket(randomBytes(32), plan.assetId, packet), null);
assert.equal(openSessionPacket(forensicKey, newSessionId(), packet), null);
const tampered = Buffer.from(packet);
tampered[13] ^= 1;
assert.equal(openSessionPacket(forensicKey, plan.assetId, tampered), null);
const primary = layer.prepareSession(packet);
const alternate = layer.prepareSession(sealSessionId(forensicKey, plan.assetId, newSessionId()));
const result = primary.patchSegment(segment);
assert.equal(result.length, base.length);
assert.notDeepEqual(result, base);
assert.notDeepEqual(result, alternate.patchSegment(segment));
assert.throws(() => createLayer(key, plan).prepareSession(packet).patchSegment(segment));
let changedBytes = 0;
for (const [index, value] of base.entries()) if (value !== result[index]) changedBytes++;

for (let i = 0; i < 1000; i++) primary.patchSegment(segment);
const durations = [];
for (let i = 0; i < 10000; i++) {
  const started = performance.now();
  primary.patchSegment(segment);
  durations.push(performance.now() - started);
}
durations.sort((a, b) => a - b);
const report = {
  segmentBytes: base.length,
  changedBytes,
  patchPlanBytes: planBytes.length,
  preparedMediaBytes: plan.segments.reduce((total, entry) => total + entry.bytes, 0),
  loadMilliseconds,
  medianPatchMilliseconds: durations[Math.floor(durations.length * 0.5)],
  p95PatchMilliseconds: durations[Math.floor(durations.length * 0.95)],
  iterations: durations.length
};
console.log(JSON.stringify(report, null, 2));
