const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const https = require("https");

const app = express();
const PORT = 3001;
const DB_PATH = path.join(__dirname, "logos-db.json");
const CACHE_DIR = path.join(__dirname, "cached-logos");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use("/cached-logos", express.static(CACHE_DIR));
app.use(express.static(path.join(__dirname, "public")));

function loadDB() { return JSON.parse(fs.readFileSync(DB_PATH, "utf-8")); }
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};

// ── Background removal via flood-fill from corners ────────────────────────────
async function removeBackground(inputBuffer) {
  try {
    const { data, info } = await sharp(inputBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const px = new Uint8Array(data);
    const idx = (x, y) => (y * width + x) * 4;

    const corners = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]
      .map(([x, y]) => { const i = idx(x, y); return { r: px[i], g: px[i + 1], b: px[i + 2], a: px[i + 3] }; });

    // Abort if corners are already transparent or all very dark (intentional bg)
    if (corners.every(c => c.a < 10)) return inputBuffer;

    const avg = {
      r: Math.round(corners.reduce((s, c) => s + c.r, 0) / 4),
      g: Math.round(corners.reduce((s, c) => s + c.g, 0) / 4),
      b: Math.round(corners.reduce((s, c) => s + c.b, 0) / 4),
    };
    if (avg.r < 30 && avg.g < 30 && avg.b < 30) return inputBuffer;
    if (!corners.every(c => Math.abs(c.r - avg.r) < 15 && Math.abs(c.g - avg.g) < 15 && Math.abs(c.b - avg.b) < 15)) return inputBuffer;

    const thr = 30;
    const match = (x, y) => {
      const i = idx(x, y); return px[i + 3] > 10 &&
        Math.abs(px[i] - avg.r) < thr && Math.abs(px[i + 1] - avg.g) < thr && Math.abs(px[i + 2] - avg.b) < thr;
    };
    const visited = new Uint8Array(width * height);
    const queue = [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]];
    queue.forEach(([x, y]) => { visited[y * width + x] = 1; });
    while (queue.length) {
      const [x, y] = queue.pop();
      px[idx(x, y) + 3] = 0;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const ni = ny * width + nx;
        if (visited[ni]) continue;
        visited[ni] = 1;
        if (match(nx, ny)) queue.push([nx, ny]);
      }
    }
    return await sharp(Buffer.from(px), { raw: { width, height, channels: 4 } }).png().toBuffer();
  } catch { return inputBuffer; }
}

