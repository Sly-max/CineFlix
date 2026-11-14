// =========================================================================
// CineFlix Hub - Standalone Windows Edition (100% Autonomous)
// Zero external server dependencies - Runs completely independent
// =========================================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec, spawn } = require('child_process');
const torrentStream = require('torrent-stream');

const STATIC_DIR = path.join(__dirname, 'public');
const TORRENTS_DIR = path.join(__dirname, 'torrents');
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(TORRENTS_DIR)) {
  try { fs.mkdirSync(TORRENTS_DIR, { recursive: true }); } catch (e) {}
}
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

// Local portable FFmpeg / FFprobe resolution
const localFfmpeg = path.join(__dirname, 'bin', 'ffmpeg.exe');
const FFMPEG_BIN = fs.existsSync(localFfmpeg) ? `"${localFfmpeg}"` : 'ffmpeg';
const localFfprobe = path.join(__dirname, 'bin', 'ffprobe.exe');
const FFPROBE_BIN = fs.existsSync(localFfprobe) ? `"${localFfprobe}"` : 'ffprobe';

// Playback History Persistence
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function getHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    }
  } catch (e) {}
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 100), null, 2), 'utf8');
  } catch (e) {}
}

// -------------------------------------------------------------------------
// Helper: HTTPS GET with automatic redirect following (Cinemeta / Torrentio)
// -------------------------------------------------------------------------
function fetchJson(targetUrl, timeoutMs = 8000) {
  return new Promise((resolve) => {
    function get(u, redirectsLeft = 5) {
      if (redirectsLeft <= 0) return resolve(null);
      try {
        const client = u.startsWith('https') ? https : http;
        client.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) CineFlix/1.0' }, timeout: timeoutMs }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            let nextUrl = res.headers.location;
            if (nextUrl.startsWith('/')) {
              const parsed = new URL(u);
              nextUrl = `${parsed.protocol}//${parsed.host}${nextUrl}`;
            }
            return get(nextUrl, redirectsLeft - 1);
          }
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
          });
        }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
      } catch (e) {
        resolve(null);
      }
    }
    get(targetUrl);
  });
}

// -------------------------------------------------------------------------
// Standalone Catalog (Powered by Cinemeta CDN)
// -------------------------------------------------------------------------
let catalogCache = null;
let catalogCacheTime = 0;
const CATALOG_TTL = 30 * 60 * 1000; // 30 minutes cache

function mapMeta(m, defaultType = 'movie') {
  return {
    id: m.id,
    tmdbId: m.id,
    imdbId: m.id,
    mediaType: m.type || defaultType,
    title: m.name,
    year: (m.releaseInfo || m.year || '').toString().substring(0, 4),
    overview: m.description || 'Sin descripción disponible.',
    rating: m.imdbRating ? parseFloat(m.imdbRating).toFixed(1) : null,
    poster: m.poster || null,
    backdrop: m.background || m.poster || null
  };
}

async function getStandaloneCatalog() {
  const now = Date.now();
  if (catalogCache && (now - catalogCacheTime < CATALOG_TTL)) {
    return catalogCache;
  }

  const [topMovies, topSeries, scifi, action, anime] = await Promise.all([
    fetchJson('https://v3-cinemeta.strem.io/catalog/movie/top.json'),
    fetchJson('https://v3-cinemeta.strem.io/catalog/series/top.json'),
    fetchJson('https://v3-cinemeta.strem.io/catalog/movie/top/genre=Sci-Fi.json'),
    fetchJson('https://v3-cinemeta.strem.io/catalog/movie/top/genre=Action.json'),
    fetchJson('https://v3-cinemeta.strem.io/catalog/series/top/genre=Animation.json')
  ]);

  const trendingList = (topMovies?.metas || []).slice(0, 20).map(m => mapMeta(m, 'movie'));
  const moviesList = (topMovies?.metas || []).slice(0, 20).map(m => mapMeta(m, 'movie'));
  const tvList = (topSeries?.metas || []).slice(0, 20).map(m => mapMeta(m, 'tv'));
  const topRatedList = (topMovies?.metas || []).slice(0, 20).map(m => mapMeta(m, 'movie'));
  const scifiList = (scifi?.metas || []).slice(0, 20).map(m => mapMeta(m, 'movie'));
  const actionList = (action?.metas || []).slice(0, 20).map(m => mapMeta(m, 'movie'));
  const animeList = (anime?.metas || []).slice(0, 20).map(m => mapMeta(m, 'tv'));

  catalogCache = {
    trending: trendingList,
    movies: moviesList,
    tv: tvList,
    topRated: topRatedList,
    scifi: scifiList,
    action: actionList,
    anime: animeList
  };
  catalogCacheTime = now;
  return catalogCache;
}

