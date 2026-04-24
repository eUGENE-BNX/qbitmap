/**
 * Round-trip check for js/tesla-sei-decoder.js.
 *
 * We don't have a Tesla MP4 handy in this repo, but protobuf wire format
 * is well-defined — we can build a byte buffer by hand that matches the
 * SeiMetadata schema and confirm the decoder reads every field.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSei } from '../../js/tesla-sei-decoder.js';

function writeVarint(bytes, value) {
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value & 0x7f);
}
function writeTag(bytes, fieldNum, wireType) {
  writeVarint(bytes, (fieldNum << 3) | wireType);
}
function writeFixed32(bytes, value) {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  bytes.push(...new Uint8Array(buf));
}
function writeFixed64(bytes, value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  bytes.push(...new Uint8Array(buf));
}

test('decodeSei: returns defaults when buffer is empty', () => {
  const out = decodeSei(new Uint8Array(0));
  assert.equal(out.version, 0);
  assert.equal(out.gearState, 0);
  assert.equal(out.frameSeqNo, 0);
  assert.equal(out.blinkerOnLeft, false);
  assert.equal(out.latitudeDeg, 0);
});

test('decodeSei: decodes every field in the schema', () => {
  const bytes = [];
  // field 1 (version): varint 3
  writeTag(bytes, 1, 0); writeVarint(bytes, 3);
  // field 2 (gearState): varint 1 = GEAR_DRIVE
  writeTag(bytes, 2, 0); writeVarint(bytes, 1);
  // field 3 (frameSeqNo): varint 1_234_567
  writeTag(bytes, 3, 0); writeVarint(bytes, 1234567);
  // field 4 (vehicleSpeedMps): fixed32 12.5
  writeTag(bytes, 4, 5); writeFixed32(bytes, 12.5);
  // field 5 (acceleratorPedalPosition): fixed32 0.75
  writeTag(bytes, 5, 5); writeFixed32(bytes, 0.75);
  // field 6 (steeringWheelAngle): fixed32 -5.25
  writeTag(bytes, 6, 5); writeFixed32(bytes, -5.25);
  // field 7 (blinkerOnLeft): varint 1 (true)
  writeTag(bytes, 7, 0); writeVarint(bytes, 1);
  // field 8 (blinkerOnRight): varint 0 (false)
  writeTag(bytes, 8, 0); writeVarint(bytes, 0);
  // field 9 (brakeApplied): varint 1
  writeTag(bytes, 9, 0); writeVarint(bytes, 1);
  // field 10 (autopilotState): varint 2 = AP_AUTOSTEER
  writeTag(bytes, 10, 0); writeVarint(bytes, 2);
  // field 11 (latitudeDeg): fixed64 41.015137
  writeTag(bytes, 11, 1); writeFixed64(bytes, 41.015137);
  // field 12 (longitudeDeg): fixed64 28.979530
  writeTag(bytes, 12, 1); writeFixed64(bytes, 28.979530);
  // field 13 (headingDeg): fixed64 87.3
  writeTag(bytes, 13, 1); writeFixed64(bytes, 87.3);
  // field 14-16 (linearAcceleration x/y/z)
  writeTag(bytes, 14, 1); writeFixed64(bytes, 0.1);
  writeTag(bytes, 15, 1); writeFixed64(bytes, -0.2);
  writeTag(bytes, 16, 1); writeFixed64(bytes, 9.81);

  const out = decodeSei(Uint8Array.from(bytes));
  assert.equal(out.version, 3);
  assert.equal(out.gearState, 1);
  assert.equal(out.frameSeqNo, 1234567);
  assert.ok(Math.abs(out.vehicleSpeedMps - 12.5) < 1e-6);
  assert.ok(Math.abs(out.acceleratorPedalPosition - 0.75) < 1e-6);
  assert.ok(Math.abs(out.steeringWheelAngle - -5.25) < 1e-6);
  assert.equal(out.blinkerOnLeft, true);
  assert.equal(out.blinkerOnRight, false);
  assert.equal(out.brakeApplied, true);
  assert.equal(out.autopilotState, 2);
  assert.ok(Math.abs(out.latitudeDeg - 41.015137) < 1e-12);
  assert.ok(Math.abs(out.longitudeDeg - 28.979530) < 1e-12);
  assert.ok(Math.abs(out.headingDeg - 87.3) < 1e-12);
  assert.ok(Math.abs(out.linearAccelerationMps2X - 0.1) < 1e-12);
  assert.ok(Math.abs(out.linearAccelerationMps2Y - -0.2) < 1e-12);
  assert.ok(Math.abs(out.linearAccelerationMps2Z - 9.81) < 1e-12);
});

test('decodeSei: unknown fields (wire type varint/fixed32/fixed64) are skipped', () => {
  const bytes = [];
  // known field 1 = 7
  writeTag(bytes, 1, 0); writeVarint(bytes, 7);
  // unknown field 200, varint
  writeTag(bytes, 200, 0); writeVarint(bytes, 999999);
  // unknown field 201, fixed32
  writeTag(bytes, 201, 5); writeFixed32(bytes, 3.14);
  // unknown field 202, fixed64
  writeTag(bytes, 202, 1); writeFixed64(bytes, 2.718);
  // known field 2 = 3 (gear)
  writeTag(bytes, 2, 0); writeVarint(bytes, 3);

  const out = decodeSei(Uint8Array.from(bytes));
  assert.equal(out.version, 7);
  assert.equal(out.gearState, 3);
});

test('decodeSei: frameSeqNo beyond 2^32 still decodes via double-precision math', () => {
  const bytes = [];
  writeTag(bytes, 3, 0); writeVarint(bytes, 10_000_000_000); // > 2^32, < 2^53
  const out = decodeSei(Uint8Array.from(bytes));
  assert.equal(out.frameSeqNo, 10_000_000_000);
});
