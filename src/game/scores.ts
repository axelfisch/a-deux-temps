import type { Difficulty } from "./types";

export type PlayerId = "axel" | "caroline";
export type Mode = "solo" | "ensemble";

export type SavedScore = {
  trackId: string;
  who: PlayerId | "ensemble";
  difficulty: Difficulty;
  score: number;
  stars: number;
  accuracy: number;
  maxCombo: number;
  medal: string;
  at: number;
  leftScore?: number;
  rightScore?: number;
};

export type Settings = {
  scores: SavedScore[];
  recent: SavedScore[];
  offsets: Record<string, number>;
  player: PlayerId;
  mode: Mode;
  names: { axel: string; caroline: string };
  music: number;
  sfx: number;
  hintSeen: boolean;
};

const KEY = "adt-v1";

const DEFAULTS: Settings = {
  scores: [],
  recent: [],
  offsets: {},
  player: "axel",
  mode: "solo",
  names: { axel: "Axel", caroline: "Caroline" },
  music: 0.82,
  sfx: 0.4,
  hintSeen: false,
};

export function emptySettings(): Settings {
  return structuredClone(DEFAULTS);
}

export function loadSettings(): Settings {
  if (typeof localStorage === "undefined") return structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      names: { ...DEFAULTS.names, ...parsed.names },
      offsets: parsed.offsets ?? {},
      scores: parsed.scores ?? [],
      recent: parsed.recent ?? [],
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(next: Settings) {
  localStorage.setItem(KEY, JSON.stringify(next));
}

export function bestScore(
  settings: Settings,
  trackId: string,
  who: SavedScore["who"],
  difficulty: Difficulty,
): SavedScore | undefined {
  return settings.scores.find((s) => s.trackId === trackId && s.who === who && s.difficulty === difficulty);
}

export function rememberScore(settings: Settings, score: SavedScore): Settings {
  const scores = settings.scores.filter(
    (s) => !(s.trackId === score.trackId && s.who === score.who && s.difficulty === score.difficulty),
  );
  const prev = settings.scores.find(
    (s) => s.trackId === score.trackId && s.who === score.who && s.difficulty === score.difficulty,
  );
  if (!prev || score.score >= prev.score) scores.push(score);
  else scores.push(prev);
  const recent = [score, ...settings.recent].slice(0, 8);
  return { ...settings, scores, recent };
}

export function isRecord(settings: Settings, score: SavedScore): boolean {
  const prev = bestScore(settings, score.trackId, score.who, score.difficulty);
  return !prev || score.score > prev.score;
}
