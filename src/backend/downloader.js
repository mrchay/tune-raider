/**
 * downloader.js — Downloads audio from YouTube using yt-dlp.
 * Takes a URL (from search candidates), downloads as FLAC with metadata.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { safeFilename } = require('./utils');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function getYtdlpPath() {
  const toolsPath = path.join(__dirname, 'tools', 'yt-dlp.exe');
  if (fs.existsSync(toolsPath)) return toolsPath;
  return 'yt-dlp';
}

function getCookiesPath(workspacePath) {
  const p = path.join(workspacePath, 'cookies.txt');
  return fs.existsSync(p) ? p : null;
}

/**
 * Download a track from YouTube.
 *
 * @param {object} opts
 * @param {string} opts.url - YouTube URL to download
 * @param {object} opts.track - { artist, title, album, playlist }
 * @param {string} opts.workspacePath - workspace root
 * @param {function} opts.onProgress - callback(message) for progress updates
 * @returns {Promise<{success, filePath, error}>}
 */
async function downloadTrack(opts) {
  const { url, track, workspacePath, onProgress } = opts;
  const log = onProgress || (() => {});

  // Rewrite to music.youtube.com for Premium streams
  const downloadUrl = url.replace('www.youtube.com', 'music.youtube.com');

  // Build output path using safe filename from DB
  const safePlaylist = safeFilename(track.playlist || 'Unknown');
  const safeName = track.safe_filename || safeFilename(`${track.artist} - ${track.title}`);
  const outputDir = path.join(workspacePath, 'downloads', safePlaylist);
  const outputPath = path.join(outputDir, `${safeName}.flac`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Temp directory for download
  const tempDir = path.join(workspacePath, 'temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  const tempTemplate = path.join(tempDir, `${safeName}.%(ext)s`);

  // Build yt-dlp args
  const args = [
    '--user-agent', USER_AGENT,
    '--referer', 'https://music.youtube.com/',
    '--js-runtimes', 'node',
    '--extractor-args', 'youtube:player_client=web_music',
    '--no-warnings',
    '--no-playlist',
    '--geo-bypass',
    '-f', 'ba',
    '-x', '--audio-format', 'flac',
    '--embed-metadata',
    '--embed-thumbnail',
    '-o', tempTemplate,
    '--newline',  // Progress on separate lines
    downloadUrl,
  ];

  const cookies = getCookiesPath(workspacePath);
  if (cookies) {
    args.unshift('--cookies', cookies);
  }

  log(`Downloading: ${track.artist} - ${track.title}`);
  log(`  URL: ${downloadUrl}`);

  // Run yt-dlp
  const result = await runYtdlp(args, {
    timeout: 300000,
    onStdout: (line) => {
      // Parse yt-dlp progress lines
      const pct = line.match(/(\d+(?:\.\d+)?)%/);
      if (pct) {
        log(`  ${line.trim()}`);
      } else if (line.includes('[download]') || line.includes('[ExtractAudio]') || line.includes('[Metadata]')) {
        log(`  ${line.trim()}`);
      }
    },
  });

  if (result.status !== 0) {
    const errMsg = result.stderr?.split('\n').filter(l => l.includes('ERROR')).join('; ') || 'Download failed';
    log(`  Download failed: ${errMsg}`);
    return { success: false, error: errMsg };
  }

  // Find the output file in temp
  const tempFiles = fs.readdirSync(tempDir).filter(f => f.startsWith(safeName));
  const flacFile = tempFiles.find(f => f.endsWith('.flac'));

  if (!flacFile) {
    // Check for any audio file
    const anyAudio = tempFiles.find(f => /\.(flac|opus|m4a|mp3|wav|ogg)$/i.test(f));
    if (anyAudio) {
      const tempPath = path.join(tempDir, anyAudio);
      const actualOutput = path.join(outputDir, anyAudio);
      fs.renameSync(tempPath, actualOutput);
      log(`  Saved: ${actualOutput} (not FLAC)`);
      cleanupTemp(tempDir, safeName);
      return { success: true, filePath: actualOutput };
    }
    log(`  No output file found in temp`);
    return { success: false, error: 'No output file found after download' };
  }

  // Move to final location
  const tempPath = path.join(tempDir, flacFile);
  fs.renameSync(tempPath, outputPath);
  log(`  Saved: ${outputPath}`);

  // Clean up remaining temp files
  cleanupTemp(tempDir, safeName);

  return { success: true, filePath: outputPath };
}

function runYtdlp(args, opts = {}) {
  const ytdlp = getYtdlpPath();
  const cleanArgs = args.map(a => a.replace(/^"|"$/g, ''));

  return new Promise((resolve) => {
    const proc = execFile(ytdlp, cleanArgs, {
      timeout: opts.timeout || 300000,
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? (error.code || 1) : 0,
        stdout: stdout ? stdout.toString('utf-8') : '',
        stderr: stderr ? stderr.toString('utf-8') : '',
        error,
      });
    });

    // Stream stdout for progress
    if (opts.onStdout && proc.stdout) {
      let buffer = '';
      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line
        for (const line of lines) {
          if (line.trim()) opts.onStdout(line);
        }
      });
    }
  });
}

function cleanupTemp(tempDir, prefix) {
  try {
    const leftovers = fs.readdirSync(tempDir).filter(f => f.startsWith(prefix));
    for (const f of leftovers) {
      fs.unlinkSync(path.join(tempDir, f));
    }
  } catch {}
}

module.exports = { downloadTrack };