async function toFinalBuffer(inputBuffer) {
  const clean = await removeBackground(inputBuffer);
  return sharp(clean, { density: 300 }).png()
    .resize(512, 512, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
}

// ── Source 1: Clearbit ────────────────────────────────────────────────────────
async function fetchFromClearbit(domain) {
  const url = `https://logo.clearbit.com/${domain}?size=512`;
  try {
    const r = await axios.get(url, { responseType: "arraybuffer", timeout: 6000, validateStatus: s => s === 200, httpsAgent });
    if (r.data?.length > 500) return url;
  } catch {}
  return null;
}

// ── Source 2: Brandfetch CDN ───────────────────────────────────────────────────
async function fetchFromBrandfetch(domain) {
  for (const url of [
    `https://cdn.brandfetch.io/${domain}/w/400/h/400/logo`,
    `https://cdn.brandfetch.io/${domain}/w/400/h/400/theme/dark/logo`,
  ]) {
    try {
      const r = await axios.get(url, { responseType: "arraybuffer", timeout: 6000, validateStatus: s => s === 200, httpsAgent });
      if (r.data?.length > 500) return url;
    } catch {}
  }
  return null;
}

// ── Source 3: Bing Images (primary image search) ───────────────────────────────
// Bing is the most scraper-friendly engine. We try two queries per company:
// one with transparent filter and one without (relying on bg removal as fallback).
async function fetchFromBingImages(companyName) {
  const urls = [];
  const seen = new Set();

  // Query 1: transparent filter
  // Query 2: no filter (catches logos that exist but aren't tagged transparent)
  const queries = [
    { q: `${companyName} logo`, qft: "+filterui:photo-transparent", form: "IRFLTR" },
    { q: `${companyName} logo`, qft: "", form: "HDRSC2" },
  ];

  for (const params of queries) {
    try {
      const r = await axios.get("https://www.bing.com/images/search", {
        params, headers: BROWSER_HEADERS, timeout: 10000,
      });

      // Method A: murl field in JSON blobs (original image URL)
      const re1 = /"murl"\s*:\s*"(https?:\/\/[^"]{10,800})"/g;
      let m;
      while ((m = re1.exec(r.data)) !== null) {
        const u = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
        if (!seen.has(u) && !u.includes("bing.com") && !u.includes("msn.com")) {
          seen.add(u); urls.push(u);
        }
        if (urls.length >= 12) break;
      }

      // Method B: mediaurl in href params (fallback)
      if (urls.length < 3) {
        const re2 = /[?&]mediaurl=([^&"]{10,800})/g;
        while ((m = re2.exec(r.data)) !== null) {
          try {
            const u = decodeURIComponent(m[1]);
            if (!seen.has(u) && !u.includes("bing.com")) { seen.add(u); urls.push(u); }
            if (urls.length >= 12) break;
          } catch {}
        }
      }
    } catch {}

    if (urls.length >= 6) break; // Enough results from first query
  }

  return urls;
}

// ── Source 4: Google Images ───────────────────────────────────────────────────
// Searches with transparent filter first, then falls back to general search.
async function fetchFromGoogleImages(companyName) {
  const urls = [];
  const seen = new Set();

  const queries = [
    { q: `${companyName} logo`, tbm: "isch", tbs: "ic:trans", hl: "en", gl: "us" },
    { q: `${companyName} logo`, tbm: "isch", hl: "en", gl: "us" },
  ];

  for (const params of queries) {
    try {
      const r = await axios.get("https://www.google.com/search", {
        params,
        headers: { ...BROWSER_HEADERS, "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+412; SOCS=CAISHAgBEhIaAB;" },
        timeout: 10000,
      });

      // Method A: "ou" field = original URL in Google Images JSON
      const re1 = /"ou"\s*:\s*"(https?:\/\/(?!(?:www\.google|encrypted-tbn|gstatic|doubleclick))[^"]{10,800})"/g;
      let m;
      while ((m = re1.exec(r.data)) !== null) {
        const u = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
        if (!seen.has(u)) { seen.add(u); urls.push(u); }
        if (urls.length >= 12) break;
      }

      // Method B: imgurl= in data-lpage or href params
      if (urls.length < 3) {
        const re2 = /[?&]imgurl=([^&"]{10,800})/g;
        while ((m = re2.exec(r.data)) !== null) {
          try {
            const u = decodeURIComponent(m[1]);
            if (!seen.has(u) && !u.includes("google")) { seen.add(u); urls.push(u); }
            if (urls.length >= 12) break;
          } catch {}
        }
      }
    } catch {}

    if (urls.length >= 6) break;
  }

  return urls;
}

// ── Source 5: DuckDuckGo images ───────────────────────────────────────────────
async function fetchFromDuckDuckGo(companyName) {
  try {
    const init = await axios.get("https://duckduckgo.com/", {
      params: { q: `${companyName} logo`, iax: "images", ia: "images" },
      headers: BROWSER_HEADERS, timeout: 8000,
    });
    const vqd = (init.data.match(/vqd=["']?([^"'&\s]+)["']?/) || [])[1];
    if (!vqd) return [];
    const imgs = await axios.get("https://duckduckgo.com/i.js", {
      params: { q: `${companyName} logo`, vqd, f: "type:transparent", p: 1 },
      headers: { ...BROWSER_HEADERS, Referer: "https://duckduckgo.com/" },
      timeout: 8000,
    });
    return (imgs.data?.results || []).slice(0, 8).map(r => r.image).filter(Boolean);
  } catch { return []; }
}

// ── Source 6: Wikipedia ───────────────────────────────────────────────────────
async function fetchFromWikipedia(companyName) {
  try {
    const s = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", list: "search", srsearch: companyName, format: "json", srlimit: 1 },
      timeout: 7000,
    });
    const title = s.data?.query?.search?.[0]?.title;
    if (!title) return null;
    const p = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", prop: "pageimages", titles: title, format: "json", pithumbsize: 512, piprop: "original|thumbnail" },
      timeout: 7000,
    });
    const page = Object.values(p.data?.query?.pages || {})[0];
    const src = page?.original?.source || page?.thumbnail?.source;
    if (src && /\.(svg|png)/i.test(src)) return src;
  } catch {}
  return null;
}

function guessDomainsForCompany(name) {
  const clean = name.toLowerCase().replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+(inc|corp|llc|ltd|co|group|holdings|sa|ag|plc|gmbh|sas|bv|nv)$/i, "")
    .trim().replace(/\s+/g, "");
  return [`${clean}.com`, `${clean}.io`, `${clean}.net`, `${clean}.org`];
}

async function resolveDomain(name) {
  const candidates = guessDomainsForCompany(name);
  for (const domain of candidates) {
    try {
      await axios.head(`https://${domain}`, { timeout: 4000, maxRedirects: 3, httpsAgent });
      return domain;
    } catch {
      try { await axios.head(`http://${domain}`, { timeout: 4000, maxRedirects: 3 }); return domain; } catch { continue; }
    }
  }
  return candidates[0];
}

