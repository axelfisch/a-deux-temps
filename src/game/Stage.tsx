import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { SongClock } from "./clock";
import type { Difficulty, Judgement, JudgementCounts, LiveNote, Note, PlayResult, SideId } from "./types";
import { accuracyOf, emptyCounts, medalFor, starsFor } from "./types";

type Props = {
  audio: AudioContext;
  buffer: AudioBuffer;
  notes: Note[];
  offsetSec: number;
  approach: number;
  title: string;
  beat: number;
  musicStart: number;
  difficulty: Difficulty;
  mode: "solo" | "ensemble";
  leftName: string;
  rightName: string;
  playerName: string;
  musicVolume: number;
  sfxVolume: number;
  countIn: boolean;
  onComplete: (result: PlayResult) => void;
  onQuit: () => void;
};

type Particle = { x: number; y: number; vx: number; vy: number; life: number; r: number; color: string };

type Palette = {
  bg: string;
  amber: string;
  amber2: string;
  rose: string;
  ivory: string;
  muted: string;
  line: string;
};

const POINTS: Record<Judgement, number> = {
  "parfait+": 1000,
  parfait: 700,
  bien: 320,
  rate: 0,
};

function windows(d: Difficulty) {
  if (d === "facile") return { pp: 0.055, p: 0.1, g: 0.16 };
  if (d === "normal") return { pp: 0.046, p: 0.086, g: 0.14 };
  return { pp: 0.038, p: 0.072, g: 0.118 };
}

function curve(v: number) {
  return Math.max(0, Math.min(1, v)) ** 2;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: pick("--color-bg", "#100e0c"),
    amber: pick("--color-amber", "#e8a45a"),
    amber2: pick("--color-amber-2", "#f3c98a"),
    rose: pick("--color-rose", "#d4726a"),
    ivory: pick("--color-fg", "#f4ecdf"),
    muted: pick("--color-muted", "#b3a394"),
    line: pick("--color-line", "#3a322a"),
  };
}

function makeSfx(ctx: AudioContext, freq: number, dur: number, noise: number) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    ph += (2 * Math.PI * freq) / ctx.sampleRate;
    const env = Math.exp(-i / (ctx.sampleRate * dur * 0.42));
    const nz = Math.random() * 2 - 1;
    data[i] = (Math.sin(ph) * (1 - noise) + nz * noise) * env * 0.55;
  }
  return buffer;
}

function playSfx(ctx: AudioContext, bus: GainNode, buffer: AudioBuffer, gain: number) {
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  src.buffer = buffer;
  src.playbackRate.value = 1 + (Math.random() - 0.5) * 0.04;
  g.gain.value = gain;
  src.connect(g);
  g.connect(bus);
  src.start();
  src.onended = () => {
    src.disconnect();
    g.disconnect();
  };
}

function countdownAt(audioTime: number, musicStart: number, beat: number): number | null {
  if (beat <= 0) return null;
  const beatsLeft = (musicStart - audioTime) / beat;
  if (beatsLeft > 4.08 || beatsLeft <= 0.04) return null;
  return Math.min(4, Math.max(1, Math.ceil(beatsLeft - 0.001)));
}

