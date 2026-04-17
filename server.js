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
  const c = (context || "").toLowerCase();
  if (/logo|brand|wordmark/.test(u) || /logo|brand|wordmark/.test(c)) score += 40;
  if (context === "og:image") score += 30;
  if (context === "apple-touch-icon") score += 25;
  if (u.endsWith(".svg")) score += 20;
  if (u.endsWith(".png")) score += 10;
  if (/hero|banner|background|bg|photo|stock|cover/.test(u)) score -= 20;
  if (/\.jpe?g$/.test(u)) score -= 5;
  return score;
}

async function fetchLogosCandidates(domain) {
  const baseUrl = `https://${domain}`;
  const candidates = [];
  const seen = new Set();
  const addCandidate = (url, context, label) => {
    if (!url || seen.has(url) || url.startsWith("data:image/gif")) return;
    seen.add(url);
    candidates.push({ url, context, label, score: scoreCandidate(url, context) });
  };
  let html = "";
  try {
    const resp = await axios.get(baseUrl, { timeout: 8000, maxRedirects: 5, httpsAgent: new https.Agent({ rejectUnauthorized: false }), headers: { "User-Agent": "Mozilla/5.0 Chrome/120", Accept: "text/html" } });
    html = resp.data;
  } catch {
    try { const resp = await axios.get(`http://${domain}`, { timeout: 8000, maxRedirects: 5, headers: { "User-Agent": "Mozilla/5.0 Chrome/120" } }); html = resp.data; }
    catch { return { candidates: [], error: "Could not fetch homepage" }; }
  }
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
  candidates.sort((a, b) => b.score - a.score);
  return { candidates: candidates.slice(0, 12) };
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
  const result = await fetchLogosCandidates(domain);
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

app.listen(PORT, () => console.log(`âœ… Logo Tool backend running at http://localhost:${PORT}`));
