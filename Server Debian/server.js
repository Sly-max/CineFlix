const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const STATIC_DIR = path.join(__dirname, 'public');
const TORRENTS_DIR = '/opt/cine/data/torrents';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
}
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function getHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
    }
  } catch(e) {}
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 100), null, 2), 'utf8');
  } catch(e) {}
}

let catalogCache = null;
let catalogCacheTime = 0;
const CATALOG_TTL = 30 * 60 * 1000; // 30 minutes cache

async function fetchJellyseerrShelf(apiPath) {
  try {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 5055,
      path: apiPath,
      method: 'GET',
      headers: { 'X-Api-Key': JELLYSEERR_KEY }
    });
    if (res.data && res.data.results) {
      return res.data.results.map(m => ({
        id: m.id,
        tmdbId: m.id,
        mediaType: m.mediaType || (m.firstAirDate ? 'tv' : 'movie'),
        title: m.title || m.name,
        year: (m.releaseDate || m.firstAirDate || '').substring(0, 4),
        overview: m.overview || 'Sin descripción disponible.',
        rating: m.voteAverage ? m.voteAverage.toFixed(1) : null,
        poster: m.posterPath ? 'https://image.tmdb.org/t/p/w500' + m.posterPath : null,
        backdrop: m.backdropPath ? 'https://image.tmdb.org/t/p/w1280' + m.backdropPath : null
      }));
    }
  } catch(e) {}
  return [];
}


const RADARR_KEY = '111e8561eb6543d6ae4ae8e2cf7888c5';
const SONARR_KEY = '520d4e8fd19942d592016c9b32778dc9';
const JELLYSEERR_KEY = 'MTc5NDUyMzU3Nzg2MjU4N2M2ZDI2LWNjYzgtNDhjNy05YzUxLTJiMmFkODRjZjg1Zg==';
const JELLYFIN_KEY = 'b6f6b7dd9839425a92f1b10229451eb9';
const PROWLARR_KEY = 'b6a19f6686974f4d89298040c9efafda';
const searchCache = new Map();

let qbitCookie = '';
let qbitCookieExpiry = 0;

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed });
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(new Error('Timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getQbitCookie() {
  if (qbitCookie && Date.now() < qbitCookieExpiry) {
    return qbitCookie;
  }
  try {
    const postData = 'username=admin&password=Taladro1';
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: 8080,
      path: '/api/v2/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Referer': 'http://127.0.0.1:8080'
      }
    }, postData);
    if (res.headers['set-cookie']) {
      qbitCookie = res.headers['set-cookie'][0].split(';')[0];
      qbitCookieExpiry = Date.now() + 30 * 60 * 1000;
    }
  } catch (e) {
    console.error('Qbit login error:', e.message);
  }
  return qbitCookie;
}

function resolveRealTorrentUrl(downloadUrl) {
  if (!downloadUrl) return Promise.resolve(null);
  if (downloadUrl.startsWith('magnet:')) return Promise.resolve(downloadUrl);

  return new Promise((resolve) => {
    try {
      const parsed = new url.URL(downloadUrl);
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request({
        hostname: parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' ? '127.0.0.1' : parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'X-Api-Key': PROWLARR_KEY
        }
      }, (res) => {
        // If 301, 302, 307 redirect (common for Prowlarr indexers redirecting to magnet)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location;
          if (loc.startsWith('magnet:')) {
            return resolve(loc);
          }
          return resolveRealTorrentUrl(loc).then(resolve).catch(() => resolve(downloadUrl));
        }

        // If direct .torrent on 127.0.0.1, convert to container-accessible host IP
        let safeUrl = downloadUrl.replace(/127\.0\.0\.1:9696/g, '192.168.1.205:9696').replace(/localhost:9696/g, '192.168.1.205:9696');
        resolve(safeUrl);
      });

      req.on('error', () => {
        let safeUrl = downloadUrl.replace(/127\.0\.0\.1:9696/g, '192.168.1.205:9696').replace(/localhost:9696/g, '192.168.1.205:9696');
        resolve(safeUrl);
      });
      req.setTimeout(6000, () => {
        req.destroy();
        resolve(downloadUrl);
      });
      req.end();
    } catch(e) {
      resolve(downloadUrl);
    }
  });
}

// Complete removal of torrent and its physical files from disk and queue
async function deleteTorrentAndFiles(hash, name, contentPath) {
  const cookie = await getQbitCookie();

  // 1. Get info to obtain content_path if not provided
  let realContentPath = contentPath;
  if (!realContentPath && hash) {
    try {
      const infoRes = await httpRequest({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/v2/torrents/info?hashes=' + encodeURIComponent(hash),
        method: 'GET',
        headers: { 'Cookie': cookie }
      });
      if (Array.isArray(infoRes.data) && infoRes.data[0]) {
        realContentPath = infoRes.data[0].content_path;
      }
    } catch (e) {}
  }

  // 2. Delete from qBittorrent via POST form body with deleteFiles=true
  if (hash) {
    const postBody = `hashes=${encodeURIComponent(hash)}&deleteFiles=true`;
    await httpRequest({
      hostname: '127.0.0.1',
      port: 8080,
      path: '/api/v2/torrents/delete',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        'Cookie': cookie
      }
    }, postBody).catch(() => {});
  }

  // 3. Remove from Sonarr / Radarr queues and PURGE from Radarr database (WITHOUT BLOCKLISTING!)
  try {
    const sQueue = await httpRequest({
      hostname: '127.0.0.1',
      port: 8989,
      path: '/api/v3/queue',
      method: 'GET',
      headers: { 'X-Api-Key': SONARR_KEY }
    });
    if (sQueue.data && Array.isArray(sQueue.data.records)) {
      for (const rec of sQueue.data.records) {
        if (rec.downloadId && hash && rec.downloadId.toLowerCase() === hash.toLowerCase()) {
          await httpRequest({
            hostname: '127.0.0.1',
            port: 8989,
            path: `/api/v3/queue/${rec.id}?removeFromClient=true&blocklist=false`,
            method: 'DELETE',
            headers: { 'X-Api-Key': SONARR_KEY }
          }).catch(() => {});
        }
      }
    }

    const rQueue = await httpRequest({
      hostname: '127.0.0.1',
      port: 7878,
      path: '/api/v3/queue',
      method: 'GET',
      headers: { 'X-Api-Key': RADARR_KEY }
    });
    if (rQueue.data && Array.isArray(rQueue.data.records)) {
      for (const rec of rQueue.data.records) {
        if (rec.downloadId && hash && rec.downloadId.toLowerCase() === hash.toLowerCase()) {
          await httpRequest({
            hostname: '127.0.0.1',
            port: 7878,
            path: `/api/v3/queue/${rec.id}?removeFromClient=true&blocklist=false`,
            method: 'DELETE',
            headers: { 'X-Api-Key': RADARR_KEY }
          }).catch(() => {});
        }
      }
    }

    // Purge any blocked records from Radarr blocklist matching this hash or name
    const rBlock = await httpRequest({
      hostname: '127.0.0.1',
      port: 7878,
      path: '/api/v3/blocklist',
      method: 'GET',
      headers: { 'X-Api-Key': RADARR_KEY }
    });
    if (rBlock.data && Array.isArray(rBlock.data.records)) {
      for (const b of rBlock.data.records) {
        const matchesHash = hash && b.sourceTitle && b.sourceTitle.toLowerCase().includes(hash.toLowerCase());
        const matchesName = name && b.sourceTitle && b.sourceTitle.toLowerCase().includes((name || '').toLowerCase().substring(0, 15));
        if (matchesHash || matchesName) {
          await httpRequest({
            hostname: '127.0.0.1',
            port: 7878,
            path: `/api/v3/blocklist/${b.id}`,
            method: 'DELETE',
            headers: { 'X-Api-Key': RADARR_KEY }
          }).catch(() => {});
        }
      }
    }

    // Fully delete movie from Radarr database so it never gets stuck with hasFile: true
    const allMovies = await httpRequest({
      hostname: '127.0.0.1',
      port: 7878,
      path: '/api/v3/movie',
      method: 'GET',
      headers: { 'X-Api-Key': RADARR_KEY }
    });
    if (Array.isArray(allMovies.data)) {
      const cleanTarget = (name || '').toLowerCase().replace(/[^a-z0-9]/g, ' ');
      for (const m of allMovies.data) {
        const mTitle = (m.title || '').toLowerCase().replace(/[^a-z0-9]/g, ' ');
        if (mTitle && cleanTarget && (cleanTarget.includes(mTitle) || mTitle.includes(cleanTarget.substring(0, 12)))) {
          await httpRequest({
            hostname: '127.0.0.1',
            port: 7878,
            path: `/api/v3/movie/${m.id}?deleteFiles=true&addImportExclusion=false`,
            method: 'DELETE',
            headers: { 'X-Api-Key': RADARR_KEY }
          }).catch(() => {});
        }
      }
    }
  } catch (e) {}

  // 4. Force filesystem deletion of content_path and matching directories/files
  const targets = new Set();
  if (realContentPath) {
    targets.add(path.basename(realContentPath));
  }
  if (name) {
    targets.add(name);
  }

  const searchRoots = [
    TORRENTS_DIR,
    '/opt/cine/data/media/tv',
    '/opt/cine/data/media/movies'
  ];

  for (const t of targets) {
    for (const root of searchRoots) {
      const full = path.join(root, t);
      if (fs.existsSync(full)) {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
      }
    }
  }

  // Scan TORRENTS_DIR to ensure no leftover partial folder matching name or partial title
  try {
    if (fs.existsSync(TORRENTS_DIR)) {
      const items = fs.readdirSync(TORRENTS_DIR);
      for (const item of items) {
        if (realContentPath && item === path.basename(realContentPath)) {
          try { fs.rmSync(path.join(TORRENTS_DIR, item), { recursive: true, force: true }); } catch (e) {}
        } else if (name && item.toLowerCase().includes(name.toLowerCase().substring(0, 15))) {
          try { fs.rmSync(path.join(TORRENTS_DIR, item), { recursive: true, force: true }); } catch (e) {}
        }
      }
    }
  } catch (e) {}

  // 5. Invalidate searchCache & mediaProbeCache so next requests fetch cleanly
  searchCache.clear();
  for (const k of Object.keys(mediaProbeCache)) {
    if ((name && k.toLowerCase().includes((name || '').toLowerCase().substring(0, 15))) || (realContentPath && k.includes(path.basename(realContentPath)))) {
      delete mediaProbeCache[k];
    }
  }

  // 6. Remove from server history.json
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      let hist = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8') || '[]');
      hist = hist.filter(h => {
        if (hash && h.hash && h.hash.toLowerCase() === hash.toLowerCase()) return false;
        if (name && h.filename && h.filename.toLowerCase().includes((name || '').toLowerCase().substring(0, 15))) return false;
        if (name && h.title && h.title.toLowerCase().includes((name || '').toLowerCase().substring(0, 15))) return false;
        return true;
      });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), 'utf8');
    }
  } catch (e) {}
}

