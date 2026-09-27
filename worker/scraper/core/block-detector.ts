/**
 * Mendeteksi tanda bahwa sumber menolak akses otomatis. Jika terdeteksi, scraper BERHENTI —
 * tidak ada percobaan melewati CAPTCHA, challenge Cloudflare, login, paywall, dsb.
 */
const BODY_MARKERS: Array<[RegExp, string]> = [
  [/cf-chl-|challenge-platform|cf_chl_opt|Just a moment\.\.\./i, "Challenge Cloudflare"],
  [/g-recaptcha|h-captcha|hcaptcha\.com|turnstile/i, "CAPTCHA"],
  [/Attention Required! \| Cloudflare/i, "Cloudflare block page"],
  [/<form[^>]+(login|signin)[^>]*>/i, "Halaman login"],
  [/paywall|subscribe to (read|continue)/i, "Paywall"],
];

export function detectBlock(
  status: number,
  headers: Headers,
  body: string | null,
  requestedUrl: string,
  finalUrl: string,
): string | null {
  if (status === 401) return "HTTP 401 (butuh login)";
  if (status === 403) return "HTTP 403 (akses ditolak)";
  if (status === 429) return "HTTP 429 (rate limit sumber)";
  if (headers.get("cf-mitigated")) return "Cloudflare mitigation";
  if (/\/(login|signin|masuk)\b/i.test(new URL(finalUrl).pathname) &&
      !/\/(login|signin|masuk)\b/i.test(new URL(requestedUrl).pathname)) {
    return "Redirect ke halaman login";
  }
  if (body) {
    for (const [re, label] of BODY_MARKERS) if (re.test(body)) return label;
  }
  return null;
}