function resolveUrl(base, rel) {
  if (!rel) return null;
  if (rel.startsWith("data:")) return rel;
  try { return new URL(rel, base).href; } catch { return null; }
}

function scoreCandidate(url, context) {
  if (context === "clearbit") return 230;
  if (context === "brandfetch") return 220;
  if (context === "wikipedia") return 180;
  // Image search results: prefer SVG/PNG, penalize JPG
  const u = (url || "").toLowerCase();
  if (context === "bing-transparent") return u.endsWith(".svg") ? 175 : u.endsWith(".png") ? 165 : 140;
  if (context === "google-transparent") return u.endsWith(".svg") ? 170 : u.endsWith(".png") ? 160 : 135;
  if (context === "duckduckgo-transparent") return u.endsWith(".svg") ? 165 : u.endsWith(".png") ? 155 : 130;
  let score = 0;
  if (/logo|brand|wordmark/.test(u)) score += 40;
  if (context === "og:image") score += 30;
  if (context === "apple-touch-icon") score += 25;
  if (u.endsWith(".svg")) score += 20;
  if (u.endsWith(".png")) score += 10;
  if (/hero|banner|background|bg|photo|stock|cover/.test(u)) score -= 20;
  if (/\.jpe?g$/.test(u)) score -= 5;
  return score;
}

async function scrapeWebsite(domain, name, add) {
  const baseUrl = `https://${domain}`;
  let html = "", finalUrl = baseUrl;
  try {
    const r = await axios.get(baseUrl, { timeout: 8000, maxRedirects: 5, httpsAgent, headers: { "User-Agent": "Mozilla/5.0 Chrome/120", Accept: "text/html" } });
    html = r.data; finalUrl = r.request?.res?.responseUrl || baseUrl;
  } catch {
    try { const r = await axios.get(`http://${domain}`, { timeout: 8000, maxRedirects: 5, headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } }); html = r.data; finalUrl = r.request?.res?.responseUrl || `http://${domain}`; } catch {}
  }
  if (!html) return;

  // If redirected to a different domain, only look for company-name-specific images
  try {
    const finalHost = new URL(finalUrl).hostname.replace(/^www\./, "");
    const origHost = domain.replace(/^www\./, "");
    if (finalHost !== origHost) {
      const slug = (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (slug) {
        const $ = cheerio.load(html);
        $("img").each((_, el) => {
          const src = $(el).attr("src") || ""; const alt = ($(el).attr("alt") || "").toLowerCase(); const cls = ($(el).attr("class") || "").toLowerCase();
          if ((src + alt + cls).includes(slug)) add(resolveUrl(finalUrl, src), "logo-attr", `Brand match: ${alt || cls || src}`);
        });
      }
      return;
    }
  } catch {}

  const $ = cheerio.load(html);
  const ogImage = $('meta[property="og:image"]').attr("content");
  if (ogImage) add(resolveUrl(finalUrl, ogImage), "og:image", "OG Image");
  $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => add(resolveUrl(finalUrl, $(el).attr("href")), "apple-touch-icon", "Apple Touch Icon"));
  $('link[rel~="icon"]').each((_, el) => { const href = $(el).attr("href"); if (href && !href.endsWith(".ico")) add(resolveUrl(finalUrl, href), "icon", "Site Icon"); });
  $("header, nav, [role='banner'], .header, .navbar, .nav, #header, #navbar").each((_, section) => {
    $(section).find("img, svg").each((_, el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === "img") { const src = $(el).attr("src"); const r = resolveUrl(finalUrl, src); if (r) add(r, "header-img", `Header: ${$(el).attr("alt") || $(el).attr("class") || "img"}`); }
      if (tag === "svg") { const svgHtml = $.html(el); if (svgHtml && svgHtml.length > 100 && svgHtml.length < 80000) add(`data:image/svg+xml;base64,${Buffer.from(svgHtml).toString("base64")}`, "inline-svg", "Inline SVG (header)"); }
    });
  });
  $("img").each((_, el) => {
    const src = $(el).attr("src") || ""; const alt = ($(el).attr("alt") || "").toLowerCase(); const cls = ($(el).attr("class") || "").toLowerCase(); const id = ($(el).attr("id") || "").toLowerCase();
    if (/logo|brand|wordmark/.test(src + alt + cls + id)) add(resolveUrl(finalUrl, src), "logo-attr", `Logo attr: ${alt || cls || id}`);
  });
  add(`https://${domain}/favicon.ico`, "favicon", "Favicon");
}

