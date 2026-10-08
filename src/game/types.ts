export type Difficulty = "facile" | "normal" | "difficile";

export type Note = {
  id: number;
  lane: 0 | 1 | 2 | 3;
  time: number;
  duration: number;
};

export type Judgement = "parfait+" | "parfait" | "bien" | "rate";

export type LiveNote = Note & {
  judged: Judgement | null;
  tail: Judgement | null;
  holding: boolean;
  releasedAt: number | null;
};

export type SideId = "all" | "left" | "right";

export type JudgementCounts = Record<Judgement, number>;

export type SideStats = {
  score: number;
  maxCombo: number;
  counts: JudgementCounts;
  accuracy: number;
};

export type PlayResult = {
  mode: "solo" | "ensemble";
  sides: Record<SideId, SideStats>;
  stars: number;
  medal: "aucune" | "argent" | "or" | "diamant";
  meanDeltaMs: number;
  hits: number;
};

export type TrackOrigin = "demo" | "upload";

export type ReadyTrack = {
  id: string;
  title: string;
  blurb: string;
  origin: TrackOrigin;
  bpm: number;
  duration: number;
  beat: number;
  /** Audio-time when the music (not the count-in) starts. */
  musicStart: number;
  buffer: AudioBuffer;
  notesFor: (difficulty: Difficulty) => Note[];
};

export const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: "facile", label: "Facile" },
  { id: "normal", label: "Normal" },
  { id: "difficile", label: "Difficile" },
];

export function emptyCounts(): JudgementCounts {
  return { "parfait+": 0, parfait: 0, bien: 0, rate: 0 };
}

export function accuracyOf(counts: JudgementCounts): number {
  const total =
    counts["parfait+"] + counts.parfait + counts.bien + counts.rate;
  if (total === 0) return 0;
  const weighted =
    counts["parfait+"] * 1 + counts.parfait * 0.86 + counts.bien * 0.5;
  return weighted / total;
}

export function starsFor(accuracy: number, counts: JudgementCounts): number {
  const total = counts["parfait+"] + counts.parfait + counts.bien + counts.rate;
  if (total === 0) return 0;
  if (accuracy >= 0.97) return 5;
  if (accuracy >= 0.9) return 4;
  if (accuracy >= 0.8) return 3;
  if (accuracy >= 0.66) return 2;
  if (accuracy >= 0.48) return 1;
  return 0;
}

export function medalFor(accuracy: number, counts: JudgementCounts): PlayResult["medal"] {
  const total = counts["parfait+"] + counts.parfait + counts.bien + counts.rate;
  if (total > 0 && counts["parfait+"] === total) return "diamant";
  if (accuracy >= 0.97 && counts.rate === 0) return "or";
  if (accuracy >= 0.9) return "argent";
  return "aucune";
}

export function formatScore(n: number): string {
  return new Intl.NumberFormat("fr-CA").format(Math.round(n));
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}
