import type { Difficulty, Note } from "./types";

export type Analysis = {
  bpm: number;
  phase: number;
  onsets: number[];
  confidence: number;
};

const MIN_BPM = 72;
const MAX_BPM = 176;

export function mixdown(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  const chs = buffer.numberOfChannels;
  if (chs === 0 || n === 0) return out;
  for (let c = 0; c < chs; c++) {
    const data = buffer.getChannelData(c);
    const gain = 1 / chs;
    for (let i = 0; i < n; i++) out[i] += data[i] * gain;
  }
  return out;
}

export function analyzeChannel(samples: Float32Array, sampleRate: number): Analysis {
  const frame = Math.max(128, Math.round(sampleRate * 0.011));
  const bass: number[] = [];
  const full: number[] = [];
  const cut = 1 - Math.exp((-2 * Math.PI * 160) / sampleRate);
  let lp = 0;
  let accB = 0;
  let accF = 0;
  let count = 0;

  const limit = Math.min(samples.length, Math.floor(sampleRate * 150));
  for (let i = 0; i < limit; i++) {
    const s = samples[i] ?? 0;
    lp += (s - lp) * cut;
    accB += lp * lp;
    accF += s * s;
    count++;
    if (count === frame) {
      bass.push(accB / count);
      full.push(accF / count);
      accB = 0;
      accF = 0;
      count = 0;
    }
  }

  const flux = new Float32Array(bass.length);
  for (let i = 1; i < bass.length; i++) {
    const b = Math.max(0, (bass[i] ?? 0) - (bass[i - 1] ?? 0));
    const f = Math.max(0, (full[i] ?? 0) - (full[i - 1] ?? 0));
    flux[i] = b * 1.7 + f * 0.4;
  }

  const hop = frame / sampleRate;
  const onsets: number[] = [];
  const minGap = 0.09;
  for (let i = 2; i < flux.length - 2; i++) {
    const v = flux[i] ?? 0;
    if (v < (flux[i - 1] ?? 0) || v <= (flux[i + 1] ?? 0)) continue;
    let sum = 0;
    let sum2 = 0;
    let c = 0;
    const a = Math.max(0, i - 28);
    const b = Math.min(flux.length, i + 8);
    for (let k = a; k < b; k++) {
      const x = flux[k] ?? 0;
      sum += x;
      sum2 += x * x;
      c++;
    }
    const mean = sum / Math.max(1, c);
    const std = Math.sqrt(Math.max(0, sum2 / Math.max(1, c) - mean * mean));
    if (v < mean + std * 1.05 && v < mean * 1.9) continue;
    const t = i * hop;
    const last = onsets[onsets.length - 1];
    if (last != null && t - last < minGap) continue;
    onsets.push(Math.round(t * 1000) / 1000);
  }

  const bpm = estimateBpm(flux, 1 / hop);
  const beat = 60 / bpm;
  const phase = bestPhase(onsets, beat);
  const confidence = gridConfidence(onsets, beat, phase);
  return { bpm, phase, onsets, confidence };
}

function estimateBpm(flux: Float32Array, framesPerSec: number): number {
  let bestBpm = 104;
  let best = -Infinity;
  const scores = new Map<number, number>();
  const step = flux.length > 16000 ? 3 : 2;
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm++) {
    const lag = Math.round((60 / bpm) * framesPerSec);
    if (lag < 2 || lag >= flux.length / 2) continue;
    let corr = 0;
    const n = flux.length - lag;
    for (let i = 0; i < n; i += step) corr += (flux[i] ?? 0) * (flux[i + lag] ?? 0);
    const lag2 = lag * 2;
    if (lag2 < flux.length - 4) {
      let c2 = 0;
      const n2 = flux.length - lag2;
      for (let i = 0; i < n2; i += step * 2) c2 += (flux[i] ?? 0) * (flux[i + lag2] ?? 0);
      corr += c2 * 0.45;
    }
    scores.set(bpm, corr);
    if (corr > best) {
      best = corr;
      bestBpm = bpm;
    }
  }

  const half = clampBpm(Math.round(bestBpm / 2));
  const dbl = clampBpm(Math.round(bestBpm * 2));
  const candidates = [half, bestBpm, dbl];
  let chosen = bestBpm;
  let chosenScore = best;
  for (const c of candidates) {
    const score = scores.get(c) ?? 0;
    const inPocket = c >= 88 && c <= 132;
    const bestInPocket = bestBpm >= 88 && bestBpm <= 132;
    if (score >= chosenScore * 0.9 && inPocket && !bestInPocket) {
      chosen = c;
      chosenScore = score;
    }
  }
  return chosen;
}

