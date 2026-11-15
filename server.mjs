import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dist = resolve(root, "dist");
const PORT = Number(process.env.PORT || 3000);
const NASA_BASE = "https://power.larc.nasa.gov/api/temporal/daily/point";
const ALLOWED = new Set(["T2M", "T2MDEW", "RH2M", "PRECTOTCORR"]);
const MAX_RANGE_DAYS = 20 * 366;
const MAX_UPSTREAM_BYTES = 12 * 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function parseDate(value) {
  if (!/^\d{8}$/.test(value || "")) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

function validNasaQuery(url) {
  const rawLatitude = url.searchParams.get("latitude");
  const rawLongitude = url.searchParams.get("longitude");
  if (!rawLatitude?.trim() || !rawLongitude?.trim()) return { error: "Latitude and longitude are required." };
  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  const start = parseDate(url.searchParams.get("start"));
  const end = parseDate(url.searchParams.get("end"));
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return { error: "Latitude must be between -90 and 90." };
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return { error: "Longitude must be between -180 and 180." };
  if (!start || !end || start > end) return { error: "Use valid YYYYMMDD start and end dates, with start no later than end." };
  if (start.getUTCFullYear() < 1981) return { error: "NASA POWER daily data begins in 1981." };
  if (end > new Date()) return { error: "The end date cannot be in the future." };
  const days = Math.floor((end - start) / 86400000) + 1;
  if (days > MAX_RANGE_DAYS) return { error: "Choose a period of 20 years or less." };
  const requested = (url.searchParams.get("parameters") || "").split(",");
  if (!requested.length || requested.some((name) => !ALLOWED.has(name))) return { error: "Only T2M, T2MDEW, RH2M and PRECTOTCORR are supported." };
  return { latitude, longitude, start: url.searchParams.get("start"), end: url.searchParams.get("end"), parameters: [...new Set(requested)].join(",") };
}

async function nasaPower(url, res) {
  const query = validNasaQuery(url);
  if (query.error) return json(res, 400, { error: query.error });
  const target = new URL(NASA_BASE);
  target.search = new URLSearchParams({
    parameters: query.parameters,
    community: "AG",
    longitude: String(query.longitude),
    latitude: String(query.latitude),
    start: query.start,
    end: query.end,
    format: "JSON",
  }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(target, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) return json(res, 502, { error: `NASA POWER returned HTTP ${response.status}. Try a shorter date range or try again later.` });
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_UPSTREAM_BYTES) return json(res, 413, { error: "The NASA response is too large. Choose a shorter period." });
    try { JSON.parse(body); } catch { return json(res, 502, { error: "NASA POWER returned an unreadable response." }); }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(body);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    json(res, 502, { error: timedOut ? "NASA POWER request timed out. Try a shorter period." : "Could not reach NASA POWER. Check the connection and try again." });
  } finally {
    clearTimeout(timeout);
  }
}

function serveStatic(pathname, res) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: "Invalid path." }); }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const file = resolve(dist, normalize(requested));
  if (!file.startsWith(`${dist}/`) && file !== join(dist, "index.html")) return json(res, 403, { error: "Forbidden." });
  const candidate = existsSync(file) && statSync(file).isFile() ? file : join(dist, "index.html");
  if (!existsSync(candidate)) return json(res, 503, { error: "Application build is not available." });
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".woff2": "font/woff2" };
  res.writeHead(200, { "Content-Type": types[extname(candidate)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Cache-Control": extname(candidate) === ".html" ? "no-cache" : "public, max-age=300" });
  createReadStream(candidate).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
  if (url.pathname === "/api/nasa-power") {
    if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
    return nasaPower(url, res);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Method not allowed." });
  return serveStatic(url.pathname, res);
});

server.listen(PORT, "0.0.0.0", () => console.log(`SBR server listening on 0.0.0.0:${PORT}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
