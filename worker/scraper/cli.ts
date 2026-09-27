/**
 * CLI POC scraper (sebelum ada panel admin).
 *
 *   npm run scrape -- demo                      # jalankan mock site + preview + impor chapter 1 + uji blokir
 *   npm run scrape -- preview <url>
 *   npm run scrape -- import <url> --chapters 1,2
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenericSelectorConfig } from "./adapters/generic-selector.js";
import type { SourceConfig } from "./core/types.js";
import { MOCK_PORT, startMockSite } from "./mock-site/server.js";
import { importJob, previewJob, type Preview } from "./run-scrape-job.js";
import { STORAGE_DIR, type StoredSeries } from "./store.js";

const MOCK_SELECTORS: GenericSelectorConfig = {
  series: {
    title: "h1.entry-title",
    cover: ".thumb img",
    synopsis: ".synopsis",
    genres: ".genres a",
    status: ".status",
    author: ".author",
    type: ".type",
  },
  chapterList: { item: ".chapter-list .chapter-item", link: "a", nextPage: "a.next-page" },
  chapterImages: { img: "#reader img.page-img" },
};

/** Nanti berasal dari tabel `Source` yang dikelola admin. */
const SOURCES: SourceConfig[] = [
  {
    name: "Mock Komik Lokal",
    baseUrl: `http://localhost:${MOCK_PORT}`,
    adapter: "generic-selector",
    permission: "APPROVED",
    permissionEvidence: "Situs uji milik sendiri (mock-site/server.ts)",
    minDelayMs: 300,
    config: MOCK_SELECTORS as unknown as Record<string, unknown>,
  },
];

function sourceFor(url: string) {
  const src = SOURCES.find((s) => url.startsWith(s.baseUrl));
  if (!src) throw new Error(`Tidak ada Source terdaftar untuk ${url}. Tambahkan Source + bukti izin terlebih dahulu.`);
  return src;
}

function printPreview(p: Preview) {
  const s = p.series;
  console.log(`\n  ┌ PREVIEW ─────────────────────────────`);
  console.log(`  │ Judul    : ${s.title}`);
  console.log(`  │ Tipe     : ${s.type}   Status: ${s.status}`);
  console.log(`  │ Author   : ${s.author}`);
  console.log(`  │ Genre    : ${s.genres.join(", ")}`);
  console.log(`  │ Cover    : ${s.coverUrl}`);
  console.log(`  │ Sinopsis : ${s.synopsis.slice(0, 90)}…`);
  console.log(`  │ Chapter  : ${p.chapters.map((c) => c.number + (c.alreadyImported ? "✓" : "")).join(", ")}`);
  console.log(`  └──────────────────────────────────────\n`);
}

async function renderReader(series: StoredSeries) {
  const ch = series.chapters.at(-1)!;
  const imgs = ch.pages
    .map((pg) => `<img src="public/${pg.key}" width="${pg.width}" height="${pg.height}" loading="lazy" alt="Halaman ${pg.order}">`)
    .join("\n");
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${series.title} – Chapter ${ch.number}</title>
<style>body{margin:0;background:#0b0b0f;color:#e5e5e5;font-family:system-ui}header{padding:16px;display:flex;gap:16px;align-items:center;max-width:800px;margin:auto}
header img{width:72px;border-radius:8px}main{max-width:800px;margin:auto}main img{display:block;width:100%;height:auto}</style></head>
<body><header>${series.coverKey ? `<img src="public/${series.coverKey}">` : ""}<div><b>${series.title}</b><br>Chapter ${ch.number} · ${ch.pages.length} halaman · status ${ch.status}<br><small>${series.genres.join(" · ")}</small></div></header>
<main>${imgs}</main></body></html>`;
  const file = path.join(STORAGE_DIR, "reader-preview.html");
  await writeFile(file, html);
  return file;
}

async function main() {
  const [cmd, url, ...rest] = process.argv.slice(2);
  const chaptersArg = rest[rest.indexOf("--chapters") + 1];

  if (cmd === "demo") {
    const server = await startMockSite();
    const seriesUrl = `http://localhost:${MOCK_PORT}/komik/penjaga-menara-senja/`;
    try {
      console.log(`\n=== 1. PREVIEW ${seriesUrl}`);
      const { job, preview } = await previewJob(sourceFor(seriesUrl), seriesUrl);
      console.log(`  → job ${job.status}${job.error ? `: ${job.error}` : ""}`);
      if (!preview) return;
      printPreview(preview);

      console.log(`=== 2. IMPOR chapter 1`);
      const imp = await importJob(sourceFor(seriesUrl), preview, [1]);
      console.log(`  → job ${imp.job.status} (${imp.job.progress}/${imp.job.total})${imp.job.error ? `: ${imp.job.error}` : ""}`);

      console.log(`\n=== 3. IMPOR ULANG chapter 1 (harus terdeteksi duplikat)`);
      const again = await previewJob(sourceFor(seriesUrl), seriesUrl);
      const dup = await importJob(sourceFor(seriesUrl), again.preview!, [1]);
      console.log(`  → job ${dup.job.status}`);

      const blockedUrl = `http://localhost:${MOCK_PORT}/komik/terproteksi/`;
      console.log(`\n=== 4. SUMBER DENGAN ANTI-BOT ${blockedUrl}`);
      const blocked = await previewJob(sourceFor(blockedUrl), blockedUrl);
      console.log(`  → job ${blocked.job.status}: ${blocked.job.error}`);

      const robotsUrl = `http://localhost:${MOCK_PORT}/premium/series-x/`;
      console.log(`\n=== 5. URL YANG DILARANG robots.txt ${robotsUrl}`);
      const robots = await previewJob(sourceFor(robotsUrl), robotsUrl);
      console.log(`  → job ${robots.job.status}: ${robots.job.error}`);

      if (imp.series) console.log(`\nReader preview: ${await renderReader(imp.series)}`);
    } finally {
      server.close();
    }
    return;
  }

  if (cmd === "preview" && url) {
    const { job, preview } = await previewJob(sourceFor(url), url);
    if (preview) printPreview(preview);
    console.log(`job ${job.status}${job.error ? `: ${job.error}` : ""}`);
    return;
  }

  if (cmd === "import" && url && chaptersArg) {
    const { preview } = await previewJob(sourceFor(url), url);
    if (!preview) throw new Error("Preview gagal");
    const r = await importJob(sourceFor(url), preview, chaptersArg.split(",").map(Number));
    console.log(`job ${r.job.status}${r.job.error ? `: ${r.job.error}` : ""}`);
    if (r.series) console.log(`Reader preview: ${await renderReader(r.series)}`);
    return;
  }

  console.log("Pemakaian: scrape demo | scrape preview <url> | scrape import <url> --chapters 1,2");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
