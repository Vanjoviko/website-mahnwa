# Rencana Teknis — [NamaSitus]

Status: **DRAFT — menunggu persetujuan sebelum coding.**

---

## 1. Arsitektur tingkat tinggi

```
                ┌──────────────── Vercel ────────────────┐
 Browser ──────▶│ Next.js (App Router, RSC, ISR)          │
   │            │  • halaman pembaca / reader / dashboard │
   │            │  • Route Handlers (API)                 │
   │            │  • Server Actions                       │
   │            └───────┬───────────────┬─────────────────┘
   │ presigned PUT      │ Prisma        │ enqueue job
   ▼                    ▼               ▼
 Cloudflare R2 ◀── Worker (Node) ◀── PostgreSQL (managed)
 (raw/ & public/)   • pipeline gambar   • data aplikasi
   │                • scraper          • antrian job (pg-boss)
   ▼                • publish terjadwal
 CDN (custom domain R2 / Cloudflare)
```

Poin penting:

- **Upload langsung ke R2** via presigned URL (menghindari limit body 4.5 MB di Vercel).
- **Worker terpisah** (proses Node long-running) untuk pipeline gambar dan scraper.
  Vercel serverless punya batas durasi & memori, sehingga `sharp` + scraping dengan
  rate limit tidak cocok dijalankan di sana. Antrian memakai **pg-boss** (berbasis
  PostgreSQL, tidak perlu Redis). Worker bisa di-deploy ke Railway / Fly.io / VPS kecil.
  Di lokal cukup `npm run worker`.
- **Storage driver abstrak**: `r2` untuk produksi, `local` (folder `./.storage`) untuk
  development, jadi bisa dijalankan tanpa akun Cloudflare.

## 2. Struktur folder

```
.
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                 # series fiktif + gambar placeholder (sharp/SVG)
├── src/
│   ├── app/
│   │   ├── (site)/             # layout publik: header sticky, footer
│   │   │   ├── page.tsx        # Home
│   │   │   ├── series/[slug]/page.tsx
│   │   │   ├── series/[slug]/[episode]/page.tsx   # reader
│   │   │   ├── cari/page.tsx
│   │   │   ├── ranking/page.tsx
│   │   │   ├── genre/[genre]/page.tsx
│   │   │   ├── library/page.tsx
│   │   │   ├── notifikasi/page.tsx
│   │   │   └── (legal)/tentang|kontak|privasi|syarat|pedoman-konten|
│   │   │              perjanjian-kreator|pengaduan-hak-cipta/page.tsx
│   │   ├── (auth)/masuk/page.tsx
│   │   ├── kreator/            # dashboard kreator (role creator)
│   │   ├── admin/              # panel admin (role admin)
│   │   ├── api/                # route handlers (upload, comments, auth, ...)
│   │   ├── sitemap.ts  robots.ts  ads.txt/route.ts
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ui/                 # primitives (Button, Badge, Dialog, Tabs...)
│   │   ├── series/             # SeriesCard, SeriesGrid, EpisodeList...
│   │   ├── reader/             # ReaderImage, ProgressBar, EpisodeNav...
│   │   ├── ads/AdSlot.tsx
│   │   └── consent/CookieConsent.tsx
│   ├── lib/
│   │   ├── db.ts  auth.ts  permissions.ts  storage/  queue.ts
│   │   ├── seo/ (metadata, json-ld)
│   │   └── validators/ (zod)
│   ├── server/                 # query & mutation layer (dipakai RSC/actions)
│   └── config/ (site.ts, ads.ts)
├── worker/
│   ├── index.ts                # registrasi handler pg-boss
│   ├── jobs/ process-episode-images.ts  publish-scheduled.ts  aggregate-stats.ts
│   └── scraper/
│       ├── core/ (http-client, robots, rate-limiter, retry, block-detector)
│       ├── adapters/ (satu file per situs sumber)
│       ├── registry.ts
│       └── run-scrape-job.ts
├── public/
└── docs/
```

