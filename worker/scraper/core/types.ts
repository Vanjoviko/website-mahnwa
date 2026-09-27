import type { HttpClient } from "./http.js";

export type SeriesType = "MANHWA" | "MANGA" | "MANHUA" | "ORIGINAL";
export type SeriesStatus = "ONGOING" | "COMPLETED" | "HIATUS";

export interface ScrapedSeries {
  sourceUrl: string;
  title: string;
  coverUrl: string | null;
  synopsis: string;
  genres: string[];
  status: SeriesStatus | null;
  author: string | null;
  type: SeriesType | null;
}

export interface ScrapedChapterRef {
  sourceUrl: string;
  number: number;
  title: string | null;
}

export interface ScrapeContext {
  http: HttpClient;
  log: (level: "info" | "warn" | "error", message: string, url?: string) => void;
}

/** Setiap situs sumber punya satu adapter. Adapter HANYA boleh request lewat ctx.http. */
export interface SourceAdapter {
  id: string;
  parseSeries(ctx: ScrapeContext, url: string): Promise<ScrapedSeries>;
  listChapters(ctx: ScrapeContext, seriesUrl: string): AsyncIterable<ScrapedChapterRef>;
  getChapterImages(ctx: ScrapeContext, chapterUrl: string): Promise<string[]>;
}

export type SourcePermission = "PENDING" | "APPROVED" | "REVOKED" | "DENIED";

/** Nanti menjadi model Prisma `Source`. */
export interface SourceConfig {
  name: string;
  baseUrl: string;
  adapter: string;
  permission: SourcePermission;
  permissionEvidence: string | null;
  minDelayMs: number;
  config: Record<string, unknown>;
}
