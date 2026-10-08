import type { Difficulty, Note } from "./types";

const SR = 44100;

export type DemoId = "salon" | "nuit" | "caroline";

export type DemoMeta = {
  id: DemoId;
  title: string;
  blurb: string;
  bpm: number;
};

export const DEMOS: DemoMeta[] = [
  { id: "salon", title: "Le salon", blurb: "Doux, pour commencer", bpm: 86 },
  { id: "nuit", title: "Nuit claire", blurb: "Un coup décalé, à apprendre", bpm: 102 },
  { id: "caroline", title: "Pour Caroline", blurb: "Plus vivant, à deux", bpm: 118 },
];

type Ev = {
  time: number;
  dur: number;
  kind: "kick" | "snare" | "hat" | "openhat" | "bass" | "chord" | "lead" | "click" | "riser";
  vel: number;
  freq: number;
  freq2: number;
  freq3: number;
  ph: number;
  ph2: number;
  ph3: number;
  lp: number;
};

type Draft = { beat: number; lane: 0 | 1 | 2 | 3; level: 1 | 2 | 3; hold?: number };

export type RenderedDemo = {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  bpm: number;
  beat: number;
  musicStart: number;
  notes: Record<Difficulty, Note[]>;
};

export function midi(m: number): number {
  return 440 * 2 ** ((m - 69) / 12);
}

function makeNoise(n: number): Float32Array {
  const a = new Float32Array(n);
  let x = 123456789;
  for (let i = 0; i < n; i++) {
    x = (1103515245 * x + 12345) & 0x7fffffff;
    a[i] = x / 0x3fffffff - 1;
  }
  return a;
}

const NOISE = makeNoise(SR);

function adsr(t: number, dur: number, a: number, d: number, s: number, r: number): number {
  if (t < 0) return 0;
  if (t < a) return a <= 0 ? 1 : t / a;
  const rel = Math.max(a + d, dur - r);
  if (t < a + d && t < rel) return 1 - (1 - s) * ((t - a) / Math.max(0.0001, d));
  if (t < rel) return s;
  if (t < rel + r) return s * (1 - (t - rel) / Math.max(0.0001, r));
  return 0;
}

function voice(e: Ev, lt: number, i: number): number {
  const nse = NOISE[(i + Math.floor(e.time * 17)) % NOISE.length] ?? 0;
  if (e.kind === "kick") {
    const f = 46 + 150 * Math.exp(-lt * 26);
    e.ph += (2 * Math.PI * f) / SR;
    const amp = Math.exp(-lt * 9.5) * e.vel;
    const click = lt < 0.008 ? (1 - lt / 0.008) * 0.45 * e.vel : 0;
    return Math.tanh(Math.sin(e.ph) * 1.5) * amp + click * (nse * 0.3 + 1);
  }
  if (e.kind === "snare") {
    e.ph += (2 * Math.PI * e.freq) / SR;
    const tone = Math.sin(e.ph) * Math.exp(-lt * 28) * 0.45;
    const noise = nse * Math.exp(-lt * 16) * 0.85;
    return (tone + noise) * e.vel * adsr(lt, e.dur, 0.002, 0.04, 0.3, 0.08);
  }
  if (e.kind === "hat" || e.kind === "openhat") {
    e.lp += (nse - e.lp) * (e.kind === "hat" ? 0.35 : 0.18);
    const hp = nse - e.lp;
    const decay = e.kind === "hat" ? 42 : 14;
    return hp * Math.exp(-lt * decay) * e.vel * 1.4;
  }
  if (e.kind === "click") {
    e.ph += (2 * Math.PI * e.freq) / SR;
    return (Math.sin(e.ph) * 0.65 + nse * 0.25) * Math.exp(-lt * 28) * e.vel;
  }
  if (e.kind === "riser") {
    e.lp += (nse - e.lp) * (0.05 + lt * 0.4);
    const hp = nse - e.lp;
    const env = Math.sin(Math.min(1, lt / Math.max(0.05, e.dur)) * Math.PI) ** 1.2;
    return hp * env * e.vel * 0.8;
  }
  if (e.kind === "bass") {
    const f = e.freq * (1 - 0.01 * Math.exp(-lt * 30));
    e.ph += (2 * Math.PI * f) / SR;
    const amp = adsr(lt, e.dur, 0.008, 0.08, 0.55, 0.06);
    return Math.tanh(Math.sin(e.ph) * 1.25) * amp * e.vel;
  }
  if (e.kind === "chord") {
    e.ph += (2 * Math.PI * e.freq) / SR;
    e.ph2 += (2 * Math.PI * e.freq2) / SR;
    e.ph3 += (2 * Math.PI * e.freq3) / SR;
    const amp = adsr(lt, e.dur, 0.03, 0.12, 0.45, 0.12);
    const s = Math.sin(e.ph) + Math.sin(e.ph2) * 0.85 + Math.sin(e.ph3) * 0.7;
    return s * amp * e.vel * 0.45;
  }
  e.ph += (2 * Math.PI * e.freq) / SR;
  e.ph2 += (2 * Math.PI * e.freq * 2) / SR;
  const amp = adsr(lt, e.dur, 0.02, 0.1, 0.35, 0.08);
  return (Math.sin(e.ph) + Math.sin(e.ph2) * 0.12) * amp * e.vel;
}

