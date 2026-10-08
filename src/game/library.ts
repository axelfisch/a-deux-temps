export type StoredTrack = {
  id: string;
  name: string;
  addedAt: number;
  duration: number;
  bpm: number;
  phase: number;
  confidence: number;
  onsets: number[];
  blob: Blob;
};

const DB_NAME = "a-deux-temps";
const STORE = "tracks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb"));
  });
}

export async function listTracks(): Promise<StoredTrack[]> {
  const database = await db();
  const rows = await request(database.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return (rows as StoredTrack[]).sort((a, b) => b.addedAt - a.addedAt);
}

export async function saveTrack(track: StoredTrack): Promise<void> {
  const database = await db();
  await request(database.transaction(STORE, "readwrite").objectStore(STORE).put(track));
}

export async function deleteTrack(id: string): Promise<void> {
  const database = await db();
  await request(database.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
}

export async function getTrack(id: string): Promise<StoredTrack | undefined> {
  const database = await db();
  const row = await request(database.transaction(STORE, "readonly").objectStore(STORE).get(id));
  return row as StoredTrack | undefined;
}
