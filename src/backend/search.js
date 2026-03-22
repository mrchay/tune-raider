/**
 * search.js — YouTube Music search & candidate scoring.
 * Ported from the original track-selector.js.
 *
 * Uses yt-dlp to search YouTube Music, gathers candidates,
 * scores them against expected track metadata, returns ranked results.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Scoring weights ──

const SCORES = {
  DURATION_EXACT:    300,
  DURATION_CLOSE:    200,
  DURATION_NEAR:     100,
  DURATION_NEUTRAL:    0,
  DURATION_FAR:     -100,
  DURATION_VERY_FAR: -300,

  TOPIC_CHANNEL:     150,
  OFFICIAL_CHANNEL:   50,
  ARTIST_CHANNEL:    100,

  TRACK_META_MATCH:  100,
  ALBUM_MATCH:        80,
  TITLE_CONTAINS:     50,
  CLEAN_TITLE:        50,

  OFFICIAL_AUDIO:     30,
  OFFICIAL_VIDEO:     20,
  LYRIC_VIDEO:       -30,

  HARD_REJECT:     -1000,
  SOFT_PENALTY:     -200,
  EXTRA_QUALIFIER: -120,
  YEAR_IN_TITLE:     -50,
  LIVE_ALBUM:       -100,
};

const HARD_REJECT_KEYWORDS = [
  'karaoke', 'cover', 'instrumental', 'tribute', 'in the style of',
  'made famous', 'backing track',
];

const SOFT_PENALTY_KEYWORDS = [
  'live', 'concert', 'acoustic', 'unplugged', 'remix', 'extended mix',
  'extended version', 'radio edit', 'remaster', 'remastered',
  'demo', 'rehearsal', 'session', 'bootleg', 'mashup',
];

const LIVE_PAREN_RE = /[(\[]live[\s,)at\]]/i;
const YEAR_PAREN_RE = /[(\[](19|20)\d{2}[)\]]/;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── Helpers ──

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function containsKeyword(text, keyword) {
  return normalize(text).includes(normalize(keyword));
}

function keywordInOriginal(keyword, track) {
  const fields = [track.title, track.album].filter(Boolean).join(' ');
  return containsKeyword(fields, keyword);
}

function isTopicChannel(candidate) {
  if (candidate.channel && candidate.channel.endsWith('- Topic')) return true;
  if (candidate.meta_artist && candidate.meta_artist !== 'NA' &&
      candidate.meta_album && candidate.meta_album !== 'NA' &&
      candidate.meta_track && candidate.meta_track !== 'NA') return true;
  return false;
}

function extractVideoId(url) {
  if (!url) return null;
  const m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── yt-dlp interface ──

function getYtdlpPath() {
  const toolsPath = path.join(__dirname, 'tools', 'yt-dlp.exe');
  if (fs.existsSync(toolsPath)) return toolsPath;
  // Fallback: try PATH
  return 'yt-dlp';
}

function getCookiesPath(workspacePath) {
  const p = path.join(workspacePath, 'cookies.txt');
  return fs.existsSync(p) ? p : null;
}

function runYtdlp(args, opts = {}) {
  const ytdlp = getYtdlpPath();
  const cleanArgs = args.map(a => a.replace(/^"|"$/g, ''));
  return new Promise((resolve) => {
    execFile(ytdlp, cleanArgs, {
      cwd: opts.cwd || __dirname,
      timeout: opts.timeout || 60000,
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? (error.code || 1) : 0,
        stdout: stdout ? stdout.toString('utf-8') : '',
        stderr: stderr ? stderr.toString('utf-8') : '',
        error,
      });
    });
  });
}

function buildBaseArgs(workspacePath) {
  const args = [
    '--user-agent', USER_AGENT,
    '--referer', 'https://music.youtube.com/',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web_music',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
  ];
  const cookies = getCookiesPath(workspacePath);
  if (cookies) {
    args.unshift('--cookies', cookies);
  }
  return args;
}

// ── Search queries ──

function buildSearches(track) {
  const ytmSearch = (q) => `https://music.youtube.com/search?q=${encodeURIComponent(q)}`;
  return [
    { label: 'ytm:track-artist',  query: ytmSearch(`${track.title} ${track.artist}`) },
    { label: 'ytm:with-album',    query: ytmSearch(`${track.artist} ${track.title} ${track.album}`) },
    { label: 'yt:official-audio', query: `ytsearch5:${track.artist} ${track.title} official audio` },
  ];
}

// ── Gather candidates ──

async function gatherCandidates(track, workspacePath, log, opts = {}) {
  const maxPerSearch = opts.maxPerSearch || 5;
  const searches = buildSearches(track);
  const seen = new Set();
  const candidates = [];
  const baseArgs = buildBaseArgs(workspacePath);

  const printTemplate = [
    '%(title)s', '%(webpage_url)s', '%(duration)s', '%(channel)s',
    '%(channel_id)s', '%(album)s', '%(artist)s', '%(track)s', '%(upload_date)s',
  ].join('|||');

  for (const [searchIdx, search] of searches.entries()) {
    const t0 = Date.now();
    log(`  [search ${searchIdx + 1}/${searches.length}] ${search.label}...`);

    const result = await runYtdlp([
      ...baseArgs,
      '--playlist-items', `1:${maxPerSearch}`,
      '--print', printTemplate,
      '--no-download',
      search.query,
    ], { timeout: 60000 });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    if (result.status !== 0 || !result.stdout?.trim()) {
      log(`    No results (${elapsed}s, exit=${result.status})`);
      if (result.stderr) {
        const errLines = result.stderr.trim().split('\n').slice(0, 3);
        errLines.forEach(l => log(`    ${l}`));
      }
      continue;
    }

    const lines = result.stdout.trim().split('\n');
    for (const line of lines) {
      const parts = line.split('|||');
      if (parts.length < 9) continue;

      const [title, url, duration, channel, channelId, album, artist, metaTrack, uploadDate] = parts;
      const videoId = extractVideoId(url);

      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);

      candidates.push({
        title: title || '',
        url: url || '',
        videoId,
        duration: parseFloat(duration) || 0,
        channel: channel || '',
        channelId: channelId || '',
        meta_album: album || 'NA',
        meta_artist: artist || 'NA',
        meta_track: metaTrack || 'NA',
        uploadDate: uploadDate || '',
        source: search.label,
      });
    }

    log(`    ${lines.length} results, ${candidates.length} unique total (${elapsed}s)`);
  }

  return candidates;
}

// ── Score a candidate ──

function scoreCandidate(candidate, track) {
  let score = 0;
  const breakdown = {};
  const title = candidate.title;
  const normTitle = normalize(title);
  const normTrack = normalize(track.title);
  const normArtist = normalize(track.artist);

  // Hard reject keywords
  for (const kw of HARD_REJECT_KEYWORDS) {
    if (containsKeyword(title, kw) && !keywordInOriginal(kw, track)) {
      score += SCORES.HARD_REJECT;
      breakdown.hardReject = `"${kw}" → ${SCORES.HARD_REJECT}`;
      return { score, breakdown };
    }
  }

  // Soft penalty keywords
  for (const kw of SOFT_PENALTY_KEYWORDS) {
    if (containsKeyword(title, kw) && !keywordInOriginal(kw, track)) {
      score += SCORES.SOFT_PENALTY;
      breakdown[`soft_${kw}`] = SCORES.SOFT_PENALTY;
    }
    if (kw === 'live' && candidate.meta_album && containsKeyword(candidate.meta_album, 'live') && !keywordInOriginal('live', track)) {
      score += SCORES.LIVE_ALBUM;
      breakdown.liveAlbum = SCORES.LIVE_ALBUM;
    }
  }

  if (LIVE_PAREN_RE.test(title) && !keywordInOriginal('live', track)) {
    if (!breakdown.soft_live) {
      score += SCORES.SOFT_PENALTY;
      breakdown.liveParen = SCORES.SOFT_PENALTY;
    }
  }

  if (YEAR_PAREN_RE.test(title)) {
    score += SCORES.YEAR_IN_TITLE;
    breakdown.yearInTitle = SCORES.YEAR_IN_TITLE;
  }

  // Duration matching
  if (track.duration_ms && candidate.duration > 0) {
    const expectedSec = track.duration_ms / 1000;
    const diff = Math.abs(candidate.duration - expectedSec);

    if (diff <= 2)        { score += SCORES.DURATION_EXACT;    breakdown.duration = `±${diff.toFixed(1)}s → +${SCORES.DURATION_EXACT}`; }
    else if (diff <= 5)   { score += SCORES.DURATION_CLOSE;    breakdown.duration = `±${diff.toFixed(1)}s → +${SCORES.DURATION_CLOSE}`; }
    else if (diff <= 10)  { score += SCORES.DURATION_NEAR;     breakdown.duration = `±${diff.toFixed(1)}s → +${SCORES.DURATION_NEAR}`; }
    else if (diff <= 30)  { score += SCORES.DURATION_NEUTRAL;  breakdown.duration = `±${diff.toFixed(1)}s → +${SCORES.DURATION_NEUTRAL}`; }
    else if (diff <= 120) { score += SCORES.DURATION_FAR;      breakdown.duration = `±${diff.toFixed(1)}s → ${SCORES.DURATION_FAR}`; }
    else                  { score += SCORES.DURATION_VERY_FAR; breakdown.duration = `±${diff.toFixed(1)}s → ${SCORES.DURATION_VERY_FAR}`; }
  }

  // Channel/source scoring
  if (isTopicChannel(candidate)) {
    score += SCORES.TOPIC_CHANNEL;
    breakdown.topicChannel = SCORES.TOPIC_CHANNEL;
  } else {
    const normChannel = normalize(candidate.channel);
    if (normChannel.includes(normArtist) || normArtist.includes(normChannel)) {
      score += SCORES.ARTIST_CHANNEL;
      breakdown.artistChannel = SCORES.ARTIST_CHANNEL;
    }
    if (candidate.channel.toLowerCase().includes('vevo')) {
      score += SCORES.OFFICIAL_CHANNEL;
      breakdown.vevo = SCORES.OFFICIAL_CHANNEL;
    }
  }

  // Metadata matching
  if (candidate.meta_track !== 'NA') {
    const normMetaTrack = normalize(candidate.meta_track);
    if (normMetaTrack === normTrack || normMetaTrack.includes(normTrack) || normTrack.includes(normMetaTrack)) {
      score += SCORES.TRACK_META_MATCH;
      breakdown.trackMetaMatch = SCORES.TRACK_META_MATCH;
    }
  }

  if (candidate.meta_album !== 'NA' && track.album) {
    const normAlbum = normalize(candidate.meta_album);
    const normExpAlbum = normalize(track.album);
    if (normAlbum === normExpAlbum || normAlbum.includes(normExpAlbum) || normExpAlbum.includes(normAlbum)) {
      score += SCORES.ALBUM_MATCH;
      breakdown.albumMatch = SCORES.ALBUM_MATCH;
    }
  }

  if (normTitle.includes(normTrack) && normTitle.includes(normArtist)) {
    score += SCORES.TITLE_CONTAINS;
    breakdown.titleContains = SCORES.TITLE_CONTAINS;
  } else if (normTitle.includes(normTrack)) {
    score += Math.floor(SCORES.TITLE_CONTAINS / 2);
    breakdown.titlePartial = Math.floor(SCORES.TITLE_CONTAINS / 2);
  }

  // Clean title check
  const extraParens = title.replace(track.title, '').match(/[(\[].+?[)\]]/g);
  if (!extraParens || extraParens.length === 0) {
    score += SCORES.CLEAN_TITLE;
    breakdown.cleanTitle = SCORES.CLEAN_TITLE;
  } else {
    for (const paren of extraParens) {
      const parenContent = paren.replace(/[(\[\])]/g, '').trim().toLowerCase();
      if (['official audio', 'official video', 'official hd video', 'official music video',
           'hq', 'hd', '4k', 'audio'].some(ok => parenContent.includes(ok))) continue;
      const normOriginal = normalize(track.title);
      if (!normOriginal.includes(normalize(parenContent))) {
        score += SCORES.EXTRA_QUALIFIER;
        breakdown[`extraQual_${parenContent.slice(0, 20)}`] = SCORES.EXTRA_QUALIFIER;
      }
    }
  }

  // Version preference
  const titleLower = title.toLowerCase();
  if (titleLower.includes('official audio')) {
    score += SCORES.OFFICIAL_AUDIO;
    breakdown.officialAudio = SCORES.OFFICIAL_AUDIO;
  } else if (titleLower.includes('official video') || titleLower.includes('official hd')) {
    score += SCORES.OFFICIAL_VIDEO;
    breakdown.officialVideo = SCORES.OFFICIAL_VIDEO;
  }
  if (titleLower.includes('lyric video') || titleLower.includes('lyrics')) {
    score += SCORES.LYRIC_VIDEO;
    breakdown.lyricVideo = SCORES.LYRIC_VIDEO;
  }

  return { score, breakdown };
}

// ── Search a single track ──

async function searchTrack(track, workspacePath, log) {
  const t0 = Date.now();
  log(`Searching: "${track.artist} - ${track.title}" [${track.album || '?'}]`);

  const candidates = await gatherCandidates(track, workspacePath, log);

  if (candidates.length === 0) {
    log(`  No candidates found`);
    return { candidates: [], best: null };
  }

  // Score and rank
  const ranked = candidates.map(c => {
    const { score, breakdown } = scoreCandidate(c, track);
    return { ...c, score, breakdown };
  }).sort((a, b) => b.score - a.score);

  // Log top results
  const top = ranked.slice(0, 5);
  log(`  Top ${top.length} of ${ranked.length} candidates:`);
  for (const [i, c] of top.entries()) {
    log(`    #${i + 1} [${c.score}pts] "${c.title}" (${formatDuration(c.duration)}) ch:${c.channel}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const best = ranked[0];
  if (best.score < 50) {
    log(`  Warning: best score ${best.score} is below threshold (${elapsed}s)`);
  } else {
    log(`  Selected: "${best.title}" [${best.score}pts] (${elapsed}s)`);
  }

  // Format for DB storage
  const dbCandidates = ranked.map((c, i) => ({
    url: c.url,
    videoTitle: c.title,
    channel: c.channel,
    channelType: isTopicChannel(c) ? 'Topic' : (c.channel.toLowerCase().includes('vevo') ? 'VEVO' : ''),
    duration: c.duration,
    durationText: formatDuration(c.duration),
    score: c.score,
    breakdown: c.breakdown,
    thumbnailUrl: '',
  }));

  return { candidates: dbCandidates, best: dbCandidates[0] };
}

module.exports = {
  searchTrack,
  scoreCandidate,
  gatherCandidates,
  SCORES,
};
