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

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// ── Source 1: Clearbit – transparent logos, very reliable ─────────────────────
async function fetchFromClearbit(domain) {
  const url = `https://logo.clearbit.com/${domain}?size=512`;
  try {
    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 6000,
      validateStatus: s => s === 200,
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
    if (resp.data && resp.data.length > 500) return url;
  } catch {}
  return null;
}

// ── Source 2: Wikipedia infobox logo ──────────────────────────────────────────
async function fetchFromWikipedia(companyName) {
  try {
    const searchResp = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: { action: "query", list: "search", srsearch: companyName, format: "json", srlimit: 3 },
      timeout: 7000,
    });
    const results = searchResp.data?.query?.search;
    if (!results?.length) return null;

    const pageTitle = results[0].title;
    const pageResp = await axios.get("https://en.wikipedia.org/w/api.php", {
      params: {
        action: "query", prop: "pageimages", titles: pageTitle,
        format: "json", pithumbsize: 512, piprop: "original|thumbnail",
      },
      timeout: 7000,
    });
    const page = Object.values(pageResp.data?.query?.pages || {})[0];
    const src = page?.original?.source || page?.thumbnail?.source;
    if (!src) return null;
    // Accept SVG and PNG (logos); skip JPG which is usually a photo
    if (/\.(svg|png)/i.test(src)) return src;
  } catch {}
  return null;
}

// ── Source 3: DuckDuckGo images with transparent filter ───────────────────────
async function fetchFromDuckDuckGo(companyName) {
  try {
    const query = `${companyName} logo`;
    const initResp = await axios.get("https://duckduckgo.com/", {
      params: { q: query, iax: "images", ia: "images" },
      headers: BROWSER_HEADERS,
      timeout: 8000,
    });
    const vqdMatch = initResp.data.match(/vqd=["']?([^"'&\s]+)["']?/);
    if (!vqdMatch) return [];
    const imgResp = await axios.get("https://duckduckgo.com/i.js", {
      params: { q: query, vqd: vqdMatch[1], f: "type:transparent", p: 1 },
      headers: { ...BROWSER_HEADERS, Referer: "https://duckduckgo.com/" },
      timeout: 8000,
    });
    return (imgResp.data?.results || []).slice(0, 6).map(r => r.image).filter(Boolean);
  } catch { return []; }
}

// ── Source 4: Google Images with transparent filter ───────────────────────────
async function fetchFromGoogleImages(companyName) {
  try {
    const query = `${companyName} logo`;
    const resp = await axios.get("https://www.google.com/search", {
      params: { q: query, tbm: "isch", tbs: "ic:trans", hl: "en", gl: "us" },
      headers: {
        ...BROWSER_HEADERS,
        "Cookie": "CONSENT=YES+cb.20210328-17-p0.en+FX+412; SOCS=CAISHAgBEhIaAB;",
      },
      timeout: 10000,
    });
    const urls = [];
    // Google embeds full image URLs in JSON blobs within script tags
    const re = /"(https?:\/\/(?!(?:www\.google|encrypted-tbn|gstatic))[^"]+\.(?:png|svg)(?:\?[^"]*)?)"(?=[^}]*"width")/g;
    let m;
    while ((m = re.exec(resp.data)) !== null) {
      const u = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&");
      if (!urls.includes(u)) urls.push(u);
      if (urls.length >= 8) break;
    }
    // Broader fallback: any PNG/SVG URL that isn't a Google asset
    if (urls.length === 0) {
      const re2 = /"(https?:\/\/(?!(?:www\.google|encrypted-tbn|gstatic|doubleclick))[^"]{10,300}\.(?:png|svg)[^"]*)"/g;
      while ((m = re2.exec(resp.data)) !== null) {
        const u = m[1];
        if (!urls.includes(u)) urls.push(u);
        if (urls.length >= 6) break;
      }
    }
    return urls;
  } catch { return []; }
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
      await axios.head(`https://${domain}`, { timeout: 4000, maxRedirects: 3, httpsAgent: new https.Agent({ rejectUnauthorized: false }) });
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
  let score = 0;
  const u = (url || "").toLowerCase();
  if (context === "clearbit") return 200;
  if (context === "wikipedia") return 180;
  if (context === "google-transparent") score += 120;
  if (context === "duckduckgo-transparent") score += 100;
  if (/logo|brand|wordmark/.test(u)) score += 40;
  if (context === "og:image") score += 30;
  if (context === "apple-touch-icon") score += 25;
  if (u.endsWith(".svg")) score += 20;
  if (u.endsWith(".png")) score += 10;
  if (/hero|banner|background|bg|photo|stock|cover/.test(u)) score -= 20;
  if (/\.jpe?g$/.test(u)) score -= 5;
  return score;
}