function clampBpm(bpm: number): number {
  return Math.max(MIN_BPM, Math.min(MAX_BPM, bpm));
}

export function bestPhase(onsets: number[], beat: number): number {
  if (onsets.length === 0) return 0.12;
  let bestP = onsets[0] ?? 0;
  let bestScore = -1;
  const step = Math.max(0.008, beat / 48);
  for (let p = 0; p < beat; p += step) {
    let score = 0;
    for (const o of onsets) {
      const m = (((o - p) % beat) + beat) % beat;
      const dist = Math.min(m, beat - m);
      if (dist < beat * 0.08) score += 1;
      else if (dist < beat * 0.16) score += 0.35;
    }
    if (score > bestScore) {
      bestScore = score;
      bestP = p;
    }
  }
  return Math.round(bestP * 1000) / 1000;
}

function gridConfidence(onsets: number[], beat: number, phase: number): number {
  if (onsets.length < 4) return 0;
  let hit = 0;
  for (const o of onsets) {
    const m = (((o - phase) % beat) + beat) % beat;
    const dist = Math.min(m, beat - m);
    if (dist < 0.06) hit++;
  }
  return hit / onsets.length;
}

function hasOnset(onsets: number[], t: number, win: number): boolean {
  let lo = 0;
  let hi = onsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = onsets[mid] ?? 0;
    if (v < t - win) lo = mid + 1;
    else if (v > t + win) hi = mid - 1;
    else return true;
  }
  return false;
}

const PATTERNS: Array<[number, number, number, number]> = [
  [0, 2, 1, 3],
  [1, 3, 0, 2],
  [0, 3, 1, 2],
  [1, 2, 0, 3],
];

function sideMate(lane: number): number {
  if (lane === 0) return 1;
  if (lane === 1) return 0;
  if (lane === 2) return 3;
  return 2;
}

export function buildChart(opts: {
  duration: number;
  bpm: number;
  phase: number;
  onsets: number[];
  difficulty: Difficulty;
}): Note[] {
  const beat = 60 / opts.bpm;
  const eighth = beat / 2;
  const maxLevel = opts.difficulty === "facile" ? 1 : opts.difficulty === "normal" ? 2 : 3;
  const drafts: { time: number; lane: number; duration: number; level: number }[] = [];
  const end = Math.max(0, opts.duration - 0.28);

  let guard = 0;
  for (let t = opts.phase; t < end && guard < 8000; t += eighth, guard++) {
    const q = (t - opts.phase) / beat;
    const nearest = Math.round(q);
    const isQuarter = Math.abs(q - nearest) < 0.06;
    const bar = Math.floor(nearest / 4);
    const beatInBar = ((nearest % 4) + 4) % 4;
    const pattern = PATTERNS[((bar % PATTERNS.length) + PATTERNS.length) % PATTERNS.length] ?? PATTERNS[0];
    const lane = pattern[beatInBar] ?? 0;

    if (isQuarter) {
      const hold =
        maxLevel >= 2 && beatInBar === 3 && bar % 4 === 3 ? Math.round(beat * 0.92 * 1000) / 1000 : 0;
      drafts.push({ time: t, lane, duration: hold, level: 1 });
      if (maxLevel >= 3 && beatInBar === 0) {
        drafts.push({ time: t, lane: (lane + 2) % 4, duration: 0, level: 3 });
      }
    } else {
      const supported = hasOnset(opts.onsets, t, 0.07);
      const level = supported ? 2 : 3;
      if (level > maxLevel) continue;
      if (!supported && opts.difficulty === "normal") continue;
      if (opts.difficulty === "normal" && beatInBar !== 0 && beatInBar !== 2) continue;
      drafts.push({
        time: t,
        lane: sideMate(lane),
        duration: 0,
        level,
      });
    }
  }

  drafts.sort((a, b) => a.time - b.time || a.lane - b.lane);
  const notes: Note[] = [];
  const lastEnd = [-1, -1, -1, -1];
  let id = 1;
  for (const d of drafts) {
    const lane = d.lane as 0 | 1 | 2 | 3;
    const prev = lastEnd[lane] ?? -1;
    if (d.time < prev + 0.1) continue;
    notes.push({
      id: id++,
      lane,
      time: Math.round(d.time * 1000) / 1000,
      duration: d.duration,
    });
    lastEnd[lane] = d.time + d.duration;
  }
  return notes;
}