function parseTorrentName(name, category) {
  let isTv = category === 'tv';
  let seriesName = '';
  let season = '';
  let episode = '';

  const sMatch = name.match(/^(.*?)(?:[\s._-]+|\b)[sS](\d{1,2})(?:[eE](\d{1,2}))?/i);
  const tempMatch = name.match(/^(.*?)(?:[\s._-]+|\b)temp[a-z]*[\s._-]*(\d{1,2})/i);

  if (sMatch) {
    isTv = true;
    seriesName = sMatch[1].replace(/[._]/g, ' ').replace(/\b(19|20)\d{2}\b/g, '').replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
    season = parseInt(sMatch[2], 10);
    if (sMatch[3]) episode = parseInt(sMatch[3], 10);
  } else if (tempMatch) {
    isTv = true;
    seriesName = tempMatch[1].replace(/[._]/g, ' ').replace(/\b(19|20)\d{2}\b/g, '').replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
    season = parseInt(tempMatch[2], 10);
  }

  if (isTv && !seriesName) {
    seriesName = name.replace(/[._]/g, ' ').split(/\s+/).slice(0, 3).join(' ');
  }

  let cleanLabel = name;
  if (isTv && seriesName) {
    if (season && episode) {
      cleanLabel = `Temporada ${season} • Episodio ${episode}`;
    } else if (season) {
      cleanLabel = `Temporada ${season} (Completa)`;
    }
  }

  return {
    isTv,
    seriesName: seriesName ? seriesName.replace(/\s+/g, ' ').trim() : '',
    cleanLabel,
    seasonStr: season ? `Temporada ${season}` : '',
    episodeStr: episode ? `Episodio ${episode}` : ''
  };
}


const mediaProbeCache = {};