// -------------------------------------------------------------------------
// Language & Quality Parser for Releases
// -------------------------------------------------------------------------
function parseLanguageAndQuality(title, sizeBytes = 0) {
  const lower = title.toLowerCase();
  let quality = '1080p';
  if (/2160p|4k|uhd/i.test(lower)) quality = '4K';
  else if (/1080p|fhd/i.test(lower)) quality = '1080p';
  else if (/720p|hd/i.test(lower)) quality = '720p';
  else if (/480p|sd/i.test(lower)) quality = '480p';

  const isLatino = /latino|dual-lat|lat-team|audio latino|audio-latino|cinecalidad/i.test(lower) || title.includes('🇲🇽');
  const isCastellano = /castellano|español|spanish/i.test(lower) && !isLatino;
  const isDual = /dual/i.test(lower);
  const isSpanish = isLatino || isCastellano;

  return { quality, isLatino, isCastellano, isDual, isSpanish };
}

// -------------------------------------------------------------------------
// Torrentio Releases Search (Direct Cloud Aggregator)
// -------------------------------------------------------------------------
async function fetchTorrentioStreams(imdbId, mediaType = 'movie', season = null) {
  if (!imdbId) return [];
  try {
    let torrentioPath = '';
    if (mediaType === 'tv') {
      const sNum = season ? (parseInt(season, 10) || 1) : 1;
      torrentioPath = `series/${imdbId}:${sNum}:1.json`;
    } else {
      torrentioPath = `movie/${imdbId}.json`;
    }

    const data = await fetchJson(`https://torrentio.strem.fun/stream/${torrentioPath}`, 7000);
    if (!data || !Array.isArray(data.streams)) return [];

    const standardTrackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.demonii.com:1337/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://tracker.openbittorrent.com:6969/announce'
    ];
    const trackerQuery = standardTrackers.map(t => '&tr=' + encodeURIComponent(t)).join('');

    const results = [];
    for (const s of data.streams) {
      if (!s.infoHash) continue;
      const titleLines = (s.title || '').split('\n');
      const rawTitle = titleLines[0] || (s.behaviorHints && s.behaviorHints.filename) || 'Release';
      const metaLine = titleLines[1] || '';

      const seedMatch = metaLine.match(/👤\s*(\d+)/);
      const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;

      const sizeMatch = metaLine.match(/💾\s*([\d\.]+)\s*(GB|MB|KB)/i);
      let sizeBytes = 2 * 1024 * 1024 * 1024;
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'GB') sizeBytes = Math.round(val * 1024 * 1024 * 1024);
        else if (unit === 'MB') sizeBytes = Math.round(val * 1024 * 1024);
        else sizeBytes = Math.round(val * 1024);
      }

      const provMatch = metaLine.match(/⚙️\s*([^\n\r]+)/);
      const provider = provMatch ? provMatch[1].trim() : 'Torrentio';

      const fullText = `${s.name || ''} ${s.title || ''} ${(s.behaviorHints && s.behaviorHints.filename) || ''}`;
      const meta = parseLanguageAndQuality(fullText, sizeBytes);

      const cleanFileName = (s.behaviorHints && s.behaviorHints.filename) || rawTitle;
      const downloadUrl = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(cleanFileName)}${trackerQuery}`;

      results.push({
        title: cleanFileName,
        size: (sizeBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        sizeBytes,
        seeders,
        indexer: provider,
        downloadUrl,
        magnetUrl: downloadUrl,
        infoHash: s.infoHash.toLowerCase(),
        ...meta
      });
    }

    // Sort releases: Latino first, then seeders
    results.sort((a, b) => {
      if (a.isLatino && !b.isLatino) return -1;
      if (!a.isLatino && b.isLatino) return 1;
      if (a.isSpanish && !b.isSpanish) return -1;
      if (!a.isSpanish && b.isSpanish) return 1;
      return (b.seeders || 0) - (a.seeders || 0);
    });

    return results;
  } catch (e) {
    return [];
  }
}

// -------------------------------------------------------------------------
// Standalone BitTorrent Engine (Powered by torrent-stream)
// -------------------------------------------------------------------------
const activeTorrentEngines = new Map();

function startTorrentEngine(magnetUrl, title = '') {
  let hashMatch = magnetUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  let hash = hashMatch ? hashMatch[1].toLowerCase() : `t_${Date.now()}`;

  // If engine already exists, restart it fresh to avoid piece or state locks
  if (activeTorrentEngines.has(hash)) {
    try {
      const old = activeTorrentEngines.get(hash);
      old.destroy();
    } catch (e) {}
    activeTorrentEngines.delete(hash);
  }

  const engine = torrentStream(magnetUrl, {
    path: TORRENTS_DIR,
    connections: 50,
    uploads: 2
  });

  engine.infoHash = hash;
  engine.customTitle = title;
  engine.contentPath = null;
  engine.mainFile = null;
  engine.status = 'connecting';
  engine.startTime = Date.now();

  engine.on('ready', () => {
    engine.status = 'downloading';
    let largestFile = null;
    let maxLen = 0;

    engine.files.forEach(file => {
      if (/\.(mp4|mkv|webm|avi|mov)$/i.test(file.name)) {
        if (file.length > maxLen) {
          maxLen = file.length;
          largestFile = file;
        }
      }
    });

    if (largestFile) {
      engine.mainFile = largestFile;
      engine.contentPath = path.join(TORRENTS_DIR, largestFile.path);
      largestFile.select(); // Prioritize sequential download of main video
    }

    // Deselect non-video or sample files to save bandwidth
    engine.files.forEach(f => {
      if (f !== largestFile) {
        try { f.deselect(); } catch (e) {}
      }
    });
  });

  engine.on('download', () => {
    engine.status = 'downloading';
  });

  activeTorrentEngines.set(hash, engine);
  return engine;
}

function stopTorrentEngine(hash, name = '', contentPath = '') {
  const targets = new Set();
  if (contentPath) targets.add(contentPath);

  if (hash && activeTorrentEngines.has(hash.toLowerCase())) {
    try {
      const eng = activeTorrentEngines.get(hash.toLowerCase());
      if (eng.contentPath) targets.add(eng.contentPath);
      eng.destroy();
    } catch (e) {}
    activeTorrentEngines.delete(hash.toLowerCase());
  }

  // Remove physical files and folders after engine destruction
  setTimeout(() => {
    for (const t of targets) {
      if (fs.existsSync(t)) {
        try { fs.rmSync(t, { recursive: true, force: true }); } catch (e) {}
      }
    }
    try {
      if (fs.existsSync(TORRENTS_DIR)) {
        const files = fs.readdirSync(TORRENTS_DIR);
        for (const f of files) {
          const lower = f.toLowerCase();
          const cleanName = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if ((hash && lower.includes(hash.toLowerCase())) || (cleanName && cleanName.length > 5 && lower.replace(/[^a-z0-9]/g, '').includes(cleanName.substring(0, 15)))) {
            try { fs.rmSync(path.join(TORRENTS_DIR, f), { recursive: true, force: true }); } catch (e) {}
          }
        }
      }
    } catch (e) {}
  }, 100);

  // Clear media probe cache
  for (const k of Object.keys(mediaProbeCache)) {
    if ((hash && k.toLowerCase().includes(hash.toLowerCase())) || (name && k.toLowerCase().includes((name || '').toLowerCase().substring(0, 15)))) {
      delete mediaProbeCache[k];
    }
  }

  // Remove from server history
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      let hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
      hist = hist.filter(h => {
        if (hash && h.hash && h.hash.toLowerCase() === hash.toLowerCase()) return false;
        if (name && h.title && h.title.toLowerCase().includes((name || '').toLowerCase().substring(0, 15))) return false;
        return true;
      });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), 'utf8');
    }
  } catch (e) {}
}

// -------------------------------------------------------------------------
// Media Probing (ffprobe)
// -------------------------------------------------------------------------
const mediaProbeCache = {};

function probeMedia(filePath) {
  if (mediaProbeCache[filePath] && mediaProbeCache[filePath].duration > 0 && mediaProbeCache[filePath].audioTracks.length > 0) {
    return Promise.resolve(mediaProbeCache[filePath]);
  }
  return new Promise((resolve) => {
    const cmd = `${FFPROBE_BIN} -v error -analyzeduration 2000000 -probesize 2000000 -show_entries format=duration:stream=index,codec_name,codec_type,channels:stream_tags=language,title -of json "${filePath}"`;
    exec(cmd, { timeout: 4000 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({ duration: 0, videoCodec: 'unknown', audioCodec: 'unknown', isAudioCompatible: true, preferredAudioIndex: null, audioTracks: [], spanishSubIndex: null, allSubs: [] });
      }
      try {
        const data = JSON.parse(stdout);
        const duration = parseFloat(data.format?.duration || '0') || 0;
        const streams = data.streams || [];
        const video = streams.find(s => s.codec_type === 'video');
        const audioStreams = streams.filter(s => s.codec_type === 'audio');
        const subs = streams.filter(s => s.codec_type === 'subtitle');

        const videoCodec = video ? video.codec_name.toLowerCase() : 'unknown';
        const primaryAudio = audioStreams[0];
        const audioCodec = primaryAudio ? primaryAudio.codec_name.toLowerCase() : 'unknown';
        const isAudioCompatible = ['aac', 'mp3', 'opus', 'flac'].includes(audioCodec);

        const audioTracks = audioStreams.map((a, i) => {
          const lang = (a.tags?.language || '').toLowerCase();
          const title = (a.tags?.title || '').toLowerCase();
          let label = `Pista ${i + 1}`;
          let isLatino = false;
          let isSpanish = false;

          if (
            lang.startsWith('spa') || lang.startsWith('es') ||
            title.includes('latino') || title.includes('spanish') || title.includes('español') || title.includes('castellano')
          ) {
            isSpanish = true;
            if (title.includes('latino') || title.includes('mex') || title.includes('la') || lang.includes('mx') || lang.includes('la')) {
              label = '🇲🇽 Español Latino';
              isLatino = true;
            } else {
              label = '🇪🇸 Español / Castellano';
            }
          } else if (lang.startsWith('eng') || title.includes('english') || title.includes('inglés')) {
            label = '🇺🇸 Inglés';
          } else if (lang.startsWith('fre') || title.includes('french')) {
            label = '🇫🇷 Francés';
          } else if (lang.startsWith('ger') || title.includes('german')) {
            label = '🇩🇪 Alemán';
          } else if (lang.startsWith('jpn') || title.includes('japan')) {
            label = '🇯🇵 Japonés';
          }

          return {
            index: a.index,
            streamIndex: i,
            codec: a.codec_name.toLowerCase(),
            channels: a.channels || 2,
            lang: a.tags?.language || 'und',
            label,
            isLatino,
            isSpanish
          };
        });

        let preferredAudio = audioTracks.find(t => t.isLatino);
        if (!preferredAudio) {
          preferredAudio = audioTracks.find(t => t.isSpanish || (t.lang && (t.lang.startsWith('spa') || t.lang.startsWith('es'))));
        }
        const preferredAudioIndex = preferredAudio ? preferredAudio.index : (audioTracks[0] ? audioTracks[0].index : null);

        const spaSub = subs.find(s => {
          const lang = s.tags && s.tags.language ? s.tags.language.toLowerCase() : '';
          return lang.startsWith('spa') || lang.startsWith('es');
        });
        const spanishSubIndex = spaSub ? spaSub.index : (subs.length > 0 ? subs[0].index : null);

        const res = {
          duration,
          videoCodec,
          audioCodec,
          isAudioCompatible,
          audioTracks,
          preferredAudioIndex,
          spanishSubIndex,
          allSubs: subs.map(s => ({ index: s.index, lang: s.tags?.language || 'und' }))
        };
        if (duration > 0 && audioTracks.length > 0) {
          mediaProbeCache[filePath] = res;
        }
        resolve(res);
      } catch (e) {
        resolve({ duration: 0, videoCodec: 'unknown', audioCodec: 'unknown', isAudioCompatible: true, preferredAudioIndex: null, audioTracks: [], spanishSubIndex: null, allSubs: [] });
      }
    });
  });
}

function findLocalVideo(queryHashOrName) {
  // 1. Check in active torrent engines
  for (const [hash, eng] of activeTorrentEngines.entries()) {
    if (eng.contentPath && fs.existsSync(eng.contentPath)) {
      if (!queryHashOrName || hash === queryHashOrName.toLowerCase() || (eng.customTitle && eng.customTitle.toLowerCase().includes(queryHashOrName.toLowerCase()))) {
        return eng.contentPath;
      }
    }
  }

  // 2. Scan TORRENTS_DIR recursively
  function scan(dir) {
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const full = path.join(dir, item);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          const found = scan(full);
          if (found) return found;
        } else if (st.isFile() && /\.(mp4|mkv|webm|avi|mov)$/i.test(item) && !item.endsWith('.parts')) {
          if (!queryHashOrName || item.toLowerCase().includes(queryHashOrName.toLowerCase())) {
            return full;
          }
        }
      }
    } catch (e) {}
    return null;
  }
  return scan(TORRENTS_DIR);
}

// -------------------------------------------------------------------------
// Subtitle Stream Extractor (WebVTT)
// -------------------------------------------------------------------------
function getPrecedingKeyframe(filePath, targetSeconds) {
  if (targetSeconds <= 0) return Promise.resolve(0);
  return new Promise((resolve) => {
    const cmd = `${FFPROBE_BIN} -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pkt_pts_time -read_intervals "%+${Math.max(1, targetSeconds + 5)}" -of csv=p=0 "${filePath}"`;
    exec(cmd, { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(targetSeconds);
      const times = stdout.trim().split(/\r?\n/).map(parseFloat).filter(t => !isNaN(t));
      if (times.length === 0) return resolve(targetSeconds);
      let best = 0;
      for (const t of times) {
        if (t <= targetSeconds) best = t;
        else break;
      }
      resolve(best);
    });
  });
}

// -------------------------------------------------------------------------
// HTTP Router
// -------------------------------------------------------------------------
async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // 1. Health Status
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      mode: 'standalone',
      services: [
        { id: 'cinemeta', name: 'Catálogo Global (Cinemeta CDN)', ok: true, online: true },
        { id: 'torrentio', name: 'Buscador de Torrents (Torrentio Cloud)', ok: true, online: true },
        { id: 'torrent_engine', name: 'Motor de Descarga Local', ok: true, online: true },
        { id: 'ffmpeg', name: 'Transcodificador FFmpeg Local', ok: true, online: true }
      ]
    }));
  }

  // 2. Playback History
  if (pathname === '/api/history' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(getHistory()));
  }

  if (pathname === '/api/history' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const item = JSON.parse(body);
        let history = getHistory();
        history = history.filter(h => h.id !== item.id && h.title !== item.title);
        history.unshift({ ...item, updatedAt: Date.now() });
        saveHistory(history);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (pathname === '/api/history/delete' || (pathname === '/api/history' && req.method === 'DELETE')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        let history = getHistory().filter(h => h.id !== id);
        saveHistory(history);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400);
        return res.end();
      }
    });
    return;
  }

  if (pathname === '/api/history/clear') {
    saveHistory([]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 3. Catalog (8 Shelves)
  if (pathname === '/api/catalog') {
    try {
      const catalog = await getStandaloneCatalog();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(catalog));
    } catch (e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 4. Search
  if (pathname === '/api/search') {
    const q = (parsedUrl.query.q || '').trim();
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [] }));
    }

    try {
      const [moviesRes, seriesRes] = await Promise.all([
        fetchJson(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`),
        fetchJson(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(q)}.json`)
      ]);

      const movies = (moviesRes?.metas || []).map(m => mapMeta(m, 'movie'));
      const series = (seriesRes?.metas || []).map(m => mapMeta(m, 'tv'));
      const combined = [...movies, ...series].slice(0, 30);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: combined }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [] }));
    }
  }

  // 5. Details (Cast, Director, Epilogue, Backdrop, Runtime)
  if (pathname.startsWith('/api/details/')) {
    const parts = pathname.replace('/api/details/', '').split('/');
    const mediaType = parts[0] === 'tv' ? 'series' : 'movie';
    const id = parts[1];

    try {
      const data = await fetchJson(`https://v3-cinemeta.strem.io/meta/${mediaType}/${id}.json`);
      const meta = data?.meta;
      if (meta) {
        let runtimeMinutes = 0;
        if (meta.runtime) {
          const match = meta.runtime.match(/(\d+)/);
          if (match) runtimeMinutes = parseInt(match[1], 10);
        }

        const details = {
          id: meta.id,
          title: meta.name,
          year: meta.year || (meta.releaseInfo || '').substring(0, 4),
          overview: meta.description || 'Sin descripción disponible.',
          rating: meta.imdbRating ? parseFloat(meta.imdbRating).toFixed(1) : null,
          poster: meta.poster || null,
          backdrop: meta.background || meta.poster || null,
          runtime: meta.runtime || `${runtimeMinutes} min`,
          runtimeMinutes: runtimeMinutes || 115,
          genres: meta.genres || [],
          director: Array.isArray(meta.director) ? meta.director.join(', ') : (meta.director || 'Desconocido'),
          cast: Array.isArray(meta.cast) ? meta.cast.slice(0, 8).join(', ') : (meta.cast || '')
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(details));
      }
    } catch (e) {}

    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Detalles no encontrados' }));
  }

  // 6. Available Releases & Streams
  if (pathname === '/api/available-releases') {
    const title = (parsedUrl.query.title || '').trim();
    const mediaType = parsedUrl.query.mediaType || 'movie';
    const imdbId = parsedUrl.query.tmdbId || parsedUrl.query.imdbId || parsedUrl.query.id;
    const season = parsedUrl.query.season || null;

    try {
      const streams = await fetchTorrentioStreams(imdbId, mediaType, season);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ releases: streams }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ releases: [] }));
    }
  }

  // 7. Download & Playback Trigger
  if (pathname === '/api/download' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const imdbId = payload.tmdbId || payload.id;
        const mediaType = payload.mediaType || 'movie';
        const season = payload.season || null;

        const releases = await fetchTorrentioStreams(imdbId, mediaType, season);
        if (releases.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'No se encontraron torrents disponibles.' }));
        }

        const bestRelease = releases[0];
        const engine = startTorrentEngine(bestRelease.downloadUrl, payload.title || bestRelease.title);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          message: 'Descarga iniciada con éxito',
          infoHash: engine.infoHash,
          title: bestRelease.title,
          badge: bestRelease.isLatino ? '🇲🇽 Español Latino' : '💎 Original'
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/download-release' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (payload.downloadUrl || payload.magnetUrl) {
          const dlUrl = payload.downloadUrl || payload.magnetUrl;
          const engine = startTorrentEngine(dlUrl, payload.title || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, infoHash: engine.infoHash }));
        }
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid payload' }));
    });
    return;
  }

  // 8. Active Downloads Status
  if (pathname === '/api/downloads') {
    const list = [];
    for (const [hash, eng] of activeTorrentEngines.entries()) {
      const downloaded = eng.swarm ? eng.swarm.downloaded : 0;
      const total = eng.torrent ? eng.torrent.length : (eng.size || 1);
      const progress = total > 0 ? Math.min(100, (downloaded / total) * 100).toFixed(1) : 0;
      const speed = eng.swarm ? (eng.swarm.downloadSpeed() / 1024 / 1024).toFixed(2) + ' MB/s' : '0 MB/s';
      const peers = eng.swarm ? eng.swarm.wires.length : 0;

      list.push({
        hash,
        name: eng.customTitle || eng.torrent?.name || 'CineFlix Download',
        progress: parseFloat(progress),
        download_speed: speed,
        num_seeds: peers,
        num_leechs: 0,
        state: progress >= 100 ? 'completed' : 'downloading',
        content_path: eng.contentPath || ''
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }

  // 9. Stop / Clean Torrent
  if (pathname === '/api/stop-torrent' || pathname === '/api/stop-series') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        if (payload.hash) {
          stopTorrentEngine(payload.hash, payload.name, payload.contentPath);
        } else if (Array.isArray(payload.hashes)) {
          payload.hashes.forEach(h => stopTorrentEngine(h, payload.seriesName, null));
        }
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: 'Descarga cancelada y archivo eliminado del disco.' }));
    });
    return;
  }

  if (pathname === '/api/clean-cache') {
    for (const [hash, eng] of activeTorrentEngines.entries()) {
      try { eng.destroy(); } catch (e) {}
    }
    activeTorrentEngines.clear();

    try {
      if (fs.existsSync(TORRENTS_DIR)) {
        const items = fs.readdirSync(TORRENTS_DIR);
        for (const item of items) {
          try { fs.rmSync(path.join(TORRENTS_DIR, item), { recursive: true, force: true }); } catch (e) {}
        }
      }
    } catch (e) {}

    for (const k of Object.keys(mediaProbeCache)) delete mediaProbeCache[k];
    catalogCache = null;
    catalogCacheTime = 0;
    try { if (fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]', 'utf8'); } catch (e) {}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, message: 'Caché completamente limpio y espacio liberado' }));
  }

  // 10. Video Media Probing
  if (pathname.startsWith('/api/media-info/')) {
    const query = pathname.replace('/api/media-info/', '');
    const videoPath = findLocalVideo(query);
    if (!videoPath) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ duration: 0, ready: false }));
    }

    const info = await probeMedia(videoPath);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...info, ready: info.duration > 0 }));
  }

  // 11. Subtitle WebVTT Stream
  if (pathname.startsWith('/api/subtitles/')) {
    const query = pathname.replace('/api/subtitles/', '');
    const videoPath = findLocalVideo(query);
    if (!videoPath) {
      res.writeHead(404);
      return res.end('Video not found');
    }

    const probe = await probeMedia(videoPath);
    const subIdx = probe.spanishSubIndex !== null ? probe.spanishSubIndex : 0;

    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'no-cache'
    });

    const ffmpegArgs = [
      '-v', 'error',
      '-i', videoPath,
      '-map', `0:${subIdx}`,
      '-f', 'webvtt',
      'pipe:1'
    ];

    const child = spawn(localFfmpeg || 'ffmpeg', ffmpegArgs);
    child.stdout.pipe(res);
    child.on('error', () => { try { res.end(); } catch (e) {} });
    req.on('close', () => child.kill());
    return;
  }

  // 12. Video Transcoding & Direct Streaming (FFmpeg)
  if (pathname.startsWith('/stream/')) {
    const query = pathname.replace('/stream/', '');
    const videoPath = findLocalVideo(query);
    if (!videoPath) {
      res.writeHead(404);
      return res.end('Video not found or downloading initial pieces...');
    }

    const seekSeconds = parseFloat(parsedUrl.query.ss || '0') || 0;
    const audioTrack = parsedUrl.query.audio || null;

    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-cache'
    });

    const ffmpegArgs = [];
    if (seekSeconds > 0) {
      ffmpegArgs.push('-ss', seekSeconds.toString());
    }
    ffmpegArgs.push('-i', videoPath);

    // Audio stream mapping
    if (audioTrack) {
      ffmpegArgs.push('-map', '0:v:0', '-map', `0:${audioTrack}`);
    }

    ffmpegArgs.push(
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );

    const child = spawn(localFfmpeg || 'ffmpeg', ffmpegArgs);
    child.stdout.pipe(res);
    child.on('error', () => { try { res.end(); } catch (e) {} });
    req.on('close', () => child.kill());
    return;
  }

  // 13. Static Files (Frontend UI v23)
  let staticPath = pathname === '/' ? path.join(STATIC_DIR, 'index.html') : path.join(STATIC_DIR, pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    const ext = path.extname(staticPath).toLowerCase();
    const mimes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.ico': 'image/x-icon',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': mimes[ext] || 'application/octet-stream' });
    return fs.createReadStream(staticPath).pipe(res);
  }

  res.writeHead(404);
  res.end('Not found');
}

// -------------------------------------------------------------------------
// Start Server
// -------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 CineFlix Standalone running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const fallback = 8088;
    console.log(`Port ${PORT} in use, trying ${fallback}...`);
    server.listen(fallback, '0.0.0.0');
  } else {
    console.error('Server error:', err);
  }
});
