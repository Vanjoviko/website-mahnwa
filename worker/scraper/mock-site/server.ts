/**
 * Situs komik TIRUAN untuk menguji scraper secara lokal (tanpa menyentuh situs pihak ketiga).
 * Meniru pola umum situs baca komik: halaman series, daftar chapter berhalaman (pagination),
 * gambar lazy-load (data-src) yang sangat panjang, robots.txt, dan halaman yang diproteksi
 * challenge anti-bot (untuk membuktikan scraper berhenti, bukan mem-bypass).
 */
import { createServer } from "node:http";
import sharp from "sharp";

export const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4010);
const TITLE = "Penjaga Menara Senja";
const CHAPTERS = 12;
const PAGES_PER_CHAPTER = 3;
const PALETTE = ["#1e1b4b", "#312e81", "#4c1d95", "#701a75", "#831843", "#7c2d12"];

const page = (title: string, body: string) =>
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function seriesPage(pageNo: number) {
  const perPage = 6;
  const from = CHAPTERS - (pageNo - 1) * perPage;
  // halaman 2 sengaja mengulang 1 chapter dari halaman 1 → uji duplicate detection
  const numbers = Array.from({ length: perPage + (pageNo === 2 ? 1 : 0) }, (_, i) => from - i + (pageNo === 2 ? 1 : 0))
    .filter((n) => n >= 1 && n <= CHAPTERS);
  const items = numbers
    .map((n) => `<li class="chapter-item"><a href="/komik/penjaga-menara-senja/chapter-${n}/">Chapter ${n}</a><span class="date">2026-09-${String(n).padStart(2, "0")}</span></li>`)
    .join("");
  const next = pageNo < 2 ? `<a class="next-page" href="/komik/penjaga-menara-senja/?page=${pageNo + 1}">Berikutnya</a>` : "";
  return page(TITLE, `
    <div class="series-info">
      <h1 class="entry-title">${TITLE}</h1>
      <div class="thumb"><img data-src="/img/cover.png" src="/img/lazy.gif" alt="cover"></div>
      <div class="meta">
        <span class="type">Manhwa</span>
        <span class="status">Status: Ongoing</span>
        <span class="author">Penulis: Studio Fiksi Contoh</span>
        <div class="genres"><a>Action</a><a>Fantasy</a><a>Drama</a><a>Action</a></div>
      </div>
      <div class="synopsis"><p>Seorang penjaga menara tua menemukan bahwa lonceng yang ia rawat
        setiap senja ternyata menahan gerbang ke dunia lain. Ini adalah komik fiktif untuk pengujian.</p></div>
    </div>
    <ul class="chapter-list">${items}</ul>${next}`);
}

function chapterPage(n: number) {
  const imgs = Array.from({ length: PAGES_PER_CHAPTER }, (_, i) =>
    `<img class="page-img" data-src="/img/ch${n}-p${i + 1}.png" src="/img/lazy.gif">`).join("\n");
  return page(`${TITLE} Chapter ${n}`, `<h1>${TITLE} – Chapter ${n}</h1><div id="reader">${imgs}</div>`);
}

/** Gambar panel panjang 1000×3400 → setelah pipeline menjadi 800×2720 lalu dipotong 2 bagian. */
async function panelImage(ch: number, p: number) {
  const bg = PALETTE[(ch + p) % PALETTE.length];
  const w = 1000, h = 3400;
  const panels = [0, 1, 2].map((k) => `
    <rect x="60" y="${80 + k * 1100}" width="880" height="1000" rx="24" fill="#0b0b12" stroke="#fff" stroke-opacity=".25" stroke-width="6"/>
    <circle cx="${300 + k * 200}" cy="${500 + k * 1100}" r="${160 + k * 30}" fill="#fbbf24" fill-opacity=".85"/>
    <rect x="140" y="${860 + k * 1100}" width="720" height="140" rx="70" fill="#fff"/>
    <text x="500" y="${948 + k * 1100}" font-size="56" text-anchor="middle" font-family="sans-serif" fill="#111">Ch.${ch} · Hal ${p} · Panel ${k + 1}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${bg}"/>${panels}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function coverImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#0b0b12"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect x="250" y="220" width="100" height="420" fill="#1f1b2e"/>
    <circle cx="300" cy="200" r="70" fill="#fbbf24"/>
    <text x="300" y="720" font-size="52" text-anchor="middle" font-family="serif" fill="#fff">Penjaga Menara</text>
    <text x="300" y="775" font-size="44" text-anchor="middle" font-family="serif" fill="#fbbf24">Senja</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const CHALLENGE = page("Just a moment...", `<div id="challenge-platform"><script>window._cf_chl_opt={}</script>
  <div class="cf-turnstile"></div>Checking your browser before accessing.</div>`);

let flakyHits = 0;

export function startMockSite() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${MOCK_PORT}`);
    const p = url.pathname;
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    let m: RegExpMatchArray | null;
    try {
      if (p === "/robots.txt") return send(200, "text/plain", "User-agent: *\nDisallow: /admin/\nDisallow: /premium/\nCrawl-delay: 1\n");
      if (p === "/komik/penjaga-menara-senja/") return send(200, "text/html", seriesPage(Number(url.searchParams.get("page") ?? 1)));
      if ((m = p.match(/^\/komik\/penjaga-menara-senja\/chapter-(\d+)\/$/))) {
        const n = Number(m[1]);
        return n >= 1 && n <= CHAPTERS ? send(200, "text/html", chapterPage(n)) : send(404, "text/html", "not found");
      }
      if (p === "/img/cover.png") return send(200, "image/png", await coverImage());
      if ((m = p.match(/^\/img\/ch(\d+)-p(\d+)\.png$/))) {
        // gambar pertama chapter 1 gagal 503 sekali → membuktikan retry + backoff
        if (m[1] === "1" && m[2] === "1" && flakyHits++ === 0) return send(503, "text/plain", "busy", { "retry-after": "1" });
        return send(200, "image/png", await panelImage(Number(m[1]), Number(m[2])));
      }
      // Series yang diproteksi anti-bot → scraper harus BERHENTI
      if (p.startsWith("/komik/terproteksi/")) return send(403, "text/html", CHALLENGE, { "cf-mitigated": "challenge" });
      send(404, "text/html", "not found");
    } catch (e) {
      send(500, "text/plain", String(e));
    }
  });
  return new Promise<typeof server>((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMockSite().then(() => console.log(`Mock site: http://localhost:${MOCK_PORT}/komik/penjaga-menara-senja/`));
}