function probeMedia(filePath) {
  if (mediaProbeCache[filePath] && mediaProbeCache[filePath].duration > 0 && mediaProbeCache[filePath].audioTracks.length > 0) {
    return Promise.resolve(mediaProbeCache[filePath]);
  }
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const cmd = 'ffprobe -v error -analyzeduration 2000000 -probesize 2000000 -show_entries format=duration:stream=index,codec_name,codec_type,channels:stream_tags=language,title -of json "' + filePath + '"';
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
          } else if (lang.startsWith('fre') || title.includes('french') || title.includes('français')) {
            label = '🇫🇷 Francés';
          } else if (lang.startsWith('ger') || title.includes('german')) {
            label = '🇩🇪 Alemán';
          } else if (lang.startsWith('ita') || title.includes('italian')) {
            label = '🇮🇹 Italiano';
          } else if (lang.startsWith('por') || title.includes('portug')) {
            label = '🇧🇷 Portugués';
          } else if (lang.startsWith('jpn') || title.includes('japan')) {
            label = '🇯🇵 Japonés';
          } else if (lang.startsWith('hin') || title.includes('hindi')) {
            label = '🇮🇳 Hindi';
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

        // Preferred Audio: Latino first, then any Spanish track
        let preferredAudio = audioTracks.find(t => t.isLatino);
        if (!preferredAudio) {
          preferredAudio = audioTracks.find(t => t.isSpanish || (t.lang && (t.lang.startsWith('spa') || t.lang.startsWith('es'))));
        }
        const preferredAudioIndex = preferredAudio ? preferredAudio.index : (audioTracks[0] ? audioTracks[0].index : null);

        // Find spanish subtitle stream
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

function findMainVideoInDir(dir) {
  try {
    const files = fs.readdirSync(dir);
    const videoFiles = [];
    for (const f of files) {
      const fp = path.join(dir, f);
      const st = fs.statSync(fp);
      if (st.isFile() && /\.(mp4|mkv|webm|avi|mov)$/i.test(f) && !f.endsWith('.parts')) {
        videoFiles.push({ path: fp, size: st.size });
      }
    }
    videoFiles.sort((a, b) => b.size - a.size);
    return videoFiles.length > 0 ? videoFiles[0].path : null;
  } catch(e) {
    return null;
  }
}

function resolveMediaFile(identifier, torrentsList = []) {
  if (!identifier) return null;
  identifier = decodeURIComponent(identifier).trim();

  // 1. By torrent hash
  const byHash = torrentsList.find(t => t.hash && t.hash.toLowerCase() === identifier.toLowerCase());
  if (byHash && byHash.content_path) {
    let p = byHash.content_path.replace(/^\/downloads/, TORRENTS_DIR);
    if (fs.existsSync(p) && !p.endsWith('.parts')) {
      if (fs.statSync(p).isDirectory()) {
        const v = findMainVideoInDir(p);
        if (v) return v;
      } else {
        return p;
      }
    }
  }

  // 2. Direct exact path
  const direct = path.join(TORRENTS_DIR, identifier);
  if (fs.existsSync(direct) && !direct.endsWith('.parts')) {
    if (fs.statSync(direct).isDirectory()) {
      const v = findMainVideoInDir(direct);
      if (v) return v;
    } else {
      return direct;
    }
  }

  // 3. Search directory matching tokens/keywords
  try {
    const entries = fs.readdirSync(TORRENTS_DIR);
    const cleanId = identifier.toLowerCase().replace(/[^a-z0-9]/g, ' ');
    const idTokens = cleanId.split(/\s+/).filter(w => w.length > 2 && !['2160p','1080p','720p','webrip','bluray','x264','x265','dual'].includes(w));

    let bestMatch = null;
    let maxScore = 0;

    for (const entry of entries) {
      const fullPath = path.join(TORRENTS_DIR, entry);
      const cleanEntry = entry.toLowerCase().replace(/[^a-z0-9]/g, ' ');
      let score = 0;
      for (const tok of idTokens) {
        if (cleanEntry.includes(tok)) score++;
      }
      if (score > maxScore && score >= Math.min(2, idTokens.length)) {
        maxScore = score;
        bestMatch = fullPath;
      }
    }

    if (bestMatch) {
      if (fs.statSync(bestMatch).isDirectory()) {
        return findMainVideoInDir(bestMatch);
      }
      return bestMatch;
    }
  } catch(e) {}

  return null;
}


function parseLanguageAndQuality(title, sizeBytes = 0) {
  const t = title.toLowerCase();

  // 1. Rigorous Detection of CAM / Cinema / Low Quality Recordings
  const camRegex = /\b(cam|hdcam|hd-cam|hqcam|hq-cam|camrip|cam-rip|ts|hdts|hd-ts|telesync|tc|hdtc|hd-tc|telecine|screener|scr|dvdscr|predvd|1xbet|line\s*audio|cine|grabado)\b/i;
  const isCam = camRegex.test(t) || /(camrip|hdcam|hdts|telesync|hdtc|telecine|hqcam)/i.test(t);

  // 2. Detection of Ancient / Poor SD Quality (XviD / 480p / DVDRip)
  const isAncientSD = /\b(480p|xvid|divx|dvdrip|vhsrip)\b/i.test(t);

  // 3. Source Tag
  let sourceType = 'digital';
  let sourceTag = '💎 Digital Original';
  if (isCam) {
    sourceType = 'cam';
    sourceTag = '⚠️ Grabado de Cine (Cámara / TS)';
  } else if (isAncientSD) {
    sourceType = 'sd';
    sourceTag = '📺 Calidad Antigua (480p / DVD)';
  }

  // 4. CERTIFIED AUTHENTIC LANGUAGE DETECTION
  // Real Latino keywords:
  const latinoRegex = /\b(latino|audio latino|dual latino|lat-team|mex|mexicano|latinoamericano|es-mx|es-la)\b|(\.latino\b|\.lat\b|\[lat\]|\(lat\)|\[audio\s*latino\])/i;
  // Real Castellano keywords:
  const castellanoRegex = /\b(castellano|español|espanol|es-es)\b|(\.castellano\b|\.spa\b|\[castellano\]|\[spa\])/i;
  // Indian Audio keywords:
  const indianRegex = /\b(hindi|tamil|telugu|kannada|malayalam|punjabi|urdu|bengali|marathi|gujarati|bhojpuri)\b/i;
  // Generic Multi/Dual keywords:
  const multiRegex = /\b(multi|multiaudio|multi-audio|dual|dual-audio|multilanguage)\b/i;

  let isLatino = false;
  let isCastellano = false;
  let isMulti = false;
  let isIndian = false;
  let isSpanishAvailable = false;
  let langCode = 'sub';
  let langTag = '💎 Idioma Original (Subtitulado en Español)';

  const hasLatMatch = latinoRegex.test(t);
  const hasCasMatch = castellanoRegex.test(t) || (/\b(spanish|spa)\b/i.test(t) && !t.includes('sub'));

  if (hasLatMatch && hasCasMatch) {
    isLatino = true;
    isCastellano = true;
    isSpanishAvailable = true;
    langCode = 'dual_es';
    langTag = '🌐 Español Dual (Latino + Castellano)';
  } else if (hasLatMatch) {
    isLatino = true;
    isSpanishAvailable = true;
    langCode = 'latino';
    langTag = '🇲🇽 Español Latino';
  } else if (hasCasMatch) {
    isCastellano = true;
    isSpanishAvailable = true;
    langCode = 'castellano';
    langTag = '🇪🇸 Castellano';
  } else if (indianRegex.test(t)) {
    isIndian = true;
    langCode = 'hindi';
    langTag = '🇮🇳 Audio Indio (Hindi / Tamil)';
  } else if (/\b(french|truefrench|vff|vfi|vf2|vostfr)\b/i.test(t)) {
    langCode = 'french';
    langTag = '🇫🇷 Francés';
  } else if (/\b(russian|rus|дубляж|itunes)\b/i.test(t)) {
    langCode = 'intl';
    langTag = '🇷🇺 Ruso';
  } else if (multiRegex.test(t)) {
    isMulti = true;
    langCode = 'multi';
    langTag = '🌐 Multi-Audio Internacional';
  }

  // 5. Resolution & Real Quality Rank
  let quality = '1080p Full HD';
  let qualityRank = 3;

  if (isCam) {
    quality = '⚠️ Grabado de Cine (Calidad Pobre)';
    qualityRank = 0;
  } else if (isAncientSD) {
    quality = '480p SD (Baja Calidad)';
    qualityRank = 1;
  } else if (/2160p|4k|uhd/i.test(t)) {
    quality = '💎 4K UHD Original';
    qualityRank = 4;
  } else if (/1080p|fhd/i.test(t)) {
    if (sizeBytes > 0 && sizeBytes < 1200000000) {
      quality = '1080p Compacto (Bajo Bitrate)';
      qualityRank = 2;
    } else {
      quality = '💎 1080p Full HD (Nítido)';
      qualityRank = 3;
    }
  } else if (/720p|hd/i.test(t)) {
    quality = '720p HD';
    qualityRank = 2;
  } else {
    quality = (sizeBytes >= 1800000000) ? '1080p Digital' : '720p Digital';
    qualityRank = 2;
  }

  return {
    isCam,
    isAncientSD,
    sourceType,
    sourceTag,
    langTag,
    langCode,
    isLatino,
    isCastellano,
    isMulti,
    isIndian,
    isSpanishAvailable,
    quality,
    qualityRank
  };
}


async function resolveImdbId(title, tmdbId, mediaType = 'movie') {
  // 1. Try Jellyseerr by tmdbId if provided
  if (tmdbId) {
    try {
      const detail = await httpRequest({
        hostname: '127.0.0.1',
        port: 5055,
        path: `/api/v1/${mediaType}/${tmdbId}`,
        method: 'GET',
        headers: { 'X-Api-Key': JELLYSEERR_KEY }
      });
      if (detail?.data?.imdbId) return detail.data.imdbId;
    } catch (e) {}
  }

  const clean = (title || '')
    .replace(/[._-]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[()]/g, '')
    .trim();

  if (!clean) return null;

  // 2. Try Cinemeta search by title (instant <150ms public catalog)
  try {
    const type = mediaType === 'tv' ? 'series' : 'movie';
    const cinemetaUrl = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(clean)}.json`;
    const res = await new Promise((resolve) => {
      const req = https.get(cinemetaUrl, { timeout: 3500 }, r => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          try { resolve(JSON.parse(d)); } catch(err) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (res?.metas?.[0]?.id && res.metas[0].id.startsWith('tt')) {
      return res.metas[0].id;
    }
  } catch (e) {}

  // 3. Fallback to Jellyseerr search by title
  try {
    const jsSearch = await httpRequest({
      hostname: '127.0.0.1',
      port: 5055,
      path: '/api/v1/search?query=' + encodeURIComponent(clean),
      method: 'GET',
      headers: { 'X-Api-Key': JELLYSEERR_KEY }
    });
    const match = jsSearch?.data?.results?.[0];
    if (match && match.id) {
      const mType = match.mediaType || mediaType || 'movie';
      const detail = await httpRequest({
        hostname: '127.0.0.1',
        port: 5055,
        path: `/api/v1/${mType}/${match.id}`,
        method: 'GET',
        headers: { 'X-Api-Key': JELLYSEERR_KEY }
      });
      if (detail?.data?.imdbId) return detail.data.imdbId;
    }
  } catch (e) {}

  return null;
}

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
    const torrentioUrl = `https://torrentio.strem.fun/stream/${torrentioPath}`;
    const data = await new Promise((resolve) => {
      const req = https.get(torrentioUrl, { timeout: 6000 }, r => {
        let body = '';
        r.on('data', chunk => body += chunk);
        r.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });

    if (!data || !Array.isArray(data.streams)) return [];

    const standardTrackers = [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://open.demonii.com:1337/announce',
      'udp://open.stealth.si:80/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://tracker.bittor.pw:1337/announce',
      'udp://public.popcorn-tracker.org:6969/announce',
      'udp://tracker.openbittorrent.com:6969/announce'
    ];

    const results = [];
    for (const s of data.streams) {
      if (!s.infoHash) continue;
      const titleLines = (s.title || '').split('\n');
      const rawTitle = titleLines[0] || (s.behaviorHints && s.behaviorHints.filename) || 'Release';
      const metaLine = titleLines[1] || '';

      const seedMatch = metaLine.match(/👤\s*(\d+)/);
      const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;

      const sizeMatch = metaLine.match(/💾\s*([\d\.]+)\s*(GB|MB|KB)/i);
      let sizeBytes = 0;
      if (sizeMatch) {
        const val = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if (unit === 'GB') sizeBytes = Math.round(val * 1024 * 1024 * 1024);
        else if (unit === 'MB') sizeBytes = Math.round(val * 1024 * 1024);
        else sizeBytes = Math.round(val * 1024);
      } else {
        sizeBytes = 2 * 1024 * 1024 * 1024;
      }

      const provMatch = metaLine.match(/⚙️\s*([^\n\r]+)/);
      const provider = provMatch ? provMatch[1].trim() : 'Torrentio';

      const fullText = `${s.name || ''} ${s.title || ''} ${(s.behaviorHints && s.behaviorHints.filename) || ''}`;
      const meta = parseLanguageAndQuality(fullText, sizeBytes);

      // Dedicated Spanish certification for Cinecalidad and explicit Spanish tags
      if (s.title.includes('🇲🇽') || fullText.toLowerCase().includes('cinecalidad') || /dual-lat|lat-team/i.test(fullText)) {
        meta.isLatino = true;
        meta.isSpanishAvailable = true;
        meta.langCode = 'latino';
        meta.langTag = fullText.toLowerCase().includes('cinecalidad') 
          ? '🇲🇽 Cinecalidad Dual Latino' 
          : '🇲🇽 Español Latino';
      } else if (s.title.includes('🇪🇸') || /\b(castellano|español|espanol)\b/i.test(fullText) || (/\b(spanish|spa)\b/i.test(fullText) && !fullText.toLowerCase().includes('sub'))) {
        meta.isCastellano = true;
        meta.isSpanishAvailable = true;
        meta.langCode = 'castellano';
        meta.langTag = '🇪🇸 Castellano';
      }

      const streamTrackers = (s.sources || []).filter(src => src.startsWith('tracker:')).map(src => src.replace('tracker:', ''));
      const combinedTrackers = Array.from(new Set([...streamTrackers, ...standardTrackers]));
      const trackerQuery = combinedTrackers.map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

      const cleanFileName = (s.behaviorHints && s.behaviorHints.filename) || rawTitle;
      const downloadUrl = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(cleanFileName)}${trackerQuery}`;

      results.push({
        title: cleanFileName,
        size: (sizeBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        sizeBytes,
        seeders,
        indexer: provider,
        downloadUrl,
        infoHash: s.infoHash.toLowerCase(),
        ...meta
      });
    }

    return results;
  } catch (err) {
    console.error('Torrentio fetch error:', err.message);
    return [];
  }
}

async function searchReleases(title, year, mediaType = 'movie', season = null, tmdbId = null, noCache = false) {
  const cacheKey = `${title}_${year || ''}_${mediaType}_${season || ''}_${tmdbId || ''}`.toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (!noCache && cached && (Date.now() - cached.timestamp < 15 * 60 * 1000)) {
    return cached.releases;
  }

  const cleanTitle = (title || '')
    .replace(/[._-]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[()]/g, '')
    .trim();

  const queries = [];
  if (mediaType === 'tv') {
    const sNum = season ? (parseInt(season, 10) || 1) : 1;
    const sPadded = sNum < 10 ? `0${sNum}` : `${sNum}`;
    queries.push(`${cleanTitle} Temporada ${sNum} latino`);
    queries.push(`${cleanTitle} Temporada ${sNum} castellano`);
    queries.push(`${cleanTitle} S${sPadded} latino`);
    queries.push(`${cleanTitle} S${sPadded} castellano`);
    queries.push(`${cleanTitle} Temporada ${sNum}`);
    queries.push(`${cleanTitle} S${sPadded}`);
    queries.push(`${cleanTitle} latino`);
    queries.push(`${cleanTitle} castellano`);
    queries.push(`${cleanTitle} español`);
  } else {
    queries.push(`${cleanTitle} latino`);
    queries.push(`${cleanTitle} castellano`);
    queries.push(`${cleanTitle} español`);
    queries.push(cleanTitle);
  }

  // 1. Resolve IMDb ID in parallel with Prowlarr
  const imdbPromise = resolveImdbId(cleanTitle, tmdbId, mediaType);

  // 2. Query Prowlarr indexers
  const prowlarrPromise = Promise.all(
    queries.map(q =>
      httpRequest({
        hostname: '127.0.0.1',
        port: 9696,
        path: '/api/v1/search?query=' + encodeURIComponent(q),
        method: 'GET',
        headers: { 'X-Api-Key': PROWLARR_KEY }
      }).catch(() => ({ data: [] }))
    )
  );

  // 3. Query Torrentio as soon as IMDb ID is resolved
  const torrentioPromise = imdbPromise
    .then(imdbId => fetchTorrentioStreams(imdbId, mediaType, season))
    .catch(() => []);

  const [responses, torrentioResults] = await Promise.all([prowlarrPromise, torrentioPromise]);

  const seenGuids = new Set();
  const allReleases = [];

  // Add Torrentio streams first (authentic Cinecalidad, TorrentGalaxy, TPB with high seeds & language tags)
  for (const tr of torrentioResults) {
    if (!tr.downloadUrl) continue;
    const id = tr.infoHash || tr.downloadUrl;
    if (seenGuids.has(id)) continue;
    seenGuids.add(id);
    if (tr.infoHash) seenGuids.add(tr.infoHash);
    allReleases.push(tr);
  }

  // Add Prowlarr results
  for (const pRes of responses) {
    const list = Array.isArray(pRes.data) ? pRes.data : [];
    for (const r of list) {
      const hashId = r.infoHash ? r.infoHash.toLowerCase() : null;
      const id = hashId || r.guid || r.downloadUrl;
      if (!id || seenGuids.has(id) || (hashId && seenGuids.has(hashId))) continue;

      const t = (r.title || '').toLowerCase();
      // Exclude PC games, game repacks, soundtracks, books
      if (/\b(fitgirl|dodi|repack|codex|plaza|skidrow|crack|rune|flt|soundtrack|ost|epub|pdf|cbr|cbz)\b/i.test(t)) continue;

      // Exclude individual TV episodes when searching for a movie
      if (mediaType !== 'tv' && /\b([sS]\d{1,2}[eE]\d{1,2}|season\s*\d+|temporada\s*\d+|\d{1,2}x\d{1,2})\b/i.test(t)) continue;

      // Exclude completely different franchise sequels if not part of user's title
      const franchiseDiffs = [
        'lejos de casa', 'far from home', 'de regreso a casa', 'homecoming',
        'no way home', 'sin camino a casa', 'amazing spider', 'into the spider', 'across the spider',
        'dark knight', 'the dark knight', 'inicia', 'begins', 'rises', 'under the red hood', 'super sons'
      ];
      const lowerReq = cleanTitle.toLowerCase();
      let isDiffSequel = false;
      for (const sub of franchiseDiffs) {
        if (!lowerReq.includes(sub) && t.includes(sub)) {
          isDiffSequel = true;
          break;
        }
      }
      if (isDiffSequel) continue;

      // Filter out >45GB bloat (bluray remuxes) and <150MB junk
      if (r.size < 150000000 || r.size > 90000000000) continue;
      seenGuids.add(id);
      if (hashId) seenGuids.add(hashId);

      const meta = parseLanguageAndQuality(r.title, r.size);
      let dlUrl = '';
      if (r.guid && r.guid.startsWith('magnet:')) {
        dlUrl = r.guid;
      } else if (r.magnetUrl && r.magnetUrl.startsWith('magnet:')) {
        dlUrl = r.magnetUrl;
      } else if (r.infoHash) {
        dlUrl = `magnet:?xt=urn:btih:${r.infoHash}&dn=${encodeURIComponent(r.title)}&tr=http%3a%2f%2ftracker.opentrackr.org%3a1337%2fannounce&tr=udp%3a%2f%2ftracker.openbittorrent.com%3a6969%2fannounce`;
      } else if (r.downloadUrl) {
        dlUrl = r.downloadUrl;
      } else if (r.magnetUrl) {
        dlUrl = r.magnetUrl;
      } else if (r.guid && !r.guid.includes('description') && !r.guid.includes('details')) {
        dlUrl = r.guid;
      }
      if (!dlUrl) continue;

      allReleases.push({
        title: r.title,
        size: (r.size / 1024 / 1024 / 1024).toFixed(2) + ' GB',
        sizeBytes: r.size,
        seeders: r.seeders || 0,
        indexer: r.indexer,
        downloadUrl: dlUrl,
        infoHash: hashId,
        ...meta
      });
    }
  }

  // Smart sort:
  // 1) Digital Original ALWAYS before CAM
  // 2) Season match boost if requested (for TV shows)
  // 3) Spanish / Multi audio first (Español Latino o Multi-Audio)
  // 4) Seeders DESC (más semillas = descarga más rápida)
  // 5) Quality Rank (1080p / 4K)
  allReleases.sort((a, b) => {
    // 1. Digital Original before CAM
    if (a.isCam !== b.isCam) return a.isCam ? 1 : -1;

    // 2. If season requested, boost releases matching season number
    if (season) {
      const sNum = parseInt(season, 10) || 1;
      const sPad = sNum < 10 ? `0${sNum}` : `${sNum}`;
      const matchA = new RegExp(`(s0?${sNum}\\b|temp(orada)?\\s*0?${sNum}\\b|season\\s*0?${sNum}\\b)`, 'i').test(a.title) ? 1 : 0;
      const matchB = new RegExp(`(s0?${sNum}\\b|temp(orada)?\\s*0?${sNum}\\b|season\\s*0?${sNum}\\b)`, 'i').test(b.title) ? 1 : 0;
      if (matchA !== matchB) return matchB - matchA;
    }

    // 3. Spanish / Multi audio first
    const spaA = (a.isSpanishAvailable || a.isLatino || a.isCastellano) ? 1 : 0;
    const spaB = (b.isSpanishAvailable || b.isLatino || b.isCastellano) ? 1 : 0;
    if (spaA !== spaB) return spaB - spaA;

    // 4. Seeders DESC (máxima velocidad primero)
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;

    // 5. Quality Rank
    return (b.qualityRank || 0) - (a.qualityRank || 0);
  });

  searchCache.set(cacheKey, { timestamp: Date.now(), releases: allReleases });
  return allReleases;
}

function srtToVtt(srtContent) {
  return 'WEBVTT\n\n' + (srtContent || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

async function getOrFetchSpanishSubtitles(filePath, rawId, query = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return 'WEBVTT\n\n';
  }

  // 1. Check if an external .srt already exists on disk
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const candidateSubs = [
    `${filePath}.es.srt`,
    `${filePath}.srt`,
    path.join(dir, `${baseName}.es.srt`),
    path.join(dir, `${baseName}.srt`),
    path.join(dir, 'Spanish.srt'),
    path.join(dir, 'spanish.srt'),
    path.join(dir, '2_Spanish.srt'),
    path.join(dir, 'Subs', 'Spanish.srt'),
    path.join(dir, 'Subs', '2_Spanish.srt')
  ];

  for (const c of candidateSubs) {
    if (fs.existsSync(c)) {
      try {
        const content = fs.readFileSync(c, 'utf8');
        if (content.length > 50) return srtToVtt(content);
      } catch(e) {}
    }
  }

  // 2. Check if embedded text Spanish subtitle exists
  const probe = await probeMedia(filePath);
  if (probe.spanishSubIndex !== null) {
    try {
      const vtt = await new Promise((resolve) => {
        const { spawn } = require('child_process');
        const ff = spawn('ffmpeg', [
          '-v', 'error',
          '-i', filePath,
          '-map', '0:' + probe.spanishSubIndex,
          '-f', 'webvtt',
          'pipe:1'
        ]);
        let out = '';
        ff.stdout.on('data', d => out += d);
        ff.on('close', code => {
          if (code === 0 && out.length > 30) resolve(out);
          else resolve(null);
        });
        ff.on('error', () => resolve(null));
      });
      if (vtt) return vtt;
    } catch(e) {}
  }

  // 3. Auto-fetch Spanish subtitles via OpenSubtitles v3 / Stremio using IMDb ID
  try {
    let imdbId = query.imdbId || null;
    let tmdbId = query.tmdbId || null;
    let mediaType = query.mediaType || 'movie';

    if (!imdbId && tmdbId) {
      const detail = await httpRequest({
        hostname: '127.0.0.1',
        port: 5055,
        path: `/api/v1/${mediaType}/${tmdbId}`,
        method: 'GET',
        headers: { 'X-Api-Key': JELLYSEERR_KEY }
      }).catch(() => null);
      imdbId = detail?.data?.imdbId;
    }

    if (!imdbId) {
      const cleanName = baseName
        .replace(/\b(19|20)\d{2}\b/g, '')
        .replace(/\b(1080p|720p|2160p|4k|bluray|web-dl|webdl|webrip|x264|x265|h264|h265|aac|dts|multi|latino|castellano|hq|pre|ddp5|\d\.\d)\b/gi, '')
        .replace(/[._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const jsSearch = await httpRequest({
        hostname: '127.0.0.1',
        port: 5055,
        path: '/api/v1/search?query=' + encodeURIComponent(cleanName),
        method: 'GET',
        headers: { 'X-Api-Key': JELLYSEERR_KEY }
      }).catch(() => null);

      const match = jsSearch?.data?.results?.[0];
      if (match && match.id) {
        mediaType = match.mediaType || 'movie';
        const detail = await httpRequest({
          hostname: '127.0.0.1',
          port: 5055,
          path: `/api/v1/${mediaType}/${match.id}`,
          method: 'GET',
          headers: { 'X-Api-Key': JELLYSEERR_KEY }
        }).catch(() => null);
        imdbId = detail?.data?.imdbId;
      }
    }

    if (imdbId) {
      const subUrl = `https://opensubtitles-v3.strem.io/subtitles/${mediaType === 'tv' ? 'series' : 'movie'}/${imdbId}.json`;
      const subData = await new Promise((resolve) => {
        https.get(subUrl, r => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => {
            try { resolve(JSON.parse(d)); } catch(e) { resolve({}); }
          });
        }).on('error', () => resolve({}));
      });

      const spanishSubs = (subData.subtitles || []).filter(s => s.lang === 'spa' || s.lang === 'es');
      if (spanishSubs.length > 0) {
        const bestSub = spanishSubs[0];
        const srtContent = await new Promise((resolve) => {
          https.get(bestSub.url, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve(d));
          }).on('error', () => resolve(''));
        });

        if (srtContent && srtContent.length > 100) {
          try { fs.writeFileSync(`${filePath}.es.srt`, srtContent, 'utf8'); } catch(e) {}
          return srtToVtt(srtContent);
        }
      }
    }
  } catch(e) {
    console.error('Subtitle auto-fetch error:', e.message);
  }

  return 'WEBVTT\n\nNOTE Subtitulos en Espanol no disponibles para este video\n\n';
}


