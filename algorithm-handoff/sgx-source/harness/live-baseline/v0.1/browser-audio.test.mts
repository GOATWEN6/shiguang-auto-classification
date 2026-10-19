import assert from 'node:assert/strict';
import test from 'node:test';
import { Pcm16Packetizer, pcm16ToFloatSamples } from '../../../src/lib/algorithm-service/browser-audio.ts';

test('VAD frame packetizer preserves all samples and a nonempty explicit EOS tail', () => {
  const packetizer = new Pcm16Packetizer();
  const packets = [];
  const frames = Array.from({ length: 18 }, (_, index) => new Float32Array(512).fill(index / 20));
  for (const frame of frames) packets.push(...packetizer.push(frame));
  packets.push(packetizer.finish());
  assert.deepEqual(packets.map(packet => packet.sequence), packets.map((_, index) => index));
  assert.equal(packets.reduce((sum, packet) => sum + packet.audio.length / 2, 0), 18 * 512);
  for (const packet of packets.slice(0, -1)) {
    assert.equal(packet.endOfStream, false); assert.equal(packet.audio.length / 32, 160);
  }
  assert.equal(packets.at(-1)?.endOfStream, true);
  const decoded = packets.flatMap(packet => [...pcm16ToFloatSamples(packet.audio)]);
  assert.ok(Math.abs(decoded[512 * 10] - 0.5) < 0.0001);
  assert.throws(() => packetizer.finish(), /tail_missing/);
});

test('exact packet boundary remains an EOS packet and malformed PCM cannot be played', () => {
  const packetizer = new Pcm16Packetizer();
  assert.deepEqual(packetizer.push(new Float32Array(2560)), []);
  assert.equal(packetizer.finish().audio.byteLength, 5120);
  assert.throws(() => pcm16ToFloatSamples(new Uint8Array(3)), /invalid_pcm16/);
});