export async function renderEvents(events: Ev[], duration: number): Promise<Float32Array> {
  const n = Math.ceil(duration * SR);
  const data = new Float32Array(n);
  const evs = [...events].sort((a, b) => a.time - b.time);
  const active: Ev[] = [];
  let ei = 0;
  const chunk = SR;
  for (let start = 0; start < n; start += chunk) {
    const end = Math.min(n, start + chunk);
    for (let i = start; i < end; i++) {
      const t = i / SR;
      while (ei < evs.length && (evs[ei]?.time ?? 0) <= t) {
        const next = evs[ei];
        if (next) active.push(next);
        ei++;
      }
      let acc = 0;
      for (let k = active.length - 1; k >= 0; k--) {
        const e = active[k];
        if (!e) continue;
        const lt = t - e.time;
        if (lt > e.dur + 0.03) {
          active.splice(k, 1);
          continue;
        }
        acc += voice(e, lt, i);
      }
      data[i] = Math.tanh(acc * 1.2);
    }
    if (end < n) await new Promise((r) => setTimeout(r, 0));
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i] ?? 0));
  const g = peak > 0.001 ? 0.8 / peak : 1;
  const fade = Math.floor(SR * 0.18);
  for (let i = 0; i < n; i++) {
    let s = (data[i] ?? 0) * g;
    if (i < 64) s *= i / 64;
    if (i > n - fade) s *= (n - i) / fade;
    data[i] = s;
  }
  return data;
}

function ev(
  time: number,
  kind: Ev["kind"],
  vel: number,
  dur: number,
  freq = 0,
  freq2 = 0,
  freq3 = 0,
): Ev {
  return { time, dur, kind, vel, freq, freq2, freq3, ph: 0, ph2: 0, ph3: 0, lp: 0 };
}

const LANES: Array<[0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3, 0 | 1 | 2 | 3]> = [
  [0, 2, 1, 3],
  [1, 3, 0, 2],
  [0, 3, 1, 2],
  [1, 2, 0, 3],
];

function mate(lane: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
  if (lane === 0) return 1;
  if (lane === 1) return 0;
  if (lane === 2) return 3;
  return 2;
}

function notesFrom(drafts: Draft[], beatDur: number, shift: number): Record<Difficulty, Note[]> {
  const cap = { facile: 1, normal: 2, difficile: 3 } as const;
  const out: Record<Difficulty, Note[]> = { facile: [], normal: [], difficile: [] };
  (Object.keys(cap) as Difficulty[]).forEach((diff) => {
    const list: Note[] = [];
    const last = [-99, -99, -99, -99];
    let id = 1;
    const sorted = [...drafts].sort((a, b) => a.beat - b.beat || a.lane - b.lane);
    for (const d of sorted) {
      if (d.level > cap[diff]) continue;
      const time = d.beat * beatDur + shift;
      const duration = (d.hold ?? 0) * beatDur;
      const prev = last[d.lane] ?? -99;
      if (time < prev + 0.09) continue;
      list.push({
        id: id++,
        lane: d.lane,
        time: Math.round(time * 1000) / 1000,
        duration: duration ? Math.round(duration * 1000) / 1000 : 0,
      });
      last[d.lane] = time + duration;
    }
    out[diff] = list;
  });
  return out;
}

type Chord = { bass: number; tones: [number, number, number] };

type Accent = { beat: number; drum: "kick" | "snare" | "both"; level: 1 | 2 | 3 };

