/** Browser-only helpers. No provider credentials or server imports. */
export function floatSamplesToPcm16(audio: Float32Array): Uint8Array {
  const pcm = new Uint8Array(audio.length * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < audio.length; index += 1) {
    const value = Math.max(-1, Math.min(1, audio[index]));
    view.setInt16(index * 2, Math.round(value < 0 ? value * 32768 : value * 32767), true);
  }
  return pcm;
}
export function pcm16ToFloatSamples(pcm: Uint8Array): Float32Array {
  if (!pcm.byteLength || pcm.byteLength % 2) throw new Error('invalid_pcm16');
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Float32Array(pcm.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}
export class Pcm16Packetizer {
  private pending = new Float32Array(0);
  private sequence = 0;
  private ended = false;
  private totalSamples = 0;
  push(samples: Float32Array): { sequence: number; audio: Uint8Array; endOfStream: boolean }[] {
    if (this.ended) throw new Error('audio_already_ended');
    this.totalSamples += samples.length;
    if (this.totalSamples > 60 * 16_000) throw new Error('audio_duration_limit');
    const combined = new Float32Array(this.pending.length + samples.length);
    combined.set(this.pending); combined.set(samples, this.pending.length);
    const packets = [];
    let offset = 0;
    // Keep a nonempty tail for the provider's explicit final packet.
    while (combined.length - offset > 2560) {
      packets.push({ sequence: this.sequence++, audio: floatSamplesToPcm16(combined.subarray(offset, offset + 2560)),
        endOfStream: false });
      offset += 2560;
    }
    this.pending = combined.slice(offset);
    return packets;
  }
  finish(): { sequence: number; audio: Uint8Array; endOfStream: true } {
    if (this.ended || !this.pending.length) throw new Error('audio_tail_missing');
    this.ended = true;
    const packet = { sequence: this.sequence++, audio: floatSamplesToPcm16(this.pending), endOfStream: true as const };
    this.pending = new Float32Array(0);
    return packet;
  }
}
