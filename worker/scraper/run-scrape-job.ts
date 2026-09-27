import { createHash, randomUUID } from "node:crypto";
import { BlockedError, PermissionError } from "./core/errors.js";
import { HttpClient } from "./core/http.js";
import type { ScrapeContext, ScrapedChapterRef, ScrapedSeries, SourceConfig } from "./core/types.js";
import { processCover, processPageImage } from "./pipeline/images.js";
import { resolveAdapter } from "./registry.js";
import { loadDb, putObject, saveDb, slugify, type StoredJob, type StoredSeries } from "./store.js";

export const USER_AGENT = "MahnwaBot/0.1 (+https://example.com/bot)";

export interface Preview {
  series: ScrapedSeries;
  chapters: Array<ScrapedChapterRef & { alreadyImported: boolean }>;
}

function assertPermitted(source: SourceConfig) {
  if (source.permission !== "APPROVED") {
    throw new PermissionError(`Source "${source.name}" berstatus ${source.permission}; impor hanya untuk APPROVED`);
  }
  if (!source.permissionEvidence) {
    throw new PermissionError(`Source "${source.name}" belum punya bukti izin (permissionEvidence)`);
  }
}

function createJob(url: string, mode: string): StoredJob {
  return { id: randomUUID(), url, mode, status: "RUNNING", progress: 0, total: 0, error: null,
    createdAt: new Date().toISOString(), completedAt: null, logs: [] };
}

function makeCtx(job: StoredJob, source: SourceConfig): ScrapeContext {
  const log: ScrapeContext["log"] = (level, message, url) => {
    job.logs.push({ at: new Date().toISOString(), level, message, url });
    console.log(`  [${level}] ${message}${url ? ` — ${url}` : ""}`);
  };
  const http = new HttpClient({ userAgent: USER_AGENT, minDelayMs: source.minDelayMs, onLog: (m) => log("warn", m) });
  return { http, log };
}

async function finish(job: StoredJob, err?: unknown) {
  if (err instanceof BlockedError) {
    job.status = "BLOCKED";
    job.error = `${err.message} (${err.url}) — scraping dihentikan, tidak ada upaya bypass`;
  } else if (err) {
    job.status = "FAILED";
    job.error = (err as Error).message;
  } else if (job.status === "RUNNING") {
    job.status = "COMPLETED";
  }
  job.completedAt = new Date().toISOString();
  const db = await loadDb();
  db.jobs.push(job);
  await saveDb(db);
  return job;
}

/** Tahap 1: ambil metadata + daftar chapter, TANPA menyimpan apa pun ke katalog. */
export async function previewJob(source: SourceConfig, url: string) {
  const job = createJob(url, "PREVIEW");
  try {
    assertPermitted(source);
    const adapter = resolveAdapter(source);
    const ctx = makeCtx(job, source);
    ctx.log("info", `Adapter: ${adapter.id}`);
    const series = await adapter.parseSeries(ctx, url);
    ctx.log("info", `Series: "${series.title}"`);

    const db = await loadDb();
    const existing = db.series.find((s) => s.sourceUrl === url);
    const chapters: Preview["chapters"] = [];
    for await (const ch of adapter.listChapters(ctx, url)) {
      chapters.push({ ...ch, alreadyImported: !!existing?.chapters.some((c) => c.number === ch.number || c.sourceUrl === ch.sourceUrl) });
    }
    chapters.sort((a, b) => a.number - b.number);
    ctx.log("info", `${chapters.length} chapter ditemukan (${chapters.filter((c) => c.alreadyImported).length} sudah ada)`);
    job.preview = { series, chapters } satisfies Preview;
    job.status = "PREVIEW_READY";
    return { job: await finish(job), preview: job.preview as Preview };
  } catch (err) {
    return { job: await finish(job, err), preview: null };
  }
}

/** Tahap 2: impor chapter yang dipilih admin dari hasil preview. */
export async function importJob(source: SourceConfig, preview: Preview, chapterNumbers: number[]) {
  const job = createJob(preview.series.sourceUrl, `CHAPTERS:${chapterNumbers.join(",")}`);
  try {
    assertPermitted(source);
    const adapter = resolveAdapter(source);
    const ctx = makeCtx(job, source);
    const db = await loadDb();

    let series: StoredSeries | undefined = db.series.find((s) => s.sourceUrl === preview.series.sourceUrl);
    if (!series) {
      const p = preview.series;
      series = { id: randomUUID(), slug: slugify(p.title), title: p.title, synopsis: p.synopsis, coverKey: null,
        genres: p.genres, status: p.status, author: p.author, type: p.type, sourceUrl: p.sourceUrl,
        sourceName: source.name, chapters: [] };
      if (p.coverUrl) {
        series.coverKey = `series/${series.id}/cover.webp`;
        await putObject(series.coverKey, await processCover(await ctx.http.getBuffer(p.coverUrl)));
      }
      db.series.push(series);
      ctx.log("info", `Series baru dibuat: /series/${series.slug}`);
    }

    const selected = preview.chapters.filter((c) => chapterNumbers.includes(c.number));
    job.total = selected.length;
    for (const ref of selected) {
      if (series.chapters.some((c) => c.number === ref.number || c.sourceUrl === ref.sourceUrl)) {
        ctx.log("info", `Chapter ${ref.number} sudah ada — dilewati (duplicate)`);
        job.progress++;
        continue;
      }
      const imageUrls = await adapter.getChapterImages(ctx, ref.sourceUrl);
      if (imageUrls.length === 0) throw new Error(`Chapter ${ref.number}: tidak ada gambar ditemukan`);
      ctx.log("info", `Chapter ${ref.number}: ${imageUrls.length} gambar sumber`);

      const chapterId = randomUUID();
      const pages: StoredSeries["chapters"][number]["pages"] = [];
      const seenHashes = new Set<string>();
      for (const [i, imgUrl] of imageUrls.entries()) {
        const raw = await ctx.http.getBuffer(imgUrl);
        const hash = createHash("sha1").update(raw).digest("hex");
        if (seenHashes.has(hash)) { ctx.log("warn", `Gambar duplikat dilewati`, imgUrl); continue; }
        seenHashes.add(hash);
        for (const slice of await processPageImage(raw)) {
          const order = pages.length + 1;
          const base = `series/${series.id}/ch/${chapterId}/${String(order).padStart(3, "0")}`;
          await putObject(`${base}.webp`, slice.standard);
          await putObject(`${base}.saver.webp`, slice.saver);
          pages.push({ order, key: `${base}.webp`, saverKey: `${base}.saver.webp`, width: slice.width, height: slice.height });
        }
        ctx.log("info", `  gambar ${i + 1}/${imageUrls.length} → total ${pages.length} potongan`);
      }
      series.chapters.push({ id: chapterId, number: ref.number, title: ref.title, sourceUrl: ref.sourceUrl, status: "IN_REVIEW", pages });
      job.progress++;
      ctx.log("info", `Chapter ${ref.number} selesai: ${pages.length} halaman → antrian moderasi (IN_REVIEW)`);
    }
    await saveDb(db);
    return { job: await finish(job), series };
  } catch (err) {
    return { job: await finish(job, err), series: null };
  }
}