function build(spec: {
  bpm: number;
  bars: number;
  chords: Chord[];
  melody: Array<[number, number, number]>;
  accents: Accent[];
  hats: Array<{ beat: number; level: 1 | 2 | 3 }>;
}): { events: Ev[]; notes: Record<Difficulty, Note[]>; duration: number; beat: number; musicStart: number } {
  const beat = 60 / spec.bpm;
  const intro = 4 * beat;
  const events: Ev[] = [];
  const drafts: Draft[] = [];

  for (let i = 0; i < 4; i++) {
    events.push(ev(i * beat, "click", i === 3 ? 0.55 : 0.38, 0.12, i === 3 ? 988 : 740));
  }

  for (let bar = 0; bar < spec.bars; bar++) {
    const origin = bar * 4;
    const lanes = LANES[bar % LANES.length] ?? LANES[0];
    const chord = spec.chords[bar % spec.chords.length] ?? spec.chords[0];
    if (!chord) continue;

    for (const a of spec.accents) {
      const lane = lanes[Math.floor(a.beat) % 4] ?? 0;
      const off = a.beat % 1 > 0.2;
      const useLane = off ? mate(lane) : lane;
      const t = (origin + a.beat) * beat + intro;
      if (a.drum === "kick" || a.drum === "both") events.push(ev(t, "kick", 0.96, 0.24, 52));
      if (a.drum === "snare" || a.drum === "both") events.push(ev(t, "snare", 0.58, 0.18, 196));
      const hold = a.level <= 2 && Math.floor(a.beat) === 3 && bar % 4 === 3 && a.beat % 1 < 0.1 ? 1 : 0;
      if (hold) events.push(ev(t, "riser", 0.22, beat * 0.95, 800));
      drafts.push({ beat: origin + a.beat, lane: useLane, level: a.level, hold: hold || undefined });
      if (a.level === 1 && a.beat % 1 < 0.1 && Math.floor(a.beat) === 0 && bar % 2 === 0) {
        drafts.push({ beat: origin, lane: ((useLane + 2) % 4) as 0 | 1 | 2 | 3, level: 3 });
      }
    }

    for (const h of spec.hats) {
      const q = Math.floor(h.beat);
      const lane = mate(lanes[q % 4] ?? 0);
      const t = (origin + h.beat) * beat + intro;
      const open = h.beat % 1 > 0.6 && q === 3;
      events.push(ev(t, open ? "openhat" : "hat", open ? 0.2 : h.beat % 1 < 0.1 ? 0.2 : 0.14, open ? 0.16 : 0.05));
      drafts.push({ beat: origin + h.beat, lane, level: h.level });
    }

    const stab = (origin + 0) * beat + intro;
    events.push(ev(stab, "chord", 0.2, beat * 1.15, midi(chord.tones[0]), midi(chord.tones[1]), midi(chord.tones[2])));
    events.push(
      ev(stab + beat * 2, "chord", 0.12, beat * 0.7, midi(chord.tones[0]), midi(chord.tones[1]), midi(chord.tones[2])),
    );
    events.push(ev(stab, "bass", 0.52, beat * 0.85, midi(chord.bass)));
    events.push(ev(stab + beat * 2, "bass", 0.4, beat * 0.55, midi(chord.bass + 7)));
    if (bar % 2 === 1) {
      events.push(ev(stab - beat * 0.18, "bass", 0.22, beat * 0.16, midi(chord.bass - 1)));
    }
  }

  for (const [b, m, d] of spec.melody) {
    events.push(ev(b * beat + intro, "lead", 0.22, Math.max(0.12, d * beat), midi(m)));
  }

  const endBeat = spec.bars * 4;
  const endT = endBeat * beat + intro;
  const last = spec.chords[(spec.bars - 1) % spec.chords.length];
  if (last) {
    events.push(ev(endT, "kick", 0.9, 0.3, 50));
    events.push(ev(endT, "chord", 0.24, beat * 2, midi(last.tones[0]), midi(last.tones[1]), midi(last.tones[2])));
    events.push(ev(endT, "bass", 0.48, beat * 1.4, midi(last.bass)));
  }
  drafts.push({ beat: endBeat, lane: 0, level: 1 });

  const duration = endT + beat * 2.2;
  return {
    events,
    notes: notesFrom(drafts, beat, intro),
    duration,
    beat,
    musicStart: intro,
  };
}

const SALON_CHORDS: Chord[] = [
  { bass: 38, tones: [54, 57, 62] },
  { bass: 47, tones: [59, 62, 66] },
  { bass: 43, tones: [55, 59, 62] },
  { bass: 45, tones: [57, 61, 64] },
];

const NUIT_CHORDS: Chord[] = [
  { bass: 45, tones: [57, 60, 64] },
  { bass: 41, tones: [53, 57, 60] },
  { bass: 36, tones: [48, 52, 55] },
  { bass: 40, tones: [52, 55, 59] },
];

const CARO_CHORDS: Chord[] = [
  { bass: 41, tones: [53, 57, 60] },
  { bass: 36, tones: [48, 52, 55] },
  { bass: 38, tones: [50, 53, 57] },
  { bass: 46, tones: [58, 62, 65] },
];

const QUARTERS: Accent[] = [
  { beat: 0, drum: "kick", level: 1 },
  { beat: 1, drum: "snare", level: 1 },
  { beat: 2, drum: "kick", level: 1 },
  { beat: 3, drum: "snare", level: 1 },
];

const NUIT_ACCENTS: Accent[] = [
  { beat: 0, drum: "kick", level: 1 },
  { beat: 1, drum: "snare", level: 1 },
  { beat: 2.5, drum: "kick", level: 1 },
  { beat: 3, drum: "snare", level: 1 },
];

