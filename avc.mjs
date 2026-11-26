// Reference media preparation for a small, independently decodable AVC demo.
class Bits {
  bytes = [];
  value = 0;
  used = 0;

  bits(value, count) {
    for (let position = count - 1; position >= 0; position--) {
      this.value = this.value * 2 + ((value >>> position) & 1);
      if (++this.used === 8) {
        this.bytes.push(this.value);
        this.value = this.used = 0;
      }
    }
  }

  ue(value) {
    const width = Math.floor(Math.log2(value + 1));
    this.bits(0, width);
    this.bits(value + 1, width + 1);
  }

  zeroAlign() {
    if (this.used) this.bits(0, 8 - this.used);
  }

  finish() {
    this.bits(1, 1);
    this.zeroAlign();
    return Buffer.from(this.bytes);
  }
}

const concat = (...parts) => Buffer.concat(parts);
const ascii = word => Buffer.from(word, 'ascii');
const zero = size => Buffer.alloc(size);
function u16(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(value);
  return b;
}
function u32(value) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
}
function box(name, ...parts) {
  return concat(u32(8 + parts.reduce((total, part) => total + part.length, 0)), ascii(name), ...parts);
}
function full(name, flags, ...parts) { return box(name, u32(flags), ...parts); }

function makeNAL(header, rbsp, positions = []) {
  const bytes = [header];
  const offsets = [];
  let zeros = 0;
  for (let i = 0; i < rbsp.length; i++) {
    const byte = rbsp[i];
    if (zeros === 2 && byte <= 3) {
      bytes.push(3);
      zeros = 0;
    }
    if (i === positions[offsets.length]) offsets.push(bytes.length);
    bytes.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return { bytes: Buffer.from(bytes), offsets };
}

export const width = 192;
export const height = 160;
export const fps = 10;
const columns = width / 16;
const rows = height / 16;
const duration = 1000 / fps;

function parameterSets() {
  const sps = new Bits();
  sps.bits(66, 8);                     // Baseline profile.
  sps.bits(0xc0, 8);                   // Constrained Baseline.
  sps.bits(21, 8);                     // Level 2.1 for the sample size and rate.
  sps.ue(0);                          // seq_parameter_set_id
  sps.ue(0);                          // log2_max_frame_num_minus4
  sps.ue(2);                          // pic_order_cnt_type
  sps.ue(1);                          // max_num_ref_frames
  sps.bits(0, 1);                     // gaps_in_frame_num_value_allowed_flag
  sps.ue(columns - 1);
  sps.ue(rows - 1);
  sps.bits(0b1100, 4);                // Progressive, direct_8x8, no crop, no VUI.

  const pps = new Bits();
  pps.ue(0);
  pps.ue(0);
  pps.bits(0, 2);                     // CAVLC, no bottom_field_pic_order.
  pps.ue(0);                          // One slice group.
  pps.ue(0);
  pps.ue(0);                          // Default active references.
  pps.bits(0, 3);                     // No weighted prediction.
  pps.ue(0);
  pps.ue(0);
  pps.ue(0);                          // Three signed zero offsets.
  pps.bits(0b100, 3);                 // Deblocking control present.
  return [makeNAL(0x67, sps.finish()).bytes, makeNAL(0x68, pps.finish()).bytes];
}

function keySlice(picture, row, index) {
  const b = new Bits();
  b.ue(row * columns);
  b.ue(2);                            // I slice.
  b.ue(0);                            // PPS ID.
  b.bits(0, 4);                       // IDR frame_num.
  b.ue(index % 2);
  b.bits(0, 2);                       // IDR reference marking flags.
  b.ue(0);                            // slice_qp_delta (signed zero).
  b.ue(1);                            // Disable deblocking.
  const positions = [];
  for (let col = 0; col < columns; col++) {
    b.ue(25);                         // I_PCM.
    b.zeroAlign();
    positions.push(b.bytes.length);
    for (let y = 0; y < 16; y++) {
      const from = (row * 16 + y) * width + col * 16;
      for (let x = 0; x < 16; x++) b.bytes.push(picture[from + x]);
    }
    for (let p = 0; p < 128; p++) b.bytes.push(128);  // Neutral Cb and Cr.
  }
  return makeNAL(0x65, b.finish(), positions);
}

function skipSlice(frameNumber) {
  const b = new Bits();
  b.ue(0);
  b.ue(0);                            // P slice.
  b.ue(0);
  b.bits(frameNumber, 4);
  b.bits(0, 3);                       // Reference overrides, list edits, adaptive marking.
  b.ue(0);
  b.ue(1);                            // Disable deblocking.
  b.ue(columns * rows);               // Copy the previous reference picture.
  return makeNAL(0x41, b.finish()).bytes;
}

const matrix = concat(
  u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)
);
const emptyTable = name => full(name, 0, u32(0));

