/** Audio clock for the chart. syncTime = audioTime + offset. */
export class SongClock {
  readonly ctx: AudioContext;
  readonly buffer: AudioBuffer;
  private readonly music: GainNode;
  private anchor = 0;
  private offset = 0;
  private source: AudioBufferSourceNode | null = null;
  /** Audio-buffer time while paused. Null while running. */
  private pausedAt: number | null = 0;

  constructor(ctx: AudioContext, buffer: AudioBuffer, music: GainNode) {
    this.ctx = ctx;
    this.buffer = buffer;
    this.music = music;
  }

  setOffset(seconds: number) {
    this.offset = seconds;
  }

  audioTime(): number {
    if (this.pausedAt != null) return this.pausedAt;
    return this.ctx.currentTime - this.anchor;
  }

  syncTime(): number {
    return this.audioTime() + this.offset;
  }

  ctxTimeForAudio(audioPos: number): number {
    return this.anchor + audioPos;
  }

  get playing(): boolean {
    return this.pausedAt == null;
  }

  start(fromAudioTime: number) {
    this.cue(fromAudioTime, this.ctx.currentTime + 0.05);
  }

  pause() {
    if (this.pausedAt != null) return;
    this.pausedAt = this.audioTime();
    this.stopSource();
  }

  resume() {
    if (this.pausedAt == null) return;
    const at = this.pausedAt;
    this.pausedAt = null;
    this.cue(at, this.ctx.currentTime + 0.05);
  }

  stop() {
    this.stopSource();
    this.pausedAt = 0;
  }

  private cue(audioPos: number, when: number) {
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.music);
    this.anchor = when - audioPos;
    const dur = this.buffer.duration;
    if (audioPos >= dur - 0.02) {
      this.pausedAt = null;
      return;
    }
    if (audioPos >= 0) src.start(when, audioPos);
    else src.start(this.anchor);
    this.source = src;
    this.pausedAt = null;
  }

  private stopSource() {
    const src = this.source;
    this.source = null;
    if (!src) return;
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* already stopped */
    }
    try {
      src.disconnect();
    } catch {
      /* noop */
    }
  }
}