export function Stage(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [paused, setPaused] = useState(false);
  const [hud, setHud] = useState({
    score: 0,
    combo: 0,
    elan: false,
    left: 0,
    right: 0,
    leftCombo: 0,
    rightCombo: 0,
    countdown: null as number | null,
    judge: null as { text: string; tone: "good" | "bad"; id: number } | null,
    progress: 0,
    teach: true,
  });

  useEffect(() => {
    const canvasNode = canvasRef.current;
    if (!canvasNode) return;
    const context = canvasNode.getContext("2d");
    if (!context) return;
    const canvas: HTMLCanvasElement = canvasNode;
    const ctx2d: CanvasRenderingContext2D = context;

    const audio = props.buffer;
    const actx = props.audio;
    void actx.resume();
    const master = actx.createGain();
    const music = actx.createGain();
    const sfx = actx.createGain();
    music.connect(master);
    sfx.connect(master);
    master.connect(actx.destination);
    music.gain.value = curve(props.musicVolume);
    sfx.gain.value = curve(props.sfxVolume) * 0.7;
    master.gain.value = 1;

    const playBuffer = audio;
    const clock = new SongClock(actx, playBuffer, music);
    clock.setOffset(props.offsetSec);
    const beat = props.beat;
    const intro = props.countIn ? 4 * beat : 0.02;
    const from = props.countIn ? -intro : -0.02;
    clock.start(from);

    const clicks = [0, 1, 2, 3].map((i) => makeSfx(actx, i === 3 ? 988 : 740, 0.09, 0.25));
    const sfxBank = {
      "parfait+": makeSfx(actx, 880, 0.09, 0.05),
      parfait: makeSfx(actx, 660, 0.07, 0.04),
      bien: makeSfx(actx, 392, 0.07, 0.08),
      rate: makeSfx(actx, 96, 0.14, 0.65),
    };
    const oneShots: AudioBufferSourceNode[] = [];
    if (props.countIn) {
      for (let i = 0; i < 4; i++) {
        const when = Math.max(actx.currentTime, clock.ctxTimeForAudio(-intro + i * beat));
        const src = actx.createBufferSource();
        const g = actx.createGain();
        const buf = clicks[i];
        if (!buf) continue;
        src.buffer = buf;
        g.gain.value = curve(props.sfxVolume) * (i === 3 ? 0.55 : 0.4);
        src.connect(g);
        g.connect(sfx);
        src.start(when);
        oneShots.push(src);
      }
    }

    const notes: LiveNote[] = props.notes.map((n) => ({
      ...n,
      judged: null,
      tail: null,
      holding: false,
      releasedAt: null,
    }));
    const win = windows(props.difficulty);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const palette = readPalette();
    const particles: Particle[] = [];
    const laneFlash = [0, 0, 0, 0];
    const holds = new Map<number, number>();
    const combo = { all: 0, left: 0, right: 0 };
    const maxCombo = { all: 0, left: 0, right: 0 };
    const score = { all: 0, left: 0, right: 0 };
    const counts: Record<SideId, JudgementCounts> = {
      all: emptyCounts(),
      left: emptyCounts(),
      right: emptyCounts(),
    };
    const elan = { all: false, left: false, right: false };
    const deltas: number[] = [];
    let finished = false;
    let judgeId = 0;
    let lastHud = 0;
    let teach = true;
    let shake = 0;
    let lastMusic = props.musicVolume;
    let lastSfx = props.sfxVolume;
    let raf = 0;
    let cssW = 1;
    let cssH = 1;

    const spawn = () => cssH * 0.11;
    const hitY = () => cssH * 0.78;

    function trap(y: number) {
      const s = spawn();
      const h = hitY();
      let t = (y - s) / Math.max(1, h - s);
      if (y >= h) t = 1;
      if (y <= s) t = 0;
      t = Math.max(0, Math.min(1, t));
      const span = cssW * (0.44 + 0.48 * t);
      const left = (cssW - span) / 2;
      return { left, span, laneW: span / 4, t };
    }

    function yFor(time: number, sync: number) {
      const remain = time - sync;
      const t = 1 - remain / propsRef.current.approach;
      return spawn() + t * (hitY() - spawn());
    }

    function laneAt(x: number, y: number) {
      const g = trap(y);
      if (x < g.left || x >= g.left + g.span) return -1;
      return Math.max(0, Math.min(3, Math.floor((x - g.left) / g.laneW))) as 0 | 1 | 2 | 3;
    }

    function burst(x: number, y: number, color: string, n: number) {
      if (reduce) return;
      for (let i = 0; i < n; i++) {
        const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
        const sp = 40 + Math.random() * 90;
        particles.push({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 20,
          life: 1,
          r: 2 + Math.random() * 3,
          color,
        });
      }
    }

    function award(lane: number, j: Judgement, delta: number | null, weight: number) {
      const sides: SideId[] = propsRef.current.mode === "solo" ? ["all"] : [lane < 2 ? "left" : "right", "all"];
      for (const s of sides) {
        counts[s][j] += 1;
        if (j === "rate") {
          combo[s] = 0;
          elan[s] = false;
        } else {
          combo[s] += 1;
          if (combo[s] > maxCombo[s]) maxCombo[s] = combo[s];
          if (combo[s] >= 16) elan[s] = true;
          const mult = 1 + Math.min(combo[s], 80) / 80;
          const boost = elan[s] ? 1.35 : 1;
          score[s] += Math.round(POINTS[j] * mult * boost * weight);
        }
      }
      if (delta != null && j !== "rate") deltas.push(delta);
    }

    function flashJudge(j: Judgement) {
      judgeId += 1;
      const good = j !== "rate";
      setHud((h) => ({
        ...h,
        judge: {
          id: judgeId,
          text: j === "parfait+" ? "Parfait+" : j === "parfait" ? "Parfait" : j === "bien" ? "Bien" : "Raté",
          tone: good ? "good" : "bad",
        },
        teach: false,
      }));
      teach = false;
      if (!good) shake = 1;
    }

    function playJudge(j: Judgement) {
      const buf = sfxBank[j];
      const vol = curve(propsRef.current.sfxVolume);
      if (buf && vol > 0.001) playSfx(actx, sfx, buf, j === "rate" ? 0.35 : 0.55);
    }

    function tryHit(lane: 0 | 1 | 2 | 3, pointerId: number) {
      if (finished || clock.audioTime() < -0.05 && !propsRef.current.countIn) return;
      const now = clock.syncTime();
      let best: LiveNote | null = null;
      let bestAbs = 99;
      for (const n of notes) {
        if (n.lane !== lane || n.judged) continue;
        const delta = now - n.time;
        if (delta < -win.g || delta > win.g) continue;
        const a = Math.abs(delta);
        if (a < bestAbs) {
          best = n;
          bestAbs = a;
        }
      }
      if (!best) return;
      const delta = now - best.time;
      const ad = Math.abs(delta);
      const j: Judgement = ad <= win.pp ? "parfait+" : ad <= win.p ? "parfait" : "bien";
      best.judged = j;
      if (j === "rate") best.tail = "rate";
      else if (best.duration > 0) {
        best.holding = true;
        holds.set(pointerId, best.id);
      }
      award(lane, j, delta, 1);
      laneFlash[lane] = 1;
      flashJudge(j);
      playJudge(j);
      if (j === "parfait+" || j === "parfait") {
        const yy = yFor(best.time, now);
        const g = trap(yy);
        burst(g.left + g.laneW * (lane + 0.5), hitY(), j === "parfait+" ? palette.amber2 : palette.ivory, j === "parfait+" ? 10 : 5);
      }
    }

    function release(pointerId: number) {
      const id = holds.get(pointerId);
      holds.delete(pointerId);
      if (id == null) return;
      const note = notes.find((n) => n.id === id);
      if (!note || !note.holding) return;
      note.holding = false;
      note.releasedAt = clock.syncTime();
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function onPointerDown(e: PointerEvent) {
      if (pausedRef) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const lane = laneAt(e.clientX - rect.left, e.clientY - rect.top);
      if (lane < 0) return;
      const laneId = lane as 0 | 1 | 2 | 3;
      canvas.setPointerCapture(e.pointerId);
      tryHit(laneId, e.pointerId);
    }
    function onPointerUp(e: PointerEvent) {
      release(e.pointerId);
    }
    let pausedRef = false;

    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePause();
        return;
      }
      const idx = ["KeyD", "KeyF", "KeyJ", "KeyK"].indexOf(e.code);
      if (idx < 0 || pausedRef) return;
      e.preventDefault();
      tryHit(idx as 0 | 1 | 2 | 3, -1 - idx);
    }
    function onKeyUp(e: KeyboardEvent) {
      const idx = ["KeyD", "KeyF", "KeyJ", "KeyK"].indexOf(e.code);
      if (idx >= 0) release(-1 - idx);
    }

    function togglePause() {
      if (finished) return;
      pausedRef = !pausedRef;
      if (pausedRef) clock.pause();
      else {
        void actx.resume();
        clock.resume();
      }
      setPaused(pausedRef);
    }
    (canvas as HTMLCanvasElement & { __toggle?: () => void }).__toggle = togglePause;

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function onVis() {
      if (document.hidden && !pausedRef && !finished) togglePause();
    }
    document.addEventListener("visibilitychange", onVis);

    let last = performance.now();

    function frame(t: number) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      const p = propsRef.current;
      if (p.musicVolume !== lastMusic) {
        lastMusic = p.musicVolume;
        music.gain.setTargetAtTime(curve(lastMusic), actx.currentTime, 0.04);
      }
      if (p.sfxVolume !== lastSfx) {
        lastSfx = p.sfxVolume;
        sfx.gain.setTargetAtTime(curve(lastSfx) * 0.7, actx.currentTime, 0.04);
      }

      const sync = clock.syncTime();
      const audioT = clock.audioTime();
      if (!finished && clock.playing) {
        for (const n of notes) {
          if (!n.judged && sync > n.time + win.g) {
            n.judged = "rate";
            if (n.duration > 0) n.tail = "rate";
            award(n.lane, "rate", null, 1);
            flashJudge("rate");
            playJudge("rate");
          }
          if (n.judged && n.judged !== "rate" && n.duration > 0 && !n.tail) {
            const end = n.time + n.duration;
            if (n.holding && sync >= end) {
              const tj: Judgement = n.judged === "parfait+" ? "parfait+" : "parfait";
              n.tail = tj;
              n.holding = false;
              award(n.lane, tj, null, 0.65);
            } else if (!n.holding && n.releasedAt != null) {
              const early = end - n.releasedAt;
              const tj: Judgement = early > 0.18 ? "rate" : early > 0.09 ? "bien" : "parfait";
              n.tail = tj;
              award(n.lane, tj, null, 0.65);
              if (tj === "rate") flashJudge("rate");
            } else if (!n.holding && sync > end + 0.14) {
              n.tail = "rate";
              award(n.lane, "rate", null, 0.65);
              flashJudge("rate");
            }
          }
        }
        if (audioT > playBuffer.duration + 0.2) finish();
      }

      shake = Math.max(0, shake - dt * 3);
      for (let i = 0; i < 4; i++) laneFlash[i] = Math.max(0, (laneFlash[i] ?? 0) - dt * 2.4);
      for (let i = particles.length - 1; i >= 0; i--) {
        const ptl = particles[i];
        if (!ptl) continue;
        ptl.life -= dt * 1.6;
        ptl.x += ptl.vx * dt;
        ptl.y += ptl.vy * dt;
        if (ptl.life <= 0) particles.splice(i, 1);
      }

      const ox = (Math.random() - 0.5) * shake * 5;
      draw(sync, ox);

      if (t - lastHud > 80) {
        lastHud = t;
        const count = countdownAt(audioT, p.musicStart, p.beat);
        const comboShown = p.mode === "solo" ? combo.all : Math.max(combo.left, combo.right);
        const elanOn = p.mode === "solo" ? elan.all : elan.left || elan.right;
        setHud((h) => ({
          ...h,
          score: score.all,
          combo: comboShown,
          elan: elanOn,
          left: score.left,
          right: score.right,
          leftCombo: combo.left,
          rightCombo: combo.right,
          countdown: count,
          progress: Math.max(0, Math.min(1, audioT / playBuffer.duration)),
          teach,
        }));
      }
    }

    function finish() {
      if (finished) return;
      finished = true;
      clock.stop();
      const mean = deltas.length ? (deltas.reduce((a, b) => a + b, 0) / deltas.length) * 1000 : 0;
      const acc = accuracyOf(counts.all);
      const result: PlayResult = {
        mode: propsRef.current.mode,
        sides: {
          all: { score: score.all, maxCombo: maxCombo.all, counts: counts.all, accuracy: acc },
          left: {
            score: score.left,
            maxCombo: maxCombo.left,
            counts: counts.left,
            accuracy: accuracyOf(counts.left),
          },
          right: {
            score: score.right,
            maxCombo: maxCombo.right,
            counts: counts.right,
            accuracy: accuracyOf(counts.right),
          },
        },
        stars: starsFor(acc, counts.all),
        medal: medalFor(acc, counts.all),
        meanDeltaMs: mean,
        hits: deltas.length,
      };
      propsRef.current.onComplete(result);
    }

    function draw(sync: number, ox: number) {
      const w = cssW;
      const h = cssH;
      ctx2d.clearRect(0, 0, w, h);
      ctx2d.fillStyle = palette.bg;
      ctx2d.fillRect(0, 0, w, h);
      const glowL = ctx2d.createRadialGradient(w * 0.3, h * 0.2, 10, w * 0.3, h * 0.15, w * 0.7);
      glowL.addColorStop(0, "rgba(232,164,90,0.16)");
      glowL.addColorStop(1, "rgba(232,164,90,0)");
      ctx2d.fillStyle = glowL;
      ctx2d.fillRect(0, 0, w, h);
      const glowR = ctx2d.createRadialGradient(w * 0.75, h * 0.85, 8, w * 0.75, h * 0.9, w * 0.55);
      glowR.addColorStop(0, "rgba(212,114,106,0.1)");
      glowR.addColorStop(1, "rgba(212,114,106,0)");
      ctx2d.fillStyle = glowR;
      ctx2d.fillRect(0, 0, w, h);

      ctx2d.save();
      ctx2d.translate(ox, 0);
      const top = trap(spawn());
      const bot = trap(hitY());
      ctx2d.beginPath();
      ctx2d.moveTo(top.left, spawn());
      ctx2d.lineTo(top.left + top.span, spawn());
      ctx2d.lineTo(bot.left + bot.span, hitY() + (h - hitY()) * 0.72);
      ctx2d.lineTo(bot.left, hitY() + (h - hitY()) * 0.72);
      ctx2d.closePath();
      ctx2d.fillStyle = "rgba(244,236,223,0.035)";
      ctx2d.fill();

      for (let lane = 0; lane < 4; lane++) {
        const flash = laneFlash[lane] ?? 0;
        ctx2d.beginPath();
        const y0 = spawn();
        const y1 = hitY() + (h - hitY()) * 0.72;
        const a = trap(y0);
        const b = trap(y1);
        ctx2d.moveTo(a.left + a.laneW * lane, y0);
        ctx2d.lineTo(a.left + a.laneW * (lane + 1), y0);
        ctx2d.lineTo(b.left + b.laneW * (lane + 1), y1);
        ctx2d.lineTo(b.left + b.laneW * lane, y1);
        ctx2d.closePath();
        ctx2d.fillStyle = flash > 0 ? `rgba(232,164,90,${0.18 * flash})` : "rgba(244,236,223,0.015)";
        ctx2d.fill();
      }

      ctx2d.strokeStyle = "rgba(243,201,138,0.28)";
      ctx2d.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const a = trap(spawn());
        const b = trap(h);
        ctx2d.beginPath();
        ctx2d.moveTo(a.left + a.laneW * i, spawn());
        ctx2d.lineTo(b.left + b.laneW * i, h);
        ctx2d.stroke();
      }

      const ordered = [...notes].sort((a, b) => b.time - a.time);
      for (const n of ordered) {
        if (n.judged === "rate" || n.tail) continue;
        if (n.judged && n.duration <= 0) continue;
        const headY = yFor(n.time, sync);
        if (headY > h + 40) continue;
        const tailTime = n.time + n.duration;
        const tailY = n.duration > 0 ? yFor(tailTime, sync) : headY;
        if (tailY > h + 20 && headY > h + 20) continue;
        if (headY < -80 && tailY < -80) continue;
        const g = trap(Math.min(h, Math.max(0, headY)));
        const x = g.left + g.laneW * (n.lane + 0.5);
        const r = Math.max(11, g.laneW * 0.3);
        if (n.duration > 0 && !n.tail) {
          const gt = trap(Math.min(h, Math.max(0, tailY)));
          const xt = gt.left + gt.laneW * (n.lane + 0.5);
          ctx2d.beginPath();
          ctx2d.moveTo(x - r * 0.42, headY);
          ctx2d.lineTo(xt - r * 0.28, tailY);
          ctx2d.lineTo(xt + r * 0.28, tailY);
          ctx2d.lineTo(x + r * 0.42, headY);
          ctx2d.closePath();
          ctx2d.fillStyle = n.holding ? "rgba(232,164,90,0.78)" : "rgba(212,114,106,0.72)";
          ctx2d.fill();
        }
        if (!n.judged || n.duration > 0) {
          ctx2d.beginPath();
            ctx2d.arc(x, headY, r, 0, Math.PI * 2);
            ctx2d.fillStyle = n.duration > 0 ? palette.rose : palette.amber;
            ctx2d.fill();
            ctx2d.lineWidth = Math.max(2, r * 0.1);
            ctx2d.strokeStyle = palette.ivory;
            ctx2d.stroke();
            ctx2d.beginPath();
            ctx2d.ellipse(x - r * 0.15, headY - r * 0.22, r * 0.36, r * 0.2, -0.4, 0, Math.PI * 2);
            ctx2d.fillStyle = "rgba(244,236,223,0.42)";
            ctx2d.fill();
        }
      }

      const hy = hitY();
      const hb = trap(hy);
      ctx2d.strokeStyle = palette.amber;
      ctx2d.globalAlpha = 0.85;
      ctx2d.lineWidth = 3;
      ctx2d.beginPath();
      ctx2d.moveTo(hb.left, hy);
      ctx2d.lineTo(hb.left + hb.span, hy);
      ctx2d.stroke();
      ctx2d.globalAlpha = 1;
      for (let lane = 0; lane < 4; lane++) {
        const x = hb.left + hb.laneW * (lane + 0.5);
        const r = Math.max(16, hb.laneW * 0.32);
        const flash = laneFlash[lane] ?? 0;
        ctx2d.beginPath();
        ctx2d.arc(x, hy, r, 0, Math.PI * 2);
        ctx2d.strokeStyle = flash > 0.2 ? palette.amber2 : "rgba(244,236,223,0.75)";
        ctx2d.lineWidth = 3;
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.arc(x, hy, r * 0.45, 0, Math.PI * 2);
        ctx2d.strokeStyle = "rgba(244,236,223,0.35)";
        ctx2d.lineWidth = 2;
        ctx2d.stroke();
      }

      for (const ptl of particles) {
        ctx2d.globalAlpha = Math.max(0, ptl.life);
        ctx2d.fillStyle = ptl.color;
        ctx2d.beginPath();
        ctx2d.arc(ptl.x, ptl.y, ptl.r, 0, Math.PI * 2);
        ctx2d.fill();
      }
      ctx2d.globalAlpha = 1;
      ctx2d.restore();
    }

    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("visibilitychange", onVis);
      for (const src of oneShots) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      clock.stop();
      try {
        master.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    // The buffer and chart identity start a fresh take. Live knobs go through propsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.buffer, props.notes, props.difficulty, props.mode, props.offsetSec]);

  function toggleFromButton() {
    const canvas = canvasRef.current as (HTMLCanvasElement & { __toggle?: () => void }) | null;
    canvas?.__toggle?.();
  }

  const ensemble = props.mode === "ensemble";

  return (
    <div ref={wrapRef} className="relative h-dvh w-full overflow-hidden bg-bg text-fg">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
      <div className="pointer-events-none absolute inset-0 flex flex-col">
        <header className="pointer-events-auto flex items-center gap-3 px-4 pt-4">
          <button
            type="button"
            onClick={toggleFromButton}
            className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-fg"
            aria-label={paused ? "Reprendre" : "Pause"}
          >
            {paused ? <Play className="size-5" /> : <Pause className="size-5" />}
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-lg leading-tight">{props.title}</p>
            <p className="text-sm text-muted">{ensemble ? "Ensemble" : props.playerName}</p>
          </div>
          <p className="font-display text-2xl tabular-nums">{new Intl.NumberFormat("fr-CA").format(hud.score)}</p>
        </header>
        <div className="mx-4 mt-3 h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full bg-amber" style={{ width: `${hud.progress * 100}%` }} />
        </div>
        <div className="mt-6 flex flex-1 flex-col items-center">
          {hud.countdown != null && (
            <p className="font-display text-7xl text-amber-2">{hud.countdown}</p>
          )}
          {hud.judge && (
            <p
              key={hud.judge.id}
              className={
                "font-display text-4xl " + (hud.judge.tone === "good" ? "text-amber-2" : "text-rose")
              }
            >
              {hud.judge.text}
            </p>
          )}
          {hud.combo > 1 && (
            <p className="mt-2 text-sm tracking-wide text-muted">
              {hud.combo} d'affilée{hud.elan ? " · élan" : ""}
            </p>
          )}
          {hud.teach && hud.countdown == null && (
            <p className="mt-8 max-w-xs px-6 text-center text-sm text-muted">
              Tape quand la pièce traverse le cercle. Tiens le doigt sur les traits.
            </p>
          )}
        </div>
        <footer className="pointer-events-none flex items-end justify-between px-5 pb-6">
          {ensemble ? (
            <>
              <p className="text-sm text-rose">
                {props.leftName}
                <span className="mt-1 block font-display text-2xl tabular-nums text-fg">
                  {new Intl.NumberFormat("fr-CA").format(hud.left)}
                </span>
              </p>
              <p className="hidden pb-2 text-sm text-muted sm:block">D F J K</p>
              <p className="text-right text-sm text-amber">
                {props.rightName}
                <span className="mt-1 block font-display text-2xl tabular-nums text-fg">
                  {new Intl.NumberFormat("fr-CA").format(hud.right)}
                </span>
              </p>
            </>
          ) : (
            <p className="ml-auto hidden pb-2 text-sm text-muted sm:block">D F J K</p>
          )}
        </footer>
      </div>
      {paused && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg/80 px-6">
          <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6">
            <h2 className="font-display text-3xl">Pause</h2>
            <div className="mt-6 flex flex-col gap-3">
              <button
                type="button"
                onClick={toggleFromButton}
                className="h-12 rounded-full bg-amber text-base font-medium text-ink"
              >
                Reprendre
              </button>
              <button
                type="button"
                onClick={props.onQuit}
                className="h-12 rounded-full border border-line text-base text-fg"
              >
                Quitter la piste
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
