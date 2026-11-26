# Session Watermark Layer

This prototype places an encrypted session ID into prepared H.264 segments. It changes reserved picture samples at delivery without a per-session video encode. The resulting video plays in a standard decoder. The watermark layer and any playback DRM use independent keys.

## Demo and results

The [marked sample](examples/marked-sample.mp4) plays in a standard H.264 decoder. The [test results](results.json) record session recovery from two marked streams and an aligned re-encode, plus no-match results for the unmarked clip and either wrong key.

On the test Mac, the median in-memory patch was **0.009 ms** per prepared one-second segment over 10,000 runs. This measures the byte patch alone on a 192×160 synthetic clip. See [Scope](#scope) for preparation and robustness limits.

## Key boundaries

| Component | Receives | Purpose |
| --- | --- | --- |
| Isolated issuer | Forensic key and session ID | Seals the ID with AES-256-GCM, scoped to the asset |
| Delivery backend | Placement key and sealed packet | Inserts the packet into secret pixel positions without opening it |
| Player | Ordinary media and a playback license if DRM is used | Plays the video without either watermark key |
| Authorized detector | Both watermark keys and private aligned reference | Reads the packet from pixels and authenticates and opens it |

Generate the two 32-byte keys independently. In deployment, keep the forensic key in an isolated service or vault-backed key boundary and give delivery permission to obtain sealed packets only. Use a distinct placement key, store the session-to-account mapping in private operator records, and use authenticated service interfaces. A playback key cannot open the watermark. The demo uses local files to simulate these roles and does not provision a vault, network boundary, or DRM service.

## Run the demo

Node.js 20 or later is required. The synthetic asset and all its marked variants are silent, 192×160, and 12 seconds long.

```sh
node demo.mjs prepare prepared
node demo.mjs keygen placement.key
node demo.mjs keygen forensic.key
id=$(node demo.mjs session)

# Issuer
node demo.mjs seal prepared forensic.key "$id" playback.packet

# Delivery
node demo.mjs render prepared reference.mp4
node demo.mjs render prepared marked.mp4 placement.key playback.packet
node benchmark.mjs prepared
```

For detection on macOS with Xcode Command Line Tools:

```sh
swiftc -O Decode.swift -o decode
./decode reference.mp4 reference.y 10
./decode marked.mp4 marked.y 10
node demo.mjs detect prepared placement.key forensic.key reference.y marked.y
```

The detector returns the original ID or `null`. Do not put real keys, session records, sealed packets, reference footage, or marked customer footage in a public repository.

## Integrate the delivery SDK

The delivery module uses only the placement key. Supply a packet returned by your isolated issuer.

```js
import { readFile } from 'node:fs/promises';
import { createLayer } from './layer.mjs';

const key = await readFile('placement.key');
const plan = JSON.parse(await readFile('prepared/plan.json', 'utf8'));
const layer = createLayer(key, plan);
const segment = layer.loadSegment(0, await readFile('prepared/segment-0.m4s'));

const sealedPacket = await readFile('playback.packet');
const delivery = layer.prepareSession(sealedPacket);
const videoBytes = delivery.patchSegment(segment);
```

The initialization segment and validated base segment can be shared. Each patched result belongs to one viewing session and must be isolated from shared downstream caches. When using DRM, apply the watermark before encrypting the delivered media.

## Packet and picture format

The 44-byte packet is a 12-byte random nonce, the encrypted 16-byte session ID, and a 16-byte GCM tag. The version and asset ID are authenticated associated data. Use a fresh packet nonce for each sealing operation and define a conservative encryption usage limit and rotation policy per forensic key in production. Retain old key references under authorization for historical investigation.

HMAC-SHA256 derives pixel positions and signs from the independent placement key, asset, and segment number. Each prepared keyframe carries the full packet, with extra copies of selected bits rotating across segments. Patching changes pairs of 3×3 regions by up to four luma levels at reserved H.264 sample offsets. Only selected media bytes change. MP4 metadata, NAL lengths, and segment lengths are unaffected. Detection compares aligned decoded luma against the original, votes across groups, and accepts only if the packet authenticates under the forensic key.

Learning where a mark lives and reading its session ID are separate operations. An authorized decoder needs both keys and the reference in this prototype. Encryption protects the ID from disclosure and forged packets from being accepted. A deliberate edit can still damage the picture signal without recovering the ID, so this prototype makes no guarantee against removal.

## Scope

Preparation uses PCM keyframes to prove the byte patch design with a standard player. They are inefficient for full-resolution titles. Arbitrary existing MP4s cannot be patched without compatible encoder preparation. The benchmark covers only in-memory patching on a synthetic segment. Detection was tested on aligned decoded frames and one H.264 re-encode at the same dimensions. Crop resistance, unknown time alignment, deliberate removal, visual quality, and large-scale delivery have not been validated.
