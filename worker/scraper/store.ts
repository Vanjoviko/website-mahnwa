import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Penyimpanan sementara berbasis file untuk POC scraper.
 * Di tahap (a)/(f) diganti Prisma (Series, Episode, EpisodePage, ScrapeJob) + storage R2/local.
 */
export const STORAGE_DIR = path.resolve(".storage");
const DB_FILE = path.join(STORAGE_DIR, "db.json");

export interface StoredPage { order: number; key: string; saverKey: string; width: number; height: number }
export interface StoredChapter { id: string; number: number; title: string | null; sourceUrl: string; status: "IN_REVIEW"; pages: StoredPage[] }
export interface StoredSeries {
  id: string; slug: string; title: string; synopsis: string; coverKey: string | null;
  genres: string[]; status: string | null; author: string | null; type: string | null;
  sourceUrl: string; sourceName: string; chapters: StoredChapter[];
}
export interface StoredJob {
  id: string; url: string; mode: string; status: string; progress: number; total: number;
  error: string | null; createdAt: string; completedAt: string | null;
  logs: Array<{ at: string; level: string; message: string; url?: string }>;
  preview?: unknown;
}
interface Db { series: StoredSeries[]; jobs: StoredJob[] }

export async function loadDb(): Promise<Db> {
  try {
    return JSON.parse(await readFile(DB_FILE, "utf8")) as Db;
  } catch {
    return { series: [], jobs: [] };
  }
}

export async function saveDb(db: Db) {
  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

export async function putObject(key: string, data: Buffer) {
  const file = path.join(STORAGE_DIR, "public", key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

export const slugify = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