## 3. Skema Prisma (ringkas)

```prisma
enum Role            { READER CREATOR ADMIN }
enum SeriesStatus    { ONGOING COMPLETED HIATUS }
enum ContentRating   { ALL_AGES TEEN_13 MATURE_17 }
enum EpisodeStatus   { DRAFT IN_REVIEW SCHEDULED PUBLISHED REJECTED TAKEN_DOWN }
enum Visibility      { VISIBLE HIDDEN TAKEN_DOWN }
enum ReportType      { CONTENT_VIOLATION COPYRIGHT SPAM OTHER }
enum ReportStatus    { OPEN IN_REVIEW RESOLVED REJECTED }
enum SourcePermission{ PENDING APPROVED REVOKED DENIED }
enum JobStatus       { QUEUED RUNNING PREVIEW_READY IMPORTING COMPLETED FAILED CANCELLED BLOCKED }
enum ContentOrigin   { UPLOAD IMPORT }

model User {
  id, email @unique, name, image, role Role @default(READER),
  bannedAt DateTime?, banReason String?, createdAt
  accounts Account[]  sessions Session[]   // Auth.js adapter
  creatorProfile CreatorProfile?
  comments, likes, subscriptions, history, notifications, reports
}

model CreatorProfile {
  id, userId @unique, penName, slug @unique, bio, avatar,
  isTrusted Boolean @default(false)   // bypass moderasi
  verifiedAt DateTime?, payoutInfo Json?  // tahap berikutnya
  series Series[]
}

model Series {
  id, slug @unique, title, altTitles String[], synopsis, coverKey, bannerKey?,
  status SeriesStatus, rating ContentRating, scheduleDays Int[] // 0-6
  type (MANHWA/MANGA/MANHUA/ORIGINAL), origin ContentOrigin,
  creatorId -> CreatorProfile, sourceId? -> Source, sourceUrl? @unique,
  visibility Visibility, isFeatured,
  viewCount, likeCount, subscriberCount (denormalized)
  latestEpisodeAt DateTime?   // untuk "Update Terbaru" & badge UP
  genres SeriesGenre[] tags SeriesTag[]
  createdAt updatedAt
  @@index([visibility, latestEpisodeAt]) @@index([rating])
}

model Genre { id, slug @unique, name }       model SeriesGenre { seriesId, genreId @@id }
model Tag   { id, slug @unique, name }       model SeriesTag   { seriesId, tagId  @@id }

model Episode {
  id, seriesId, number Decimal   // mendukung 10.5
  title, thumbnailKey, creatorNote, status EpisodeStatus,
  publishedAt DateTime?, scheduledAt DateTime?,
  sourceUrl? , contentHash?  // duplicate detection impor
  viewCount, likeCount, commentCount
  pages EpisodePage[]
  @@unique([seriesId, number]) @@index([status, publishedAt])
}

model EpisodePage {
  id, episodeId, order Int, key String, width Int, height Int,
  saverKey String   // varian hemat data
  blurDataUrl String?
  @@unique([episodeId, order])
}

model Upload { id, userId, rawKey, status, error, episodeId?, createdAt } // melacak file mentah

model Comment { id, episodeId, userId, parentId?, body, isHidden, createdAt, likeCount }
model Like          { userId, episodeId @@id }
model Subscription  { userId, seriesId, createdAt @@id }
model ReadingHistory{ userId, seriesId, episodeId, progress Float, updatedAt @@id([userId, seriesId]) }
model Notification  { id, userId, type, payload Json, readAt?, createdAt }

model SeriesDailyStat { seriesId, date, views, likes, subs @@id([seriesId, date]) } // ranking
model EpisodeDailyStat{ episodeId, date, views, likes     @@id([episodeId, date]) }

model Report {
  id, type ReportType, status ReportStatus, reporterId?, reporterEmail?,
  targetType (SERIES/EPISODE/COMMENT/USER), targetId, reason, evidenceUrl?,
  // khusus hak cipta:
  claimantName?, claimantOrg?, originalWorkUrl?, swornStatement Boolean,
  createdAt, resolvedAt, resolvedById?
}

model ModerationLog { id, actorId, action, targetType, targetId, note, meta Json, createdAt }

model RightsDeclaration { id, creatorId, seriesId?, episodeId?, text, ip, userAgent, createdAt }

model FeaturedSlot { id, seriesId, position, imageKey?, headline?, startsAt?, endsAt? }

model Source {
  id, name, baseUrl @unique, adapter String, // nama adapter di registry
  permission SourcePermission, permissionEvidence String?, // link ToS / surat izin
  licenseNote String?, config Json, // selector, rate limit, dll
  minDelayMs Int @default(3000), maxConcurrency Int @default(1),
  respectRobots Boolean @default(true) // tidak bisa dimatikan di UI
  createdAt updatedAt
}

model ScrapeJob {
  id, sourceId, url, mode (SERIES/CHAPTERS/ALL/SYNC), selection Json?,
  status JobStatus, progress Int, total Int, error String?,
  preview Json?,   // hasil parsing sebelum impor
  createdById, createdAt, startedAt?, completedAt?
  logs ScrapeLog[]
}
model ScrapeLog { id, jobId, level, message, url?, createdAt }
```

