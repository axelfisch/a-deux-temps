import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, Star, Trash2 } from "lucide-react";
import { Stage } from "@/game/Stage";
import { analyzeChannel, bestPhase, buildChart, mixdown } from "@/game/analyze";
import { deleteTrack, listTracks, saveTrack, type StoredTrack } from "@/game/library";
import { DEMOS, renderDemo, samplesToBuffer, type DemoId } from "@/game/music";
import {
  bestScore,
  emptySettings,
  isRecord,
  loadSettings,
  rememberScore,
  saveSettings,
  type PlayerId,
  type SavedScore,
  type Settings,
} from "@/game/scores";
import {
  DIFFICULTIES,
  formatClock,
  formatScore,
  type Difficulty,
  type Note,
  type PlayResult,
  type ReadyTrack,
} from "@/game/types";

type Screen =
  | { k: "home" }
  | { k: "loading"; label: string }
  | { k: "tune"; track: StoredTrack }
  | { k: "play"; ready: ReadyTrack; difficulty: Difficulty; notes: Note[]; take: number }
  | {
      k: "results";
      ready: ReadyTrack;
      difficulty: Difficulty;
      notes: Note[];
      result: PlayResult;
      record: boolean;
      take: number;
    };

function approachFor(d: Difficulty) {
  if (d === "facile") return 1.55;
  if (d === "normal") return 1.32;
  return 1.12;
}