async function fetchLogosCandidates(domain, name) {
  const candidates = [];
  const seen = new Set();
  const add = (url, context, label) => {
    if (!url || seen.has(url) || url.startsWith("data:image/gif")) return;
    seen.add(url);
    candidates.push({ url, context, label, score: scoreCandidate(url, context) });
  };

  const [clearbitUrl, brandfetchUrl, wikiUrl, bingUrls, googleUrls, ddgUrls] = await Promise.all([
    fetchFromClearbit(domain),
    fetchFromBrandfetch(domain),
    name ? fetchFromWikipedia(name) : Promise.resolve(null),
    name ? fetchFromBingImages(name) : Promise.resolve([]),
    name ? fetchFromGoogleImages(name) : Promise.resolve([]),
    name ? fetchFromDuckDuckGo(name) : Promise.resolve([]),
  ]);

  if (clearbitUrl) add(clearbitUrl, "clearbit", "Clearbit");
  if (brandfetchUrl) add(brandfetchUrl, "brandfetch", "Brandfetch");
  if (wikiUrl) add(wikiUrl, "wikipedia", "Wikipedia");
  (bingUrls || []).forEach((u, i) => add(u, "bing-transparent", `Bing #${i + 1}`));
  (googleUrls || []).forEach((u, i) => add(u, "google-transparent", `Google Images #${i + 1}`));
  (ddgUrls || []).forEach((u, i) => add(u, "duckduckgo-transparent", `DuckDuckGo #${i + 1}`));

  await scrapeWebsite(domain, name, add);

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 15);
  const highConfidence = top.length > 0 && ["clearbit", "brandfetch", "wikipedia"].includes(top[0].context);
  return { candidates: top, highConfidence };
}

app.get("/api/cache", (req, res) => res.json(loadDB()));

app.post("/api/resolve-domain", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const db = loadDB(); const key = name.toLowerCase().trim();
  if (db[key]) return res.json({ domain: db[key].domain, fromCache: true });
  res.json({ domain: await resolveDomain(name), fromCache: false });
});

app.post("/api/fetch-logos", async (req, res) => {
  const { domain, name } = req.body;
  if (!domain) return res.status(400).json({ error: "domain required" });
  const db = loadDB(); const key = (name || domain).toLowerCase().trim();
  if (db[key]) return res.json({ fromCache: true, cached: db[key], candidates: [] });
  res.json({ fromCache: false, ...(await fetchLogosCandidates(domain, name)) });
});

app.post("/api/cache-logo", async (req, res) => {
  const { name, domain, imageUrl } = req.body;
  if (!name || !domain) return res.status(400).json({ error: "name and domain required" });
  const key = name.toLowerCase().trim(); const safeName = key.replace(/[^a-z0-9]/g, "_");
  try {
    let inputBuffer;
    if (imageUrl.startsWith("data:")) { inputBuffer = Buffer.from(imageUrl.replace(/^data:[^;]+;base64,/, ""), "base64"); }
    else { const r = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 8000, httpsAgent, headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } }); inputBuffer = Buffer.from(r.data); }
    const filename = `${safeName}.png`; const filepath = path.join(CACHE_DIR, filename);
    fs.writeFileSync(filepath, await toFinalBuffer(inputBuffer));
    const db = loadDB(); db[key] = { name, domain, cachedPath: `/cached-logos/${filename}`, savedAt: new Date().toISOString() }; saveDB(db);
    res.json({ success: true, cachedPath: `/cached-logos/${filename}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/download-png", async (req, res) => {
  const { imageUrl, name } = req.body;
  try {
    let inputBuffer;
    if (imageUrl.startsWith("data:")) { inputBuffer = Buffer.from(imageUrl.replace(/^data:[^;]+;base64,/, ""), "base64"); }
    else { const r = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 8000, httpsAgent, headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } }); inputBuffer = Buffer.from(r.data); }
    const pngBuffer = await toFinalBuffer(inputBuffer);
    const safeName = (name || "logo").replace(/[^a-z0-9]/gi, "_");
    res.setHeader("Content-Type", "image/png"); res.setHeader("Content-Disposition", `attachment; filename="${safeName}.png"`); res.send(pngBuffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/bulk-download", async (req, res) => {
  const JSZip = require("jszip"); const { companies } = req.body; const zip = new JSZip();
  for (const { name, cachedPath } of companies) {
    try { const fp = path.join(__dirname, cachedPath); if (fs.existsSync(fp)) zip.file(`${name.replace(/[^a-z0-9]/gi, "_")}.png`, fs.readFileSync(fp)); } catch {}
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", 'attachment; filename="logos.zip"'); res.send(buf);
});

app.listen(PORT, () => console.log(`✅ Logo Tool backend running at http://localhost:${PORT}`));