const DANCE: Accent[] = [
  { beat: 0, drum: "kick", level: 1 },
  { beat: 1, drum: "both", level: 1 },
  { beat: 2, drum: "kick", level: 1 },
  { beat: 3, drum: "both", level: 1 },
];

const HATS_2: Array<{ beat: number; level: 1 | 2 | 3 }> = [
  { beat: 0.5, level: 2 },
  { beat: 2.5, level: 2 },
  { beat: 1.5, level: 3 },
  { beat: 3.5, level: 3 },
];

const HATS_DANCE: Array<{ beat: number; level: 1 | 2 | 3 }> = [
  { beat: 0.5, level: 2 },
  { beat: 1.5, level: 2 },
  { beat: 2.5, level: 2 },
  { beat: 3.5, level: 3 },
];

function melody(phrase: Array<[number, number, number]>, bars: number, every = 8): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const span = every;
  for (let bar = 0; bar < bars; bar += span) {
    for (const [b, m, d] of phrase) out.push([bar * 4 + b, m, d]);
  }
  return out;
}

const SALON_MELODY: Array<[number, number, number]> = [
  [0, 74, 1],
  [1, 78, 0.5],
  [1.5, 76, 0.5],
  [2, 74, 1.5],
  [4, 71, 1],
  [5, 74, 1],
  [6, 69, 1.5],
  [8, 71, 1],
  [9, 74, 0.5],
  [9.5, 76, 0.5],
  [10, 78, 1.5],
  [12, 76, 0.5],
  [12.5, 74, 0.5],
  [13, 73, 0.5],
  [13.5, 71, 0.5],
  [14, 74, 2],
];

const NUIT_MELODY: Array<[number, number, number]> = [
  [0, 76, 0.75],
  [1, 74, 0.5],
  [1.5, 72, 0.5],
  [2.5, 74, 0.5],
  [3, 69, 1],
  [4, 72, 1],
  [5, 76, 0.5],
  [6, 74, 1.5],
  [8, 77, 0.5],
  [8.5, 76, 0.5],
  [9, 74, 1],
  [10.5, 72, 0.5],
  [12, 69, 1],
  [13, 72, 0.5],
  [14, 74, 2],
];

const CARO_MELODY: Array<[number, number, number]> = [
  [0, 77, 0.5],
  [0.5, 81, 0.5],
  [1, 79, 0.5],
  [1.5, 77, 0.5],
  [2, 74, 1],
  [4, 72, 0.5],
  [4.5, 74, 0.5],
  [5, 77, 1],
  [6.5, 76, 0.5],
  [8, 74, 0.5],
  [8.5, 77, 0.5],
  [9, 81, 1],
  [10.5, 79, 0.5],
  [12, 77, 0.5],
  [12.5, 74, 0.5],
  [13, 72, 0.5],
  [14, 77, 2],
];

const cache = new Map<DemoId, RenderedDemo>();

export async function renderDemo(id: DemoId): Promise<RenderedDemo> {
  const hit = cache.get(id);
  if (hit) return hit;
  const built =
    id === "salon"
      ? build({
          bpm: 86,
          bars: 16,
          chords: SALON_CHORDS,
          melody: melody(SALON_MELODY, 16),
          accents: QUARTERS,
          hats: HATS_2,
        })
      : id === "nuit"
        ? build({
            bpm: 102,
            bars: 16,
            chords: NUIT_CHORDS,
            melody: melody(NUIT_MELODY, 16),
            accents: NUIT_ACCENTS,
            hats: HATS_2,
          })
        : build({
            bpm: 118,
            bars: 16,
            chords: CARO_CHORDS,
            melody: melody(CARO_MELODY, 16),
            accents: DANCE,
            hats: HATS_DANCE,
          });
  const samples = await renderEvents(built.events, built.duration);
  const rendered: RenderedDemo = {
    samples,
    sampleRate: SR,
    duration: built.duration,
    bpm: id === "salon" ? 86 : id === "nuit" ? 102 : 118,
    beat: built.beat,
    musicStart: built.musicStart,
    notes: built.notes,
  };
  cache.set(id, rendered);
  return rendered;
}

export function samplesToBuffer(ctx: AudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  if (Math.abs(ctx.sampleRate - sampleRate) < 1) {
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }
  const ratio = ctx.sampleRate / sampleRate;
  const length = Math.max(1, Math.floor(samples.length * ratio));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const out = buffer.getChannelData(0);
  const last = samples.length - 1;
  for (let i = 0; i < length; i++) {
    const src = i / ratio;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const frac = src - i0;
    out[i] = (samples[i0] ?? 0) * (1 - frac) + (samples[i1] ?? 0) * frac;
  }
  return buffer;
}
