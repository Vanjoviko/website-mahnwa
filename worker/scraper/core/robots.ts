import robotsParser from "robots-parser";

type Robots = ReturnType<typeof robotsParser>;

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { robots: Robots; fetchedAt: number }>();

/** robots.txt di-cache 24 jam per origin. Gagal ambil (404) = diizinkan, sesuai standar. */
export async function getRobots(origin: string, userAgent: string): Promise<Robots> {
  const hit = cache.get(origin);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.robots;

  const robotsUrl = `${origin}/robots.txt`;
  let body = "";
  try {
    const res = await fetch(robotsUrl, { headers: { "user-agent": userAgent } });
    if (res.ok) body = await res.text();
    // 401/403 pada robots.txt = semua dilarang (RFC 9309)
    else if (res.status === 401 || res.status === 403) body = "User-agent: *\nDisallow: /";
  } catch {
    // tidak bisa dijangkau → biarkan kosong; request berikutnya akan gagal sendiri
  }
  const robots = robotsParser(robotsUrl, body);
  cache.set(origin, { robots, fetchedAt: Date.now() });
  return robots;
}