## 4. Daftar route

| Route | Render | Akses |
|---|---|---|
| `/` | ISR 60s | publik |
| `/series/[slug]` | ISR 300s + revalidate on publish | publik |
| `/series/[slug]/[episode]` | ISR + revalidate on publish | publik (17+: age gate) |
| `/cari?q=&genre=&status=&rating=&sort=` | SSR | publik |
| `/ranking?periode=harian|mingguan|bulanan` | ISR 10m | publik |
| `/genre/[slug]` | ISR | publik |
| `/library`, `/notifikasi`, `/akun` | SSR | login |
| `/masuk` | — | publik |
| `/kreator`, `/kreator/series/baru`, `/kreator/series/[id]`, `/kreator/series/[id]/episode/baru`, `/kreator/statistik` | SSR | creator |
| `/admin` (dashboard), `/admin/moderasi`, `/admin/laporan`, `/admin/series`, `/admin/users`, `/admin/featured`, `/admin/genre-tag`, `/admin/scraper/sources`, `/admin/scraper/baru`, `/admin/scraper/jobs/[id]` | SSR | admin |
| Halaman legal (7) | static | publik |
| `/sitemap.xml`, `/robots.txt`, `/ads.txt` | dinamis | publik |
| `/api/upload/presign`, `/api/upload/complete`, `/api/view`, `/api/comments`, `/api/auth/*` | route handler | sesuai role |

Mutasi lain (like, subscribe, simpan progress, moderasi) memakai Server Actions + zod.

## 5. Arsitektur upload & pipeline gambar

1. Kreator drag & drop banyak file → client mengurutkan (nama natural sort, bisa drag untuk
   reorder) → minta presigned URL → **PUT langsung ke R2** `raw/{uploadId}/{n}.{ext}`
   (validasi tipe & ukuran: jpg/png/webp, maks 20 MB/file, maks 200 file/episode).
2. Submit episode → buat `Episode` (status DRAFT) + `RightsDeclaration` → enqueue
   `process-episode-images`.
3. Worker:
   - download raw → `sharp`: auto-rotate, strip metadata EXIF, resize lebar **800px**
     (standar webtoon), **potong vertikal** tiap ≤ 2000px (potong dengan sedikit overlap
     0px tapi di baris yang "kosong" bila terdeteksi, fallback potong fix);
   - encode **WebP q80** (standar) + **WebP q50 lebar 480** (hemat data);
   - generate `blurDataUrl` kecil, thumbnail episode & cover (beberapa ukuran);
   - tulis ke `public/series/{seriesId}/ep/{episodeId}/{order}.webp`, simpan width/height
     (untuk reservasi tinggi → CLS 0);
   - hapus raw setelah sukses; status episode → IN_REVIEW (atau PUBLISHED/SCHEDULED jika
     kreator terpercaya).
