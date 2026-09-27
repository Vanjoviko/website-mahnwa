import { detectBlock } from "./block-detector.js";
import { BlockedError, RobotsDisallowedError } from "./errors.js";
import { getRobots } from "./robots.js";

export interface HttpClientOptions {
  userAgent: string;
  /** Jeda minimum antar request ke host yang sama. */
  minDelayMs: number;
  maxRetries?: number;
  timeoutMs?: number;
  onLog?: (message: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Satu-satunya jalan adapter mengakses jaringan. Menjamin:
 * - User-Agent jujur (tanpa rotasi UA, tanpa proxy, tanpa cookie login)
 * - robots.txt dipatuhi (termasuk Crawl-delay)
 * - rate limit per host
 * - retry + exponential backoff hanya untuk error jaringan / 5xx
 * - berhenti total (BlockedError) jika sumber menolak akses
 */
export class HttpClient {
  private nextSlot = new Map<string, number>();
  readonly stats = { requests: 0, retries: 0, bytes: 0 };

  constructor(private opts: HttpClientOptions) {}

  async getText(url: string): Promise<string> {
    const res = await this.request(url, true);
    return res.text as string;
  }

  async getBuffer(url: string): Promise<Buffer> {
    const res = await this.request(url, false);
    return res.buffer as Buffer;
  }

  private async waitForSlot(host: string, delayMs: number) {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, slot + delayMs);
    if (slot > now) await sleep(slot - now);
  }

  private async request(url: string, asText: boolean) {
    const u = new URL(url);
    const robots = await getRobots(u.origin, this.opts.userAgent);
    if (robots.isDisallowed(url, this.opts.userAgent)) throw new RobotsDisallowedError(url);
    const crawlDelayMs = (robots.getCrawlDelay(this.opts.userAgent) ?? 0) * 1000;
    const delay = Math.max(this.opts.minDelayMs, crawlDelayMs);

    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      await this.waitForSlot(u.host, delay);
      this.stats.requests++;
      let res: Response;
      try {
        res = await fetch(url, {
          headers: { "user-agent": this.opts.userAgent, accept: asText ? "text/html" : "image/*" },
          redirect: "follow",
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch (err) {
        if (attempt >= maxRetries) throw err;
        await this.backoff(attempt, url, `error jaringan: ${(err as Error).message}`);
        continue;
      }

      const text = asText ? await res.text() : null;
      const blocked = detectBlock(res.status, res.headers, text, url, res.url);
      if (blocked) throw new BlockedError(blocked, url);

      if (res.status >= 500) {
        if (attempt >= maxRetries) throw new Error(`HTTP ${res.status} setelah ${attempt + 1} percobaan`);
        const retryAfter = Number(res.headers.get("retry-after")) * 1000 || 0;
        await this.backoff(attempt, url, `HTTP ${res.status}`, retryAfter);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${url}`);

      if (asText) {
        this.stats.bytes += Buffer.byteLength(text!);
        return { text };
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      this.stats.bytes += buffer.length;
      return { buffer };
    }
  }

  private async backoff(attempt: number, url: string, reason: string, minMs = 0) {
    const ms = Math.max(minMs, 1000 * 2 ** attempt);
    this.stats.retries++;
    this.opts.onLog?.(`retry #${attempt + 1} dalam ${ms}ms (${reason}) ${url}`);
    await sleep(ms);
  }
}