export function initMP4() {
  const [sps, pps] = parameterSets();
  const config = box('avcC', Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps);
  const visual = box('avc1', zero(6), u16(1), zero(16), u16(width), u16(height),
    u32(0x480000), u32(0x480000), u32(0), u16(1), zero(32), u16(24), u16(0xffff), config);
  const stbl = box('stbl', full('stsd', 0, u32(1), visual),
    emptyTable('stts'), emptyTable('stsc'), full('stsz', 0, zero(8)), emptyTable('stco'));
  const minf = box('minf', full('vmhd', 1, zero(8)),
    box('dinf', full('dref', 0, u32(1), full('url ', 1))), stbl);
  const mdia = box('mdia', full('mdhd', 0, zero(8), u32(1000), u32(0), u16(0x55c4), u16(0)),
    full('hdlr', 0, u32(0), ascii('vide'), zero(12), ascii('Video\0')), minf);
  const trak = box('trak', full('tkhd', 7, zero(8), u32(1), u32(0), u32(0),
    zero(16), matrix, u32(width * 65536), u32(height * 65536)), mdia);
  const mvhd = full('mvhd', 0, zero(8), u32(1000), u32(0), u32(0x10000),
    u16(0x100), zero(10), matrix, zero(24), u32(2));
  const mvex = box('mvex', full('trex', 0, u32(1), u32(1), u32(duration), u32(0), u32(0)));
  return concat(box('ftyp', ascii('iso6'), u32(1), ascii('iso6isomavc1mp41')), box('moov', mvhd, trak, mvex));
}

export function prepareGOP(picture, index) {
  if (picture.length !== width * height || !picture.every(value => value >= 24 && value <= 231)) {
    throw new Error('Expected full luma plane with all samples between 24 and 231');
  }
  const keyParts = [];
  const relative = [];
  let length = 0;
  for (let row = 0; row < rows; row++) {
    const nal = keySlice(picture, row, index);
    for (const offset of nal.offsets) relative.push(length + 4 + offset);
    keyParts.push(u32(nal.bytes.length), nal.bytes);
    length += 4 + nal.bytes.length;
  }
  const frames = [concat(...keyParts)];
  for (let frame = 1; frame < fps; frame++) {
    const nal = skipSlice(frame);
    frames.push(concat(u32(nal.length), nal));
  }

  function movieFragment(offset) {
    const samples = frames.map((frame, index) =>
      concat(u32(frame.length), u32(index === 0 ? 0x02000000 : 0x01010000)));
    return box('moof', full('mfhd', 0, u32(index + 1)),
      box('traf', full('tfhd', 0x020000, u32(1)), full('tfdt', 0, u32(index * 1000)),
        full('trun', 0x000601, u32(frames.length), u32(offset), ...samples)));
  }

  const moof = movieFragment(movieFragment(0).length + 8);
  const media = concat(moof, box('mdat', ...frames));
  return { media, offsets: relative.map(offset => offset + moof.length + 8) };
}
