/**
 * Minimal protobuf wire-format decoder for Tesla's dashcam SEI metadata.
 *
 * Replaces protobuf.min.js in this repo — the full protobufjs runtime
 * builds its encoders with Function(), which forces the CSP to allow
 * 'unsafe-eval'. This schema is small (16 fields) and stable, so rolling
 * a single-purpose reader is cheaper than maintaining the dependency.
 *
 * Schema (matches the Type defined in the previous _initProtobuf flow):
 *   1  uint32 version
 *   2  GearState gearState        (enum, treated as int)
 *   3  uint64 frameSeqNo          (returned as Number — Tesla never
 *                                   exceeds 2^53 over a session)
 *   4  float  vehicleSpeedMps
 *   5  float  acceleratorPedalPosition
 *   6  float  steeringWheelAngle
 *   7  bool   blinkerOnLeft
 *   8  bool   blinkerOnRight
 *   9  bool   brakeApplied
 *   10 AutopilotState autopilotState  (enum, int)
 *   11 double latitudeDeg
 *   12 double longitudeDeg
 *   13 double headingDeg
 *   14 double linearAccelerationMps2X
 *   15 double linearAccelerationMps2Y
 *   16 double linearAccelerationMps2Z
 *
 * Output shape matches what `SeiMetadata.toObject(decoded, { longs: Number,
 * defaults: true })` produced, so consumers don't need to change.
 */

const DEFAULTS = Object.freeze({
  version: 0,
  gearState: 0,
  frameSeqNo: 0,
  vehicleSpeedMps: 0,
  acceleratorPedalPosition: 0,
  steeringWheelAngle: 0,
  blinkerOnLeft: false,
  blinkerOnRight: false,
  brakeApplied: false,
  autopilotState: 0,
  latitudeDeg: 0,
  longitudeDeg: 0,
  headingDeg: 0,
  linearAccelerationMps2X: 0,
  linearAccelerationMps2Y: 0,
  linearAccelerationMps2Z: 0,
});

function readVarint(view, pos) {
  let val = 0, shift = 0, b, bytesRead = 0;
  do {
    if (bytesRead >= 10 || pos + bytesRead >= view.byteLength) {
      throw new Error('sei-varint-overflow');
    }
    b = view.getUint8(pos + bytesRead);
    // Use Math.pow instead of << to avoid the 32-bit sign-flip when
    // decoding uint64 frame counters.
    val += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    bytesRead++;
  } while (b & 0x80);
  return { val, bytesRead };
}

function skipField(view, pos, wireType) {
  if (wireType === 0) return pos + readVarint(view, pos).bytesRead;
  if (wireType === 1) return pos + 8;
  if (wireType === 5) return pos + 4;
  if (wireType === 2) {
    const { val: len, bytesRead } = readVarint(view, pos);
    return pos + bytesRead + len;
  }
  throw new Error('sei-unsupported-wiretype-' + wireType);
}

/**
 * @param {Uint8Array} bytes — SEI payload with Tesla marker already stripped
 * @returns {object} decoded metadata with all fields defaulted
 */
export function decodeSei(bytes) {
  const out = { ...DEFAULTS };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos < bytes.byteLength) {
    const { val: tag, bytesRead: tagLen } = readVarint(view, pos);
    pos += tagLen;
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    let br;
    switch (fieldNum) {
      case 1: { ({ val: out.version, bytesRead: br } = readVarint(view, pos));
                out.version = out.version >>> 0; pos += br; break; }
      case 2: { ({ val: out.gearState, bytesRead: br } = readVarint(view, pos)); pos += br; break; }
      case 3: { ({ val: out.frameSeqNo, bytesRead: br } = readVarint(view, pos)); pos += br; break; }
      case 4: out.vehicleSpeedMps = view.getFloat32(pos, true); pos += 4; break;
      case 5: out.acceleratorPedalPosition = view.getFloat32(pos, true); pos += 4; break;
      case 6: out.steeringWheelAngle = view.getFloat32(pos, true); pos += 4; break;
      case 7: { let v; ({ val: v, bytesRead: br } = readVarint(view, pos));
                out.blinkerOnLeft = v !== 0; pos += br; break; }
      case 8: { let v; ({ val: v, bytesRead: br } = readVarint(view, pos));
                out.blinkerOnRight = v !== 0; pos += br; break; }
      case 9: { let v; ({ val: v, bytesRead: br } = readVarint(view, pos));
                out.brakeApplied = v !== 0; pos += br; break; }
      case 10: { ({ val: out.autopilotState, bytesRead: br } = readVarint(view, pos)); pos += br; break; }
      case 11: out.latitudeDeg = view.getFloat64(pos, true); pos += 8; break;
      case 12: out.longitudeDeg = view.getFloat64(pos, true); pos += 8; break;
      case 13: out.headingDeg = view.getFloat64(pos, true); pos += 8; break;
      case 14: out.linearAccelerationMps2X = view.getFloat64(pos, true); pos += 8; break;
      case 15: out.linearAccelerationMps2Y = view.getFloat64(pos, true); pos += 8; break;
      case 16: out.linearAccelerationMps2Z = view.getFloat64(pos, true); pos += 8; break;
      default:
        pos = skipField(view, pos, wireType);
    }
  }
  return out;
}