async function fetchLogosCandidates(domain, name) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (url, context, label) => {
    if (!url || seen.has(url) || url.startsWith("data:image/gif")) return;
    seen.add(url);
    candidates.push({ url, context, label, score: scoreCandidate(url, context) });
  };

  // Run all premium sources in parallel
  const [clearbitUrl, wikiUrl, ddgUrls, googleUrls] = await Promise.all([
    fetchFromClearbit(domain),
    name ? fetchFromWikipedia(name) : Promise.resolve(null),
    name ? fetchFromDuckDuckGo(name) : Promise.resolve([]),
    name ? fetchFromGoogleImages(name) : Promise.resolve([]),
  ]);

  if (clearbitUrl) addCandidate(clearbitUrl, "clearbit", "Clearbit (transparent)");
  if (wikiUrl) addCandidate(wikiUrl, "wikipedia", "Wikipedia logo");
  (googleUrls || []).forEach((u, i) => addCandidate(u, "google-transparent", `Google Images #${i + 1}`));
  (ddgUrls || []).forEach((u, i) => addCandidate(u, "duckduckgo-transparent", `DuckDuckGo transparent #${i + 1}`));

  // Website scraping as final fallback
  const baseUrl = `https://${domain}`;
  let html = "";
  try {
    const resp = await axios.get(baseUrl, { timeout: 8000, maxRedirects: 5, httpsAgent: new https.Agent({ rejectUnauthorized: false }), headers: { "User-Agent": "Mozilla/5.0 Chrome/120", Accept: "text/html" } });
    html = resp.data;
  } catch {
    try { const resp = await axios.get(`http://${domain}`, { timeout: 8000, maxRedirects: 5, headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } }); html = resp.data; } catch {}
  }
  if (html) {
    const $ = cheerio.load(html);
    const ogImage = $('meta[property="og:image"]').attr("content");
    if (ogImage) addCandidate(resolveUrl(baseUrl, ogImage), "og:image", "OG Image");
    $('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').each((_, el) => addCandidate(resolveUrl(baseUrl, $(el).attr("href")), "apple-touch-icon", "Apple Touch Icon"));
    $('link[rel~="icon"]').each((_, el) => { const href = $(el).attr("href"); if (href && !href.endsWith(".ico")) addCandidate(resolveUrl(baseUrl, href), "icon", "Site Icon"); });
    $("header, nav, [role='banner'], .header, .navbar, .nav, #header, #navbar").each((_, section) => {
      $(section).find("img, svg").each((_, el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === "img") { const src = $(el).attr("src"); const resolved = resolveUrl(baseUrl, src); if (resolved) addCandidate(resolved, "header-img", `Header: ${$(el).attr("alt") || $(el).attr("class") || "img"}`); }
        if (tag === "svg") { const svgHtml = $.html(el); if (svgHtml && svgHtml.length > 100 && svgHtml.length < 80000) { const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgHtml).toString("base64")}`; if (!seen.has(dataUrl)) { seen.add(dataUrl); candidates.push({ url: dataUrl, context: "inline-svg", label: "Inline SVG (header)", score: 50 }); } } }
      });
    });
    $("img").each((_, el) => {
      const src = $(el).attr("src") || ""; const alt = ($(el).attr("alt") || "").toLowerCase(); const cls = ($(el).attr("class") || "").toLowerCase(); const id = ($(el).attr("id") || "").toLowerCase();
      if (/logo|brand|wordmark/.test(src + alt + cls + id)) addCandidate(resolveUrl(baseUrl, src), "logo-attr", `Logo attr: ${alt || cls || id}`);
    });
    addCandidate(`https://${domain}/favicon.ico`, "favicon", "Favicon");
  }

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 15);
  const highConfidence = top.length > 0 && ["clearbit", "wikipedia", "google-transparent"].includes(top[0].context);
  return { candidates: top, highConfidence };
}

app.get("/api/cache", (req, res) => res.json(loadDB()));

app.post("/api/resolve-domain", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const db = loadDB(); const key = name.toLowerCase().trim();
  if (db[key]) return res.json({ domain: db[key].domain, fromCache: true });
  const domain = await resolveDomain(name);
  res.json({ domain, fromCache: false });
});