4. Job `publish-scheduled` (cron tiap menit di worker) mem-publish episode terjadwal,
   mengisi `Series.latestEpisodeAt`, membuat notifikasi subscriber, dan memanggil
   `revalidatePath` via endpoint internal bertoken.

## 6. Arsitektur scraper/importer

```
Admin input URL ─▶ ScrapeJob(QUEUED) ─▶ worker
   │                                   │ 1. cek Source.permission == APPROVED
   │                                   │ 2. cek robots.txt (cache 24 jam)
   │                                   │ 3. adapter.parseSeries / listChapters (pagination)
   │                                   │ 4. simpan preview (Json) → PREVIEW_READY
   ▼                                   │
Admin lihat preview, pilih chapter ────▶ 5. ScrapeJob IMPORTING
                                        │ 6. adapter.getChapterImages → download (rate-limited)
                                        │ 7. pipeline gambar yang sama dengan upload
                                        │ 8. dedup (sourceUrl, seriesId+number, contentHash)
                                        ▼ 9. episode masuk antrian moderasi → COMPLETED
```

Antarmuka adapter:

```ts
interface SourceAdapter {
  id: string;                       // "contoh-situs"
  matches(url: URL): boolean;
  parseSeries(ctx, url): Promise<ScrapedSeries>;       // judul, cover, sinopsis, genre, status, author
  listChapters(ctx, seriesUrl): AsyncIterable<ScrapedChapterRef>;  // mendukung pagination
  getChapterImages(ctx, chapterUrl): Promise<string[]>;
}
```

`ctx.fetch` adalah HTTP client bersama yang **wajib** dipakai adapter:

- User-Agent jujur (`[NamaSitus]Bot/1.0 (+https://domain/bot)`), tanpa rotasi UA / proxy.
- Rate limit per host (token bucket, default 1 req / 3 detik, konfigurasi per Source),
  hormati `Crawl-delay` dan header `Retry-After`.
- Retry dengan exponential backoff **hanya** untuk error jaringan & 5xx biasa (maks 3x).
- **Block detector**: status 401/403/429 berulang, halaman challenge Cloudflare/CAPTCHA,
  redirect ke login/paywall → job langsung **BLOCKED** dan berhenti, tidak ada upaya bypass.
- Tidak menyimpan/mengirim cookie login, tidak menjalankan headless browser.

Adapter pertama: **`generic-selector`** (konfigurasi CSS selector lewat admin, pakai
`cheerio`) + **situs mock lokal** untuk test & demo, sehingga alur lengkap bisa diuji
tanpa menyentuh situs pihak ketiga.

## 7. SEO, iklan & consent (ringkas)

- `generateMetadata` per halaman, canonical, OG image = cover/banner.
- JSON-LD `ComicSeries`, `ComicIssue`, `BreadcrumbList`.
- `sitemap.ts` dipecah (sitemap index) bila episode > 50k.
- `<AdSlot id placement minHeight>`: tinggi direservasi, render `null` jika
  `rating === MATURE_17`, jika iklan dimatikan di `config/ads.ts`, atau consent belum
  diberikan (tetap placeholder bertinggi sama → tanpa CLS). Placeholder abu-abu di dev.
- Consent banner (Google Consent Mode v2) memblokir skrip AdSense & analytics sampai setuju.
- `ads.txt` dari `ADSENSE_PUBLISHER_ID`.

## 8. Tahapan kerja

(a) setup + skema + seed → (b) halaman pembaca + reader → (c) akun & library →
(d) dashboard kreator + upload → (e) admin & moderasi → (f) scraper → (g) SEO →
(h) iklan & consent → (i) optimasi performa. Setiap tahap: `lint`, `typecheck`,
`build`, ringkasan perubahan, commit & push.