function Stars({ n, size = "size-4" }: { n: number; size?: string }) {
  return (
    <span className="inline-flex text-amber" aria-label={`${n} étoiles sur 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} className={size} fill={i < n ? "currentColor" : "none"} />
      ))}
    </span>
  );
}

function medalLabel(medal: PlayResult["medal"]) {
  if (medal === "diamant") return "Diamant";
  if (medal === "or") return "Or";
  if (medal === "argent") return "Argent";
  return "À retravailler";
}

export function HomeApp() {
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [booted, setBooted] = useState(false);
  const [tracks, setTracks] = useState<StoredTrack[]>([]);
  const [screen, setScreen] = useState<Screen>({ k: "home" });
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const buffers = useRef(new Map<string, AudioBuffer>());

  useEffect(() => {
    setSettings(loadSettings());
    listTracks()
      .then(setTracks)
      .catch(() => setTracks([]))
      .finally(() => setBooted(true));
  }, []);

  function commit(next: Settings) {
    setSettings(next);
    saveSettings(next);
  }

  function ensureCtx() {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error("Audio indisponible sur cet appareil.");
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      ctxRef.current = new Ctx({ latencyHint: "interactive" });
    }
    void ctxRef.current.resume();
    return ctxRef.current;
  }

  async function startDemo(id: DemoId, difficulty: Difficulty) {
    setError(null);
    const ctx = ensureCtx();
    const meta = DEMOS.find((d) => d.id === id);
    setScreen({ k: "loading", label: meta ? `On prépare ${meta.title}…` : "On prépare la piste…" });
    try {
      const rendered = await renderDemo(id);
      if (!meta) return;
      const buffer = samplesToBuffer(ctx, rendered.samples, rendered.sampleRate);
      const ready: ReadyTrack = {
        id,
        title: meta.title,
        blurb: meta.blurb,
        origin: "demo",
        bpm: rendered.bpm,
        duration: buffer.duration,
        beat: rendered.beat,
        musicStart: rendered.musicStart,
        buffer,
        notesFor: (d) => rendered.notes[d],
      };
      setScreen({ k: "play", ready, difficulty, notes: rendered.notes[difficulty], take: 1 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossible de préparer le morceau.");
      setScreen({ k: "home" });
    }
  }

  async function startUpload(track: StoredTrack, difficulty: Difficulty) {
    setError(null);
    const ctx = ensureCtx();
    setScreen({ k: "loading", label: "On cale le rythme…" });
    try {
      let buffer = buffers.current.get(track.id);
      if (!buffer) {
        const copy = (await track.blob.arrayBuffer()).slice(0);
        buffer = await ctx.decodeAudioData(copy);
        buffers.current.set(track.id, buffer);
      }
      const beat = 60 / track.bpm;
      const ready: ReadyTrack = {
        id: track.id,
        title: track.name,
        blurb: "Ton morceau",
        origin: "upload",
        bpm: track.bpm,
        duration: buffer.duration,
        beat,
        musicStart: 0,
        buffer,
        notesFor: (d) =>
          buildChart({
            duration: buffer?.duration ?? track.duration,
            bpm: track.bpm,
            phase: track.phase,
            onsets: track.onsets,
            difficulty: d,
          }),
      };
      const notes = ready.notesFor(difficulty);
      setScreen({ k: "play", ready, difficulty, notes, take: 1 });
    } catch {
      setError("Ce fichier n'a pas pu être relu. Réimporte-le.");
      setScreen({ k: "home" });
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > 25 * 1024 * 1024) {
      setError("Fichier trop lourd. Reste sous 25 Mo.");
      return;
    }
    const ctx = ensureCtx();
    setScreen({ k: "loading", label: "Lecture du morceau…" });
    try {
      const decoded = await ctx.decodeAudioData((await file.arrayBuffer()).slice(0));
      if (decoded.duration > 15 * 60) {
        setError("Garde le morceau sous 15 minutes.");
        setScreen({ k: "home" });
        return;
      }
      if (decoded.duration < 3) {
        setError("Morceau trop court.");
        setScreen({ k: "home" });
        return;
      }
      const analysis = analyzeChannel(mixdown(decoded), decoded.sampleRate);
      const track: StoredTrack = {
        id: crypto.randomUUID(),
        name: file.name
          .replace(/\.[^.]+$/, "")
          .replace(/[_]+/g, " ")
          .slice(0, 64),
        addedAt: Date.now(),
        duration: decoded.duration,
        bpm: analysis.bpm,
        phase: analysis.phase,
        confidence: analysis.confidence,
        onsets: analysis.onsets,
        blob: file,
      };
      buffers.current.set(track.id, decoded);
      try {
        await saveTrack(track);
      } catch {
        setError("Lecture ok, mais l'enregistrement local a échoué. Tu peux jouer maintenant.");
      }
      setTracks((list) => [track, ...list.filter((t) => t.id !== track.id)]);
      setScreen({ k: "tune", track });
    } catch {
      setError("Ce fichier n'a pas pu être lu. Essaie un MP3 ou un M4A.");
      setScreen({ k: "home" });
    }
  }

  async function updateTrack(next: StoredTrack) {
    setTracks((list) => list.map((t) => (t.id === next.id ? next : t)));
    setScreen({ k: "tune", track: next });
    try {
      await saveTrack(next);
    } catch {
      /* keep the in-memory copy */
    }
  }

  function onComplete(result: PlayResult) {
    if (screen.k !== "play") return;
    const who = settings.mode === "ensemble" ? "ensemble" : settings.player;
    const saved: SavedScore = {
      trackId: screen.ready.id,
      who,
      difficulty: screen.difficulty,
      score: result.sides.all.score,
      stars: result.stars,
      accuracy: result.sides.all.accuracy,
      maxCombo: result.sides.all.maxCombo,
      medal: result.medal,
      at: Date.now(),
      leftScore: result.sides.left.score,
      rightScore: result.sides.right.score,
    };
    const record = isRecord(settings, saved);
    commit(rememberScore(settings, saved));
    setScreen({
      k: "results",
      ready: screen.ready,
      difficulty: screen.difficulty,
      notes: screen.notes,
      result,
      record,
      take: screen.take,
    });
  }

  if (screen.k === "play") {
    const ctx = ctxRef.current;
    if (!ctx) return null;
    const offsetMs = settings.offsets[screen.ready.id] ?? 0;
    return (
      <Stage
        key={screen.take}
        audio={ctx}
        buffer={screen.ready.buffer}
        notes={screen.notes}
        offsetSec={offsetMs / 1000}
        approach={approachFor(screen.difficulty)}
        title={screen.ready.title}
        beat={screen.ready.beat}
        musicStart={screen.ready.musicStart}
        difficulty={screen.difficulty}
        mode={settings.mode}
        leftName={settings.names.caroline}
        rightName={settings.names.axel}
        playerName={settings.names[settings.player]}
        musicVolume={settings.music}
        sfxVolume={settings.sfx}
        countIn={screen.ready.origin === "upload"}
        onComplete={onComplete}
        onQuit={() => setScreen({ k: "home" })}
      />
    );
  }

  if (screen.k === "loading") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-6">
        <p className="font-display text-4xl text-fg">{screen.label}</p>
        <p className="mt-3 text-muted">Quelques secondes, le temps d'accorder.</p>
      </main>
    );
  }

  if (screen.k === "results") {
    const { result, ready, difficulty } = screen;
    const other: PlayerId = settings.player === "axel" ? "caroline" : "axel";
    const suggest =
      result.hits >= 8 && Math.abs(result.meanDeltaMs) >= 18 ? Math.round(-result.meanDeltaMs) : 0;
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 py-8">
        <p className="text-sm tracking-wide text-muted">{ready.title}</p>
        <h1 className="mt-2 font-display text-5xl text-fg">
          {formatScore(result.sides.all.score)}
        </h1>
        <div className="mt-3 flex items-center gap-3">
          <Stars n={result.stars} size="size-6" />
          <span className="text-muted">{medalLabel(result.medal)}</span>
        </div>
        {screen.record && <p className="mt-4 text-amber">Nouveau record.</p>}
        <p className="mt-4 text-lg text-fg">
          {Math.round(result.sides.all.accuracy * 100)} % · série {result.sides.all.maxCombo}
        </p>
        <dl className="mt-6 grid grid-cols-2 gap-3">
          {(
            [
              ["Parfait+", result.sides.all.counts["parfait+"]],
              ["Parfait", result.sides.all.counts.parfait],
              ["Bien", result.sides.all.counts.bien],
              ["Raté", result.sides.all.counts.rate],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-line bg-surface px-4 py-3">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="font-display text-3xl">{value}</dd>
            </div>
          ))}
        </dl>
        {result.mode === "ensemble" && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-line bg-surface px-4 py-3">
              <p className="text-sm text-rose">{settings.names.caroline}</p>
              <p className="font-display text-3xl">{formatScore(result.sides.left.score)}</p>
              <p className="text-sm text-muted">{Math.round(result.sides.left.accuracy * 100)} %</p>
            </div>
            <div className="rounded-2xl border border-line bg-surface px-4 py-3">
              <p className="text-sm text-amber">{settings.names.axel}</p>
              <p className="font-display text-3xl">{formatScore(result.sides.right.score)}</p>
              <p className="text-sm text-muted">{Math.round(result.sides.right.accuracy * 100)} %</p>
            </div>
          </div>
        )}
        {suggest !== 0 && (
          <button
            type="button"
            className="mt-6 h-12 rounded-full border border-line text-fg"
            onClick={() => {
              const current = settings.offsets[ready.id] ?? 0;
              const next = Math.max(-200, Math.min(200, current + suggest));
              commit({ ...settings, offsets: { ...settings.offsets, [ready.id]: next } });
            }}
          >
            Ajuster le décalage ({suggest > 0 ? "+" : ""}
            {suggest} ms)
          </button>
        )}
        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            className="h-12 rounded-full bg-amber font-medium text-ink"
            onClick={() =>
              setScreen({
                k: "play",
                ready,
                difficulty,
                notes: ready.notesFor(difficulty),
                take: screen.take + 1,
              })
            }
          >
            Rejouer
          </button>
          {settings.mode === "solo" && (
            <button
              type="button"
              className="h-12 rounded-full border border-line"
              onClick={() => {
                commit({ ...settings, player: other });
                setScreen({
                  k: "play",
                  ready,
                  difficulty,
                  notes: ready.notesFor(difficulty),
                  take: screen.take + 1,
                });
              }}
            >
              Au tour de {settings.names[other]}
            </button>
          )}
          <button type="button" className="h-12 text-muted" onClick={() => setScreen({ k: "home" })}>
            Autre morceau
          </button>
        </div>
      </main>
    );
  }

  if (screen.k === "tune") {
    const track = screen.track;
    const beat = 60 / track.bpm;
    const counts = DIFFICULTIES.map((d) => ({
      ...d,
      n: buildChart({
        duration: track.duration,
        bpm: track.bpm,
        phase: track.phase,
        onsets: track.onsets,
        difficulty: d.id,
      }).length,
    }));
    return (
      <main className="mx-auto min-h-dvh w-full max-w-lg px-5 py-8">
        <button
          type="button"
          className="inline-flex h-11 items-center gap-2 text-muted"
          onClick={() => setScreen({ k: "home" })}
        >
          <ArrowLeft className="size-4" />
          Morceaux
        </button>
        <h1 className="mt-4 font-display text-4xl">{track.name}</h1>
        <p className="mt-2 text-muted">
          {formatClock(track.duration)} · rythme détecté {track.bpm}
          {track.confidence < 0.35 ? " · flou" : ""}
        </p>
        {track.confidence < 0.35 && (
          <p className="mt-3 text-sm text-muted">
            Le tempo est incertain. Règle-le, ou décale d'un demi-temps si les pièces tombent à côté.
          </p>
        )}
        <div className="mt-6 flex items-center justify-between rounded-2xl border border-line bg-surface px-4 py-3">
          <button
            type="button"
            className="size-11 rounded-full border border-line text-lg"
            aria-label="Tempo plus lent"
            onClick={() => {
              const bpm = Math.max(72, track.bpm - 1);
              updateTrack({ ...track, bpm, phase: bestPhase(track.onsets, 60 / bpm) });
            }}
          >
            −
          </button>
          <p className="font-display text-4xl tabular-nums">{track.bpm}</p>
          <button
            type="button"
            className="size-11 rounded-full border border-line text-lg"
            aria-label="Tempo plus vite"
            onClick={() => {
              const bpm = Math.min(176, track.bpm + 1);
              updateTrack({ ...track, bpm, phase: bestPhase(track.onsets, 60 / bpm) });
            }}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="mt-3 h-11 text-sm text-amber"
          onClick={() => updateTrack({ ...track, phase: (track.phase + beat / 2) % beat })}
        >
          Décaler d'un demi-temps
        </button>
        <label className="mt-6 block text-sm text-muted">
          Décalage {settings.offsets[track.id] ?? 0} ms
          <input
            type="range"
            min={-150}
            max={150}
            step={5}
            value={settings.offsets[track.id] ?? 0}
            onChange={(e) =>
              commit({
                ...settings,
                offsets: { ...settings.offsets, [track.id]: Number(e.target.value) },
              })
            }
            className="mt-2 w-full"
          />
        </label>
        <div className="mt-8 flex flex-col gap-3">
          {counts.map((d) => (
            <button
              key={d.id}
              type="button"
              className="flex h-12 items-center justify-between rounded-full bg-amber px-5 font-medium text-ink"
              onClick={() => startUpload(track, d.id)}
            >
              <span>{d.label}</span>
              <span>{d.n} pièces</span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-dvh w-full max-w-lg px-5 py-8">
      <p className="text-sm tracking-widest text-amber">POUR DEUX</p>
      <h1 className="mt-2 font-display text-5xl leading-none text-fg">
        À deux <span className="italic text-amber">temps</span>
      </h1>
      <p className="mt-3 max-w-sm text-muted">
        Tape les pièces au rythme. Trois morceaux maison, ou le tien — il reste sur cet appareil.
      </p>

      {error && (
        <p className="mt-4 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-rose">{error}</p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-2" role="group" aria-label="Qui joue">
        {(["axel", "caroline"] as PlayerId[]).map((id) => {
          const on = settings.player === id && settings.mode === "solo";
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => commit({ ...settings, player: id, mode: "solo" })}
              className={
                "h-12 rounded-full border px-3 font-medium " +
                (on ? "border-amber bg-amber text-ink" : "border-line bg-surface text-fg")
              }
            >
              {settings.names[id]}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-pressed={settings.mode === "ensemble"}
        onClick={() => commit({ ...settings, mode: settings.mode === "ensemble" ? "solo" : "ensemble" })}
        className={
          "mt-2 h-12 w-full rounded-full border font-medium " +
          (settings.mode === "ensemble" ? "border-rose bg-rose text-ink" : "border-line bg-surface text-fg")
        }
      >
        Ensemble — {settings.names.caroline} à gauche, {settings.names.axel} à droite
      </button>

      {booted && !settings.hintSeen && (
        <div className="mt-5 rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-fg">
            Quatre colonnes. Tape quand la pièce traverse le cercle. Sur un trait, garde le doigt jusqu'au bout.
            À deux, chacun prend son côté.
          </p>
          <button
            type="button"
            className="mt-3 h-11 text-sm text-amber"
            onClick={() => commit({ ...settings, hintSeen: true })}
          >
            Compris
          </button>
        </div>
      )}

      <section className="mt-8">
        <h2 className="font-display text-2xl">Morceaux</h2>
        <div className="mt-3 flex flex-col gap-3">
          {DEMOS.map((demo) => (
            <article key={demo.id} className="rounded-2xl border border-line bg-surface p-4">
              <h3 className="font-display text-2xl">{demo.title}</h3>
              <p className="text-sm text-muted">
                {demo.blurb} · {demo.bpm}
              </p>
              <ScoreLine settings={settings} trackId={demo.id} />
              <div className="mt-3 grid grid-cols-3 gap-2">
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="h-11 rounded-full bg-amber text-sm font-medium text-ink"
                    onClick={() => startDemo(demo.id, d.id)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </article>
          ))}

          {tracks.map((track) => (
            <article key={track.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-display text-2xl">{track.name}</h3>
                  <p className="text-sm text-muted">
                    {formatClock(track.duration)} · {track.bpm}
                  </p>
                </div>
                <button
                  type="button"
                  className="flex size-11 items-center justify-center rounded-full border border-line text-muted"
                  aria-label={pendingDelete === track.id ? "Confirmer le retrait" : "Retirer le morceau"}
                  onClick={() => {
                    if (pendingDelete !== track.id) {
                      setPendingDelete(track.id);
                      return;
                    }
                    deleteTrack(track.id).catch(() => undefined);
                    buffers.current.delete(track.id);
                    setTracks((list) => list.filter((t) => t.id !== track.id));
                    setPendingDelete(null);
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              {pendingDelete === track.id && <p className="mt-2 text-sm text-rose">Touche encore pour retirer.</p>}
              <ScoreLine settings={settings} trackId={track.id} />
              <div className="mt-3 grid grid-cols-3 gap-2">
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="h-11 rounded-full border border-line text-sm"
                    onClick={() => startUpload(track, d.id)}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <button type="button" className="mt-2 h-11 text-sm text-amber" onClick={() => setScreen({ k: "tune", track })}>
                Régler le tempo
              </button>
            </article>
          ))}

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex h-24 items-center justify-center gap-2 rounded-2xl border border-dashed border-line text-fg"
          >
            <Plus className="size-5 text-amber" />
            Ajouter un morceau
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void onFile(file);
            }}
          />
        </div>
      </section>

      {settings.recent.length > 0 && (
        <section className="mt-8">
          <h2 className="font-display text-2xl">Dernières parties</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {settings.recent.map((score) => (
              <li key={`${score.trackId}-${score.at}`} className="flex items-center justify-between text-sm">
                <span className="text-muted">
                  {labelFor(score.trackId, tracks)} · {score.difficulty}
                </span>
                <span className="tabular-nums">{formatScore(score.score)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="mt-8">
        <summary className="h-11 cursor-pointer text-muted">Volume et noms</summary>
        <label className="mt-3 block text-sm text-muted">
          Nom de gauche
          <input
            value={settings.names.caroline}
            maxLength={16}
            aria-label="Nom du joueur de gauche"
            onChange={(e) => commit({ ...settings, names: { ...settings.names, caroline: e.target.value || "Caroline" } })}
            className="mt-1 h-12 w-full rounded-2xl border border-line bg-surface px-4 text-fg"
          />
        </label>
        <label className="mt-3 block text-sm text-muted">
          Nom de droite
          <input
            value={settings.names.axel}
            maxLength={16}
            aria-label="Nom du joueur de droite"
            onChange={(e) => commit({ ...settings, names: { ...settings.names, axel: e.target.value || "Axel" } })}
            className="mt-1 h-12 w-full rounded-2xl border border-line bg-surface px-4 text-fg"
          />
        </label>
        <label className="mt-4 block text-sm text-muted">
          Musique {Math.round(settings.music * 100)}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={settings.music}
            onChange={(e) => commit({ ...settings, music: Number(e.target.value) })}
            className="mt-2 w-full"
          />
        </label>
        <label className="mt-3 block text-sm text-muted">
          Bruits {Math.round(settings.sfx * 100)}
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={settings.sfx}
            onChange={(e) => commit({ ...settings, sfx: Number(e.target.value) })}
            className="mt-2 w-full"
          />
        </label>
      </details>
    </main>
  );
}

function labelFor(id: string, tracks: StoredTrack[]) {
  return DEMOS.find((d) => d.id === id)?.title ?? tracks.find((t) => t.id === id)?.name ?? "Morceau";
}

function ScoreLine({ settings, trackId }: { settings: Settings; trackId: string }) {
  const who = settings.mode === "ensemble" ? "ensemble" : settings.player;
  const rows = DIFFICULTIES.map((d) => bestScore(settings, trackId, who, d.id)).filter((s): s is SavedScore => !!s);
  const top = rows.sort((a, b) => b.score - a.score)[0];
  if (!top) return <p className="mt-2 text-sm text-muted">Pas encore joué</p>;
  return (
    <p className="mt-2 flex items-center gap-2 text-sm text-muted">
      <Stars n={top.stars} />
      <span className="tabular-nums text-fg">{formatScore(top.score)}</span>
      <span>{top.difficulty}</span>
    </p>
  );
}