app.post("/api/fetch-logos", async (req, res) => {
  const { domain, name } = req.body;
  if (!domain) return res.status(400).json({ error: "domain required" });
  const db = loadDB(); const key = (name || domain).toLowerCase().trim();
  if (db[key]) return res.json({ fromCache: true, cached: db[key], candidates: [] });
  const result = await fetchLogosCandidates(domain, name);
  res.json({ fromCache: false, ...result });
});

app.post("/api/cache-logo", async (req, res) => {
  const { name, domain, imageUrl } = req.body;
  if (!name || !domain) return res.status(400).json({ error: "name and domain required" });
  const key = name.toLowerCase().trim(); const safeName = key.replace(/[^a-z0-9]/g, "_");
  let inputBuffer;
  try {
    if (imageUrl.startsWith("data:")) { inputBuffer = Buffer.from(imageUrl.replace(/^data:[^;]+;base64,/, ""), "base64"); }
    else { const resp = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 8000, httpsAgent: new https.Agent({ rejectUnauthorized: false }), headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } }); inputBuffer = Buffer.from(resp.data); }
    const filename = `${safeName}.png`; const filepath = path.join(CACHE_DIR, filename);
    await sharp(inputBuffer, { density: 300 }).png().resize(512, 512, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toFile(filepath);
    const db = loadDB(); db[key] = { name, domain, cachedPath: `/cached-logos/${filename}`, savedAt: new Date().toISOString() }; saveDB(db);
    res.json({ success: true, cachedPath: `/cached-logos/${filename}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/download-png", async (req, res) => {
  const { imageUrl, name } = req.body;
  try {
    let inputBuffer;
    if (imageUrl.startsWith("data:")) { inputBuffer = Buffer.from(imageUrl.replace(/^data:[^;]+;base64,/, ""), "base64"); }
    else { const resp = await axios.get(imageUrl, { responseType: "arraybuffer", timeout: 8000, httpsAgent: new https.Agent({ rejectUnauthorized: false }), headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } }); inputBuffer = Buffer.from(resp.data); }
    const pngBuffer = await sharp(inputBuffer, { density: 300 }).png().resize(512, 512, { fit: "inside", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toBuffer();
    const safeName = (name || "logo").replace(/[^a-z0-9]/gi, "_");
    res.setHeader("Content-Type", "image/png"); res.setHeader("Content-Disposition", `attachment; filename="${safeName}.png"`); res.send(pngBuffer);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/bulk-download", async (req, res) => {
  const JSZip = require("jszip"); const { companies } = req.body; const zip = new JSZip();
  for (const { name, cachedPath } of companies) {
    try { const filepath = path.join(__dirname, cachedPath); if (fs.existsSync(filepath)) zip.file(`${name.replace(/[^a-z0-9]/gi, "_")}.png`, fs.readFileSync(filepath)); } catch {}
  }
  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  res.setHeader("Content-Type", "application/zip"); res.setHeader("Content-Disposition", 'attachment; filename="logos.zip"'); res.send(zipBuffer);
});

app.listen(PORT, () => console.log(`✅ Logo Tool backend running at http://localhost:${PORT}`));
