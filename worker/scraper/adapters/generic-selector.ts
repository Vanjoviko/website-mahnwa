import * as cheerio from "cheerio";
import type { ScrapeContext, ScrapedChapterRef, ScrapedSeries, SeriesStatus, SeriesType, SourceAdapter } from "../core/types.js";

/**
 * Adapter yang dikonfigurasi lewat CSS selector (diisi admin di panel Source).
 * Cocok untuk kebanyakan situs komik sederhana tanpa perlu menulis kode baru.
 */
export interface GenericSelectorConfig {
  series: {
    title: string;
    cover: string;          // <img>, diambil atribut src / data-src
    synopsis: string;
    genres: string;         // banyak elemen
    status?: string;
    author?: string;
    type?: string;
  };
  chapterList: {
    item: string;           // tiap baris chapter
    link: string;           // <a> di dalam item (relatif ke item)
    title?: string;
    nextPage?: string;      // <a> halaman berikutnya (pagination)
  };
  chapterImages: {
    img: string;
    attr?: string[];        // urutan atribut yang dicoba, default ["data-src", "src"]
  };
}

const STATUS_MAP: Array<[RegExp, SeriesStatus]> = [
  [/ongoing|berjalan|on-going/i, "ONGOING"],
  [/completed|tamat|selesai|end/i, "COMPLETED"],
  [/hiatus/i, "HIATUS"],
];
const TYPE_MAP: Array<[RegExp, SeriesType]> = [
  [/manhwa/i, "MANHWA"],
  [/manhua/i, "MANHUA"],
  [/manga/i, "MANGA"],
];

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
/** "Penulis: Budi" → "Budi" */
const stripLabel = (s: string) => s.replace(/^[^:]{1,20}:\s*/, "");
const abs = (href: string, base: string) => new URL(href, base).toString();

/** "Chapter 12.5 - Judul" → 12.5 */
export function parseChapterNumber(text: string): number | null {
  const m = text.match(/(?:chapter|ch\.?|episode|ep\.?|bab)\s*(\d+(?:[.,]\d+)?)/i) ?? text.match(/(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(",", ".")) : null;
}

export function createGenericSelectorAdapter(cfg: GenericSelectorConfig): SourceAdapter {
  const imgSrc = (el: cheerio.Cheerio<any>, attrs = ["data-src", "data-lazy-src", "src"]) => {
    for (const a of attrs) {
      const v = el.attr(a)?.trim();
      if (v) return v;
    }
    return null;
  };

  return {
    id: "generic-selector",

    async parseSeries(ctx, url): Promise<ScrapedSeries> {
      const $ = cheerio.load(await ctx.http.getText(url));
      const s = cfg.series;
      const cover = imgSrc($(s.cover).first());
      const statusText = s.status ? clean($(s.status).first().text()) : "";
      const typeText = s.type ? clean($(s.type).first().text()) : "";
      const title = clean($(s.title).first().text());
      if (!title) throw new Error(`Judul tidak ditemukan (selector "${s.title}")`);
      return {
        sourceUrl: url,
        title,
        coverUrl: cover ? abs(cover, url) : null,
        synopsis: clean($(s.synopsis).first().text()),
        genres: [...new Set($(s.genres).map((_, e) => clean($(e).text())).get().filter(Boolean))],
        status: STATUS_MAP.find(([re]) => re.test(statusText))?.[1] ?? null,
        author: s.author ? stripLabel(clean($(s.author).first().text())) || null : null,
        type: TYPE_MAP.find(([re]) => re.test(typeText))?.[1] ?? null,
      };
    },

    async *listChapters(ctx, seriesUrl): AsyncIterable<ScrapedChapterRef> {
      const seen = new Set<string>();
      let pageUrl: string | null = seriesUrl;
      let pages = 0;
      while (pageUrl && pages++ < 100) {
        const $ = cheerio.load(await ctx.http.getText(pageUrl));
        for (const item of $(cfg.chapterList.item).toArray()) {
          const a = $(item).find(cfg.chapterList.link).first();
          const href = a.attr("href");
          if (!href) continue;
          const url = abs(href, pageUrl);
          if (seen.has(url)) continue; // duplicate detection antar halaman
          seen.add(url);
          const label = clean(cfg.chapterList.title ? $(item).find(cfg.chapterList.title).text() : a.text());
          const number = parseChapterNumber(label);
          if (number === null) {
            ctx.log("warn", `Nomor chapter tidak terbaca: "${label}"`, url);
            continue;
          }
          yield { sourceUrl: url, number, title: label || null };
        }
        const next = cfg.chapterList.nextPage ? $(cfg.chapterList.nextPage).first().attr("href") : null;
        pageUrl = next ? abs(next, pageUrl) : null;
        if (pageUrl) ctx.log("info", `Pagination → ${pageUrl}`);
      }
    },

    async getChapterImages(ctx, chapterUrl) {
      const $ = cheerio.load(await ctx.http.getText(chapterUrl));
      const urls = $(cfg.chapterImages.img)
        .map((_, e) => imgSrc($(e), cfg.chapterImages.attr))
        .get()
        .filter((v): v is string => !!v)
        .map((v) => abs(v, chapterUrl));
      return [...new Set(urls)];
    },
  };
}