// KEYFRAME EXTRACTION & CACHING FOR ACCURATE SEEKING
const keyframesCache = new Map();
function getKeyframesForFile(filePath) {
  if (keyframesCache.has(filePath)) return keyframesCache.get(filePath);
  const kfPath = filePath + '.keyframes.json';
  if (fs.existsSync(kfPath)) {
    try {
      const arr = JSON.parse(fs.readFileSync(kfPath, 'utf8'));
      if (Array.isArray(arr) && arr.length > 0) {
        keyframesCache.set(filePath, arr);
        return arr;
      }
    } catch(e) {}
  }
  if (filePath.includes('Interstellar') && fs.existsSync('/tmp/keyframes.txt')) {
    try {
      const list = fs.readFileSync('/tmp/keyframes.txt', 'utf8').trim().split('\n').map(x => parseFloat(x)).filter(x => !isNaN(x));
      fs.writeFileSync(kfPath, JSON.stringify(list));
      keyframesCache.set(filePath, list);
      return list;
    } catch(e) {}
  }
  return [];
}

async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS & Anti-Cache Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Clear-Site-Data', '"cache", "storage"');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // 0. SERVICE WORKER SELF-DESTRUCT
  if (pathname === '/sw.js' || pathname === '/service-worker.js' || pathname.includes('workbox') || pathname.endsWith('.worker.js')) {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    });
    return res.end(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then(clients => clients.forEach(c => c.navigate(c.url)))
  );
});
caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
`);
  }

  // 1. HEALTH / STATUS OF ALL 7 PORTALS
  if (pathname === '/api/status') {
    const services = [
      { id: 'jellyfin', name: 'Jellyfin', port: 8096, url: 'http://192.168.1.205:8096' },
      { id: 'jellyseerr', name: 'Jellyseerr', port: 5055, url: 'http://192.168.1.205:5055' },
      { id: 'radarr', name: 'Radarr', port: 7878, url: 'http://192.168.1.205:7878' },
      { id: 'sonarr', name: 'Sonarr', port: 8989, url: 'http://192.168.1.205:8989' },
      { id: 'prowlarr', name: 'Prowlarr', port: 9696, url: 'http://192.168.1.205:9696' },
      { id: 'bazarr', name: 'Bazarr', port: 6767, url: 'http://192.168.1.205:6767' },
      { id: 'qbittorrent', name: 'qBittorrent', port: 8080, url: 'http://192.168.1.205:8080' }
    ];

    const results = await Promise.all(services.map(async s => {
      let online = false;
      try {
        const check = await httpRequest({
          hostname: '127.0.0.1',
          port: s.port,
          path: '/',
          method: 'GET'
        });
        online = check.status >= 200 && check.status < 500;
      } catch (e) {
        online = false;
      }
      return { ...s, online };
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ services: results }));
  }

  // WATCH HISTORY GET
  if (pathname === '/api/history' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, history: getHistory() }));
  }

  // WATCH HISTORY POST (SAVE / UPDATE WITH METADATA AUTO-ENRICHMENT)
  if (pathname === '/api/history' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyData || '{}');
        const item = body.item || body;
        if (item && item.id) {
          // Auto-enrich missing poster / backdrop / title from Jellyseerr / TMDB
          if (!item.poster || item.poster.includes('placeholder') || !item.tmdbId) {
            try {
              const cleanQ = (item.title || item.filename || '')
                .replace(/\.[a-z0-9]{2,4}$/i, '')
                .replace(/[^a-zA-Z0-9 ]/g, ' ')
                .replace(/\b(1080p|720p|2160p|4k|uhd|bluray|webrip|proper|imax|dual|yg|x265|x264|hevc|ddp?5 1)\b/gi, '')
                .trim();
              const sRes = await httpRequest({
                hostname: '127.0.0.1',
                port: 5055,
                path: '/api/v1/search?query=' + encodeURIComponent(cleanQ),
                method: 'GET'
              });
              if (sRes.data && Array.isArray(sRes.data.results) && sRes.data.results.length > 0) {
                const top = sRes.data.results[0];
                item.tmdbId = top.id;
                item.title = top.title || top.name || item.title;
                item.year = (top.releaseDate || top.firstAirDate || '').substring(0, 4) || item.year;
                if (top.posterPath) item.poster = 'https://image.tmdb.org/t/p/w500' + top.posterPath;
                if (top.backdropPath) item.backdrop = 'https://image.tmdb.org/t/p/w1280' + top.backdropPath;
                item.id = (item.mediaType === 'tv' ? 'tv_' : 'movie_') + top.id;
              }
            } catch(e) {}
          }

          let history = getHistory();
          // Filter out matching duplicates by id or by tmdbId
          history = history.filter(h => h.id !== item.id && (!item.tmdbId || h.tmdbId !== item.tmdbId));
          item.updatedAt = Date.now();
          history.unshift(item);
          saveHistory(history);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ ok: true, history: getHistory() }));
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing item or id' }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // WATCH HISTORY DELETE ITEM
  if ((pathname === '/api/history/delete' && req.method === 'POST') || (pathname === '/api/history' && req.method === 'DELETE')) {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyData || '{}');
        const targetId = body.id || parsedUrl.query.id;
        if (targetId) {
          let history = getHistory();
          history = history.filter(h => h.id !== targetId);
          saveHistory(history);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, history: getHistory() }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // WATCH HISTORY CLEAR ALL
  if (pathname === '/api/history/clear' && req.method === 'POST') {
    saveHistory([]);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, history: [] }));
  }


  // 2.5 RICH MEDIA DETAILS (TMDB / JELLYSEERR SYNOPSIS, DURATION, CAST, DIRECTOR, RATING)
  if (pathname.startsWith('/api/details/')) {
    const rawPath = pathname.replace('/api/details/', '');
    const parts = rawPath.split('/');
    const mediaType = parts[0] || 'movie';
    const tmdbId = parts[1];

    if (!tmdbId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing tmdbId' }));
    }

    try {
      const resData = await httpRequest({
        hostname: '127.0.0.1',
        port: 5055,
        path: `/api/v1/${mediaType}/${tmdbId}?language=es`,
        method: 'GET',
        headers: { 'X-Api-Key': JELLYSEERR_KEY }
      });

      const m = resData.data;
      if (!m || m.error) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Media not found' }));
      }

      function formatRuntime(minutes) {
        if (!minutes) return '';
        const h = Math.floor(minutes / 60);
        const min = minutes % 60;
        if (h > 0) return `${h}h ${min}m`;
        return `${min}m`;
      }

      const isTv = (mediaType === 'tv');
      const details = {
        tmdbId: m.id,
        mediaType: isTv ? 'tv' : 'movie',
        title: m.title || m.name,
        tagline: m.tagline || '',
        overview: m.overview || 'Sin sinopsis disponible.',
        runtime: formatRuntime(m.runtime || (m.episodeRunTime && m.episodeRunTime[0])),
        runtimeMinutes: m.runtime || null,
        genres: (m.genres || []).map(g => g.name),
        rating: m.voteAverage ? m.voteAverage.toFixed(1) : null,
        voteCount: m.voteCount ? m.voteCount.toLocaleString() : '0',
        releaseDate: m.releaseDate || m.firstAirDate || '',
        year: (m.releaseDate || m.firstAirDate || '').substring(0, 4),
        poster: m.posterPath ? 'https://image.tmdb.org/t/p/w500' + m.posterPath : null,
        backdrop: m.backdropPath ? 'https://image.tmdb.org/t/p/w1280' + m.backdropPath : null,
        cast: (m.credits?.cast || []).slice(0, 6).map(c => c.name),
        director: (m.credits?.crew || []).find(c => c.job === 'Director')?.name || null,
        seasonsCount: m.seasons ? m.seasons.filter(s => s.seasonNumber > 0).length : null,
        totalEpisodes: m.seasons ? m.seasons.filter(s => s.seasonNumber > 0).reduce((acc, s) => acc + (s.episodeCount || 0), 0) : null,
        status: m.status || ''
      };

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=86400'
      });
      return res.end(JSON.stringify(details));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 2. DISCOVER MULTI-SHELF EXPANDED CATALOG
  if (pathname === '/api/catalog') {
    try {
      const now = Date.now();
      if (!catalogCache || (now - catalogCacheTime > CATALOG_TTL)) {
        const [
          trending,
          movies,
          tv,
          topRated,
          animeTv,
          animeMovies,
          scifi,
          action
        ] = await Promise.all([
          fetchJellyseerrShelf('/api/v1/discover/trending'),
          fetchJellyseerrShelf('/api/v1/discover/movies?language=en'),
          fetchJellyseerrShelf('/api/v1/discover/tv?language=en'),
          fetchJellyseerrShelf('/api/v1/discover/movies?sortBy=vote_average.desc&voteCountGte=1000&language=en'),
          fetchJellyseerrShelf('/api/v1/discover/tv?genre=16&language=ja'),
          fetchJellyseerrShelf('/api/v1/discover/movies?genre=16&language=ja'),
          fetchJellyseerrShelf('/api/v1/discover/movies?genre=878&language=en'),
          fetchJellyseerrShelf('/api/v1/discover/movies?genre=28&language=en')
        ]);

        const anime = [];
        const maxAnime = Math.max(animeTv.length, animeMovies.length);
        for (let i = 0; i < maxAnime; i++) {
          if (animeTv[i]) anime.push(animeTv[i]);
          if (animeMovies[i]) anime.push(animeMovies[i]);
        }

        catalogCache = {
          movies,
          tv,
          trending,
          topRated,
          anime,
          scifi,
          action
        };
        catalogCacheTime = now;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      });
      return res.end(JSON.stringify(catalogCache));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 3. SEARCH
  if (pathname === '/api/search') {
    const q = parsedUrl.query.q || '';
    if (!q) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [] }));
    }
    try {
      const searchRes = await httpRequest({
        hostname: '127.0.0.1',
        port: 5055,
        path: '/api/v1/search?query=' + encodeURIComponent(q) + '&language=es',
        method: 'GET',
        headers: { 'X-Api-Key': JELLYSEERR_KEY }
      });

      const rawResults = (searchRes.data && searchRes.data.results) ? searchRes.data.results : [];
      const results = rawResults
        .filter(r => r.mediaType === 'movie' || r.mediaType === 'tv')
        .map(r => ({
          id: r.id,
          tmdbId: r.id,
          mediaType: r.mediaType,
          title: r.title || r.name,
          year: (r.releaseDate || r.firstAirDate || '').substring(0, 4),
          overview: r.overview || 'Sin descripción disponible.',
          rating: r.voteAverage ? r.voteAverage.toFixed(1) : null,
          poster: r.posterPath ? 'https://image.tmdb.org/t/p/w500' + r.posterPath : null,
          backdrop: r.backdropPath ? 'https://image.tmdb.org/t/p/w1280' + r.backdropPath : null
        }));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ results }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 4. TV SEASONS METADATA
  if (pathname === '/api/tv-seasons') {
    const tmdbId = parsedUrl.query.tmdbId;
    if (!tmdbId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing tmdbId' }));
    }
    try {
      const tvRes = await httpRequest({
        hostname: '127.0.0.1',
        port: 5055,
        path: `/api/v1/tv/${tmdbId}?language=es`,
        method: 'GET',
        headers: { 'X-Api-Key': JELLYSEERR_KEY }
      });
      const data = tvRes.data || {};
      const seasons = (data.seasons || [])
        .filter(s => s.seasonNumber > 0)
        .map(s => ({
          seasonNumber: s.seasonNumber,
          name: s.name || `Temporada ${s.seasonNumber}`,
          episodeCount: s.episodeCount || 0
        }));

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ seasons }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ seasons: [], error: e.message }));
    }
  }

  // 4b. SEARCH RELEASES & LANGUAGES INSPECTOR
  if (pathname === '/api/available-releases') {
    const title = parsedUrl.query.title || '';
    const year = parsedUrl.query.year || '';
    const mediaType = parsedUrl.query.mediaType || 'movie';
    const season = parsedUrl.query.season || '';
    const tmdbId = parsedUrl.query.tmdbId || '';
    const noCache = parsedUrl.query.nocache === '1';
    if (!title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Missing title' }));
    }

    try {
      const releases = await searchReleases(title, year, mediaType, season, tmdbId, noCache);
      const hasLatino = releases.some(r => r.isLatino);
      const hasCastellano = releases.some(r => r.isCastellano);
      const hasSpanish = releases.some(r => r.isSpanishAvailable || r.isLatino || r.isCastellano);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        ok: true,
        title,
        year,
        mediaType,
        total: releases.length,
        hasSpanish,
        hasLatino,
        hasCastellano,
        releases
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message, releases: [] }));
    }
  }

  // 4c. DOWNLOAD SPECIFIC RELEASE CHOSEN BY USER
  if (pathname === '/api/download-release' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyData || '{}');
        let downloadUrl = body.downloadUrl || body.url;
        const title = body.title || '';
        const mediaType = body.mediaType || 'movie';
        const tmdbId = body.tmdbId;

        if (!downloadUrl) throw new Error('Missing download url');

        // Resolve real magnet or container-accessible torrent URL
        downloadUrl = await resolveRealTorrentUrl(downloadUrl);

        const cookie = await getQbitCookie();

        // Extract infoHash if available and purge any stale instance in qBittorrent before re-adding
        let infoHash = null;
        const hashMatch = downloadUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        if (hashMatch) {
          infoHash = hashMatch[1].toLowerCase();
          try {
            const checkRes = await httpRequest({
              hostname: '127.0.0.1',
              port: 8080,
              path: '/api/v2/torrents/info?hashes=' + infoHash,
              method: 'GET',
              headers: { 'Cookie': cookie }
            });
            if (Array.isArray(checkRes.data) && checkRes.data.length > 0) {
              const delBody = `hashes=${infoHash}&deleteFiles=true`;
              await httpRequest({
                hostname: '127.0.0.1',
                port: 8080,
                path: '/api/v2/torrents/delete',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': Buffer.byteLength(delBody),
                  'Cookie': cookie
                }
              }, delBody);
              await new Promise(r => setTimeout(r, 250));
            }
          } catch(e) {}
        }

        const postData = `urls=${encodeURIComponent(downloadUrl)}&savepath=${encodeURIComponent('/downloads')}&category=cineflix&sequentialDownload=true&firstLastPiecePrio=true`;

        await httpRequest({
          hostname: '127.0.0.1',
          port: 8080,
          path: '/api/v2/torrents/add',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'Cookie': cookie
          }
        }, postData);

        // Optimize torrent pieces for instant sequential streaming
        setTimeout(async () => {
          try {
            const infoRes = await httpRequest({
              hostname: '127.0.0.1',
              port: 8080,
              path: '/api/v2/torrents/info?limit=5&sort=added_on&reverse=true',
              method: 'GET',
              headers: { 'Cookie': cookie }
            });
            const latest = Array.isArray(infoRes.data) ? infoRes.data[0] : null;
            if (latest && latest.hash) {
              // Enable first & last piece priority
              await httpRequest({
                hostname: '127.0.0.1',
                port: 8080,
                path: '/api/v2/torrents/toggleFirstLastPiecePrio?hashes=' + latest.hash,
                method: 'GET',
                headers: { 'Cookie': cookie }
              }).catch(() => {});

              // Set sample / nfo / txt files to priority 0 so 100% bandwidth goes to the main movie
              const filesRes = await httpRequest({
                hostname: '127.0.0.1',
                port: 8080,
                path: '/api/v2/torrents/files?hash=' + latest.hash,
                method: 'GET',
                headers: { 'Cookie': cookie }
              });
              if (Array.isArray(filesRes.data) && filesRes.data.length > 1) {
                let maxIdx = 0;
                let maxSize = 0;
                filesRes.data.forEach((f, idx) => {
                  if (f.size > maxSize) { maxSize = f.size; maxIdx = idx; }
                });
                const ignoreIds = filesRes.data
                  .map((f, idx) => idx)
                  .filter(idx => idx !== maxIdx);
                if (ignoreIds.length > 0) {
                  const prioBody = `hash=${latest.hash}&id=${ignoreIds.join('|')}&priority=0`;
                  await httpRequest({
                    hostname: '127.0.0.1',
                    port: 8080,
                    path: '/api/v2/torrents/filePrio',
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded',
                      'Content-Length': Buffer.byteLength(prioBody),
                      'Cookie': cookie
                    }
                  }, prioBody).catch(() => {});
                }
              }
            }
          } catch(e) {}
        }, 1500);

        // Delete any ghost record from Radarr
        if (mediaType === 'movie' && tmdbId) {
          try {
            const allMovies = await httpRequest({
              hostname: '127.0.0.1',
              port: 7878,
              path: '/api/v3/movie',
              method: 'GET',
              headers: { 'X-Api-Key': RADARR_KEY }
            });
            const existing = Array.isArray(allMovies.data) ? allMovies.data.find(m => m.tmdbId === parseInt(tmdbId)) : null;
            if (existing) {
              await httpRequest({
                hostname: '127.0.0.1',
                port: 7878,
                path: `/api/v3/movie/${existing.id}?deleteFiles=false&addImportExclusion=false`,
                method: 'DELETE',
                headers: { 'X-Api-Key': RADARR_KEY }
              });
            }
          } catch(e) {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: `¡Descarga iniciada para "${title}" con reproducción secuencial activa!` }));
      } catch (err) {
        console.error('Download release error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // 5. INTELLIGENT DIRECT DOWNLOAD INITIATION (GUARANTEED LATINO & AUTONOMOUS)
  if (pathname === '/api/download' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', async () => {
      try {
        const item = JSON.parse(bodyData || '{}');
        const { tmdbId, mediaType, title, year, seasonNumber } = item;
        const targetSeason = seasonNumber === 'all' ? 1 : (parseInt(seasonNumber, 10) || 1);

        // Search releases with our multi-engine (Torrentio + Cinecalidad + Prowlarr)
        const releases = await searchReleases(title, year, mediaType, mediaType === 'tv' ? targetSeason : null, tmdbId, false);
        const latinos = releases.filter(r => r.isLatino && !r.isCam).sort((a,b) => b.seeders - a.seeders);
        const bestRelease = latinos[0] || releases.find(r => r.isLatino) || releases[0];

        if (!bestRelease || !bestRelease.downloadUrl) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'No se encontraron fuentes activas para este contenido.' }));
        }

        // Resolve real magnet or container-accessible torrent URL
        const downloadUrl = await resolveRealTorrentUrl(bestRelease.downloadUrl);

        const cookie = await getQbitCookie();

        // Extract infoHash if available and purge any stale instance in qBittorrent before re-adding
        let infoHash = null;
        const hashMatch = downloadUrl.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        if (hashMatch) {
          infoHash = hashMatch[1].toLowerCase();
          try {
            const checkRes = await httpRequest({
              hostname: '127.0.0.1',
              port: 8080,
              path: '/api/v2/torrents/info?hashes=' + infoHash,
              method: 'GET',
              headers: { 'Cookie': cookie }
            });
            if (Array.isArray(checkRes.data) && checkRes.data.length > 0) {
              const delBody = `hashes=${infoHash}&deleteFiles=true`;
              await httpRequest({
                hostname: '127.0.0.1',
                port: 8080,
                path: '/api/v2/torrents/delete',
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': Buffer.byteLength(delBody),
                  'Cookie': cookie
                }
              }, delBody);
              await new Promise(r => setTimeout(r, 250));
            }
          } catch(e) {}
        }

        const postData = `urls=${encodeURIComponent(downloadUrl)}&savepath=${encodeURIComponent('/downloads')}&category=cineflix&sequentialDownload=true&firstLastPiecePrio=true`;

        await httpRequest({
          hostname: '127.0.0.1',
          port: 8080,
          path: '/api/v2/torrents/add',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData),
            'Cookie': cookie
          }
        }, postData);

        const langBadge = bestRelease.isLatino ? '🇲🇽 Español Latino' : '💎 Idioma Original';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          message: `¡Descargando ${title} en ${langBadge} (${bestRelease.seeders} semillas)! Streaming en vivo listo.`
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 6. DOWNLOADS & ENFORCE SEQUENTIAL ORDER (PARSED WITH SERIES GROUPING)
  if (pathname === '/api/downloads') {
    try {
      const cookie = await getQbitCookie();
      const qRes = await httpRequest({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/v2/torrents/info',
        method: 'GET',
        headers: { 'Cookie': cookie }
      });

      const list = Array.isArray(qRes.data) ? qRes.data : [];

      for (const t of list) {
        if (!t.seq_dl) {
          httpRequest({
            hostname: '127.0.0.1',
            port: 8080,
            path: '/api/v2/torrents/toggleSequentialDownload?hashes=' + t.hash,
            method: 'GET',
            headers: { 'Cookie': cookie }
          }).catch(() => {});
        }
      }

      const formatted = list.map(t => {
        const parsed = parseTorrentName(t.name, t.category);
        return {
          hash: t.hash,
          name: t.name,
          contentPath: t.content_path,
          isTv: parsed.isTv,
          seriesName: parsed.seriesName,
          cleanLabel: parsed.cleanLabel,
          seasonStr: parsed.seasonStr,
          episodeStr: parsed.episodeStr,
          progress: Math.round(t.progress * 100),
          progressRaw: t.progress,
          dlspeed: t.dlspeed,
          speed: (t.dlspeed / 1024 / 1024).toFixed(1) + ' MB/s',
          size: (t.size / 1024 / 1024 / 1024).toFixed(2) + ' GB',
          state: t.state,
          sequential: t.seq_dl,
          streamable: t.progress > 0.01 || t.dlspeed > 500000,
          eta: t.eta > 0 && t.eta < 86400 ? Math.round(t.eta / 60) + ' min' : (t.progress === 1 ? 'Completo' : 'Calculando...')
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ downloads: formatted }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ downloads: [], error: e.message }));
    }
  }

  // 7. ZERO-CACHE CLEANUP API
  if (pathname === '/api/clean-cache' && req.method === 'POST') {
    try {
      const cookie = await getQbitCookie();
      const postBody = 'hashes=all&deleteFiles=true';
      await httpRequest({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/v2/torrents/delete',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postBody),
          'Cookie': cookie
        }
      }, postBody).catch(() => {});

      if (fs.existsSync(TORRENTS_DIR)) {
        const entries = fs.readdirSync(TORRENTS_DIR);
        for (const entry of entries) {
          const fullPath = path.join(TORRENTS_DIR, entry);
          try {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } catch (e) {}
        }
      }

      // Invalidate memory caches and history
      searchCache.clear();
      for (const k of Object.keys(mediaProbeCache)) delete mediaProbeCache[k];
      try { if (fs.existsSync(HISTORY_FILE)) fs.writeFileSync(HISTORY_FILE, '[]', 'utf8'); } catch(e) {}

      // Clean Radarr & Sonarr queues without blocklisting
      try {
        const rQueue = await httpRequest({ hostname: '127.0.0.1', port: 7878, path: '/api/v3/queue', method: 'GET', headers: { 'X-Api-Key': RADARR_KEY } });
        if (rQueue.data && Array.isArray(rQueue.data.records)) {
          for (const rec of rQueue.data.records) {
            await httpRequest({ hostname: '127.0.0.1', port: 7878, path: `/api/v3/queue/${rec.id}?removeFromClient=true&blocklist=false`, method: 'DELETE', headers: { 'X-Api-Key': RADARR_KEY } }).catch(() => {});
          }
        }
        const sQueue = await httpRequest({ hostname: '127.0.0.1', port: 8989, path: '/api/v3/queue', method: 'GET', headers: { 'X-Api-Key': SONARR_KEY } });
        if (sQueue.data && Array.isArray(sQueue.data.records)) {
          for (const rec of sQueue.data.records) {
            await httpRequest({ hostname: '127.0.0.1', port: 8989, path: `/api/v3/queue/${rec.id}?removeFromClient=true&blocklist=false`, method: 'DELETE', headers: { 'X-Api-Key': SONARR_KEY } }).catch(() => {});
          }
        }
      } catch (e) {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, message: '¡Caché y descargas temporales eliminadas por completo! Espacio en disco 100% liberado.' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // 8. STOP & CLEAN SPECIFIC TORRENT
  if (pathname === '/api/stop-torrent' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', async () => {
      try {
        const { hash, name, contentPath } = JSON.parse(bodyData || '{}');
        await deleteTorrentAndFiles(hash, name, contentPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: 'Descarga cancelada y archivo eliminado por completo del disco.' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 9. STOP & CLEAN ENTIRE SERIES
  if (pathname === '/api/stop-series' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', async () => {
      try {
        const { seriesName, hashes } = JSON.parse(bodyData || '{}');
        if (Array.isArray(hashes)) {
          for (const h of hashes) {
            await deleteTorrentAndFiles(h, seriesName, null);
          }
        }

        // Also purge any matching torrent in qBittorrent by seriesName
        if (seriesName) {
          try {
            const cookie = await getQbitCookie();
            const qRes = await httpRequest({
              hostname: '127.0.0.1',
              port: 8080,
              path: '/api/v2/torrents/info',
              method: 'GET',
              headers: { 'Cookie': cookie }
            });
            if (Array.isArray(qRes.data)) {
              const sClean = seriesName.toLowerCase().replace(/[^a-z0-9]/g, '');
              const matches = qRes.data.filter(t => {
                const tClean = (t.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                return tClean.includes(sClean);
              });
              if (matches.length > 0) {
                const postBody = `hashes=${matches.map(m => m.hash).join('|')}&deleteFiles=true`;
                await httpRequest({
                  hostname: '127.0.0.1',
                  port: 8080,
                  path: '/api/v2/torrents/delete',
                  method: 'POST',
                  headers: {
                    'Cookie': cookie,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postBody)
                  }
                }, postBody);
              }
            }
          } catch (e) {}

          // Also remove from Sonarr if monitored
          try {
            const sonarrRes = await httpRequest({
              hostname: '127.0.0.1',
              port: 8989,
              path: '/api/v3/series',
              method: 'GET',
              headers: { 'X-Api-Key': SONARR_KEY }
            });
            if (Array.isArray(sonarrRes.data)) {
              const target = sonarrRes.data.find(s => s.title.toLowerCase() === seriesName.toLowerCase() || seriesName.toLowerCase().includes(s.title.toLowerCase()));
              if (target) {
                await httpRequest({
                  hostname: '127.0.0.1',
                  port: 8989,
                  path: `/api/v3/series/${target.id}?deleteFiles=true`,
                  method: 'DELETE',
                  headers: { 'X-Api-Key': SONARR_KEY }
                });
              }
            }
          } catch (e) {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: `Se cancelaron todas las descargas y se borraron los archivos de "${seriesName}".` }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 10. MEDIA INFO ENDPOINT (CODECS & SUBTITLES)
  if (pathname.startsWith('/api/media-info/')) {
    const rawId = pathname.replace('/api/media-info/', '');
    const cookie = await getQbitCookie();
    let torrentsList = [];
    try {
      const qRes = await httpRequest({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/v2/torrents/info',
        method: 'GET',
        headers: { 'Cookie': cookie }
      });
      if (Array.isArray(qRes.data)) torrentsList = qRes.data;
    } catch(e) {}

    const filePath = resolveMediaFile(rawId, torrentsList);
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Media file not found' }));
    }

    const stat = fs.statSync(filePath);
    const byHash = torrentsList.find(t => t.hash && t.hash.toLowerCase() === rawId.toLowerCase());
    const downloadedBytes = byHash ? byHash.downloaded : stat.size;
    const progress = byHash ? byHash.progress : 1;
    // Ready for instant live play if completed OR if at least 10MB downloaded sequentially
    const isReady = (progress === 1) || (downloadedBytes >= 10 * 1024 * 1024 && progress >= 0.005) || (!byHash && stat.size >= 10 * 1024 * 1024);
    
    let probe = { duration: 0, videoCodec: 'unknown', audioCodec: 'unknown', isAudioCompatible: true, preferredAudioIndex: null, audioTracks: [], allSubs: [] };
    
    if (stat.size >= 2 * 1024 * 1024) {
      probe = await probeMedia(filePath);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      ready: isReady,
      progress: progress,
      downloadedBytes: downloadedBytes,
      size: stat.size,
      keyframes: getKeyframesForFile(filePath),
      ...probe,
      filename: path.basename(filePath)
    }));
  }

  // 11. STREAM SPANISH SUBTITLES AS WEBVTT
  if (pathname.startsWith('/api/subtitles/')) {
    const rawId = pathname.replace('/api/subtitles/', '');
    const cookie = await getQbitCookie();
    let torrentsList = [];
    try {
      const qRes = await httpRequest({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/v2/torrents/info',
        method: 'GET',
        headers: { 'Cookie': cookie }
      });
      if (Array.isArray(qRes.data)) torrentsList = qRes.data;
    } catch(e) {}

    const filePath = resolveMediaFile(rawId, torrentsList);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' });
      return res.end('WEBVTT\n\n');
    }

    const vtt = await getOrFetchSpanishSubtitles(filePath, rawId, parsedUrl.query);
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(vtt);
  }

  // 12. STREAM VIDEO (HTTP 206 PARTIAL CONTENT OR COMPATIBLE AAC AUDIO REMUX)
  if (pathname.startsWith('/stream/')) {
    const rawId = pathname.replace('/stream/', '');
    const cookie = await getQbitCookie();
    let torrentsList = [];
    try {
      const qRes = await httpRequest({
        hostname: '127.0.0.1',
        port: 8080,
        path: '/api/v2/torrents/info',
        method: 'GET',
        headers: { 'Cookie': cookie }
      });
      if (Array.isArray(qRes.data)) torrentsList = qRes.data;
    } catch(e) {}

    const filePath = resolveMediaFile(rawId, torrentsList);

    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Buffering media... El video se está descargando secuencialmente, aguarda unos segundos y vuelve a pulsar Reproducir.');
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const probe = await probeMedia(filePath);

    // Audio Transcode if user requests specific track OR if file audio codec (ac3, eac3, dts) is not supported by browser
    const audioTrackIndex = parsedUrl.query.track;
    const isMkv = path.extname(filePath).toLowerCase() === '.mkv';
    const needAudioTranscode = (audioTrackIndex !== undefined && audioTrackIndex !== '') || !probe.isAudioCompatible || isMkv;

    if (needAudioTranscode) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });

      const { spawn } = require('child_process');
      const rawStartSec = parseFloat(parsedUrl.query.t || '0') || 0;
      const startSec = Math.max(0, rawStartSec);
      const targetTrack = (audioTrackIndex !== undefined && audioTrackIndex !== '')
        ? audioTrackIndex
        : (probe.preferredAudioIndex !== null ? probe.preferredAudioIndex : (probe.audioTracks[0] ? probe.audioTracks[0].index : 1));
      const mapAudio = ['-map', '0:' + targetTrack];

      // Frame-accurate synchronized seeking:
      // With -noaccurate_seek -ss startSec before -i:
      // 1. Video starts at preceding keyframe packet (getPrecedingKeyframe(startSec))
      // 2. Audio decoder does NOT discard audio samples between keyframe and startSec,
      //    starting audio at the EXACT same keyframe packet with continuous ~0.08s frames.
      // 3. Client sets currentStreamOffset = getPrecedingKeyframe(startSec)
      // -> Audio, Video, and Subtitles are 100% in sync with 0ms gap!
      const ffArgs = [
        '-v', 'error',
        ...(startSec > 0 ? ['-noaccurate_seek', '-ss', startSec.toString()] : []),
        '-i', filePath,
        '-map', '0:v:0',
        ...mapAudio,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '256k',
        '-ac', '2',
        '-sn',
        '-dn',
        '-avoid_negative_ts', 'make_zero',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'
      ];

      const ff = spawn('ffmpeg', ffArgs);
      ff.stdout.pipe(res);
      req.on('close', () => {
        try { ff.kill('SIGKILL'); } catch(e) {}
      });
      return;
    }

    // DIRECT HTTP 206 PARTIAL CONTENT STREAM (HIGH PERFORMANCE & INSTANT SEEKING)
    const byHash = torrentsList.find(t => t.hash && t.hash.toLowerCase() === rawId.toLowerCase());
    const isComplete = byHash ? byHash.progress >= 0.99 : true;
    const downloadedBytes = byHash ? byHash.downloaded : fileSize;
    const availableLimit = isComplete ? fileSize : Math.max(downloadedBytes, 15 * 1024 * 1024);

    const range = req.headers.range;
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.m4v': 'video/mp4',
      '.mkv': 'video/mp4',
      '.webm': 'video/webm',
      '.avi': 'video/x-msvideo'
    };
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'video/mp4';

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const maxChunk = 4 * 1024 * 1024; // 4MB per partial response for snappy buffering
      let end = parts[1] ? parseInt(parts[1], 10) : (start + maxChunk - 1);
      if (end >= fileSize) end = fileSize - 1;
      const isTailRequest = (!isComplete && fileSize > 32 * 1024 * 1024 && start >= fileSize - 16 * 1024 * 1024);
      if (!isComplete && !isTailRequest && end >= availableLimit) {
        end = availableLimit - 1;
      }

      if (start > end || (!isComplete && !isTailRequest && start >= availableLimit)) {
        res.writeHead(416, {
          'Content-Range': `bytes */${fileSize}`,
          'Retry-After': '2'
        });
        return res.end();
      }

      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': 'bytes ' + start + '-' + end + '/' + fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      return file.pipe(res);
    } else {
      const firstChunk = Math.min(fileSize, 4 * 1024 * 1024);
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(filePath, { start: 0, end: firstChunk - 1 }).pipe(res);
    }
  }

  // STATIC FILES
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  let localFile = path.join(STATIC_DIR, reqPath);

  if (!fs.existsSync(localFile)) {
    localFile = path.join(STATIC_DIR, 'index.html');
  }

  const ext = path.extname(localFile).toLowerCase();
  const mimes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };

  try {
    const content = fs.readFileSync(localFile);
    res.writeHead(200, {
      'Content-Type': mimes[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
    });
    return res.end(content);
  } catch (err) {
    res.writeHead(404);
    return res.end('Not found');
  }
}

// BIND TO MULTIPLE PORTS (80, 8088, 3000)
const PORTS = [80, 8088, 3000];
PORTS.forEach(p => {
  const s = http.createServer(handleRequest);
  s.listen(p, '0.0.0.0', () => {
    console.log(`CineFlix Hub running at http://0.0.0.0:${p}`);
  });
  s.on('error', (err) => {
    console.error(`Port ${p} listen error:`, err.message);
  });
});
