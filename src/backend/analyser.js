/**
 * analyser.js — Quality analysis and fingerprint identification.
 * Runs whatsmybitrate (spectrum analysis) and AcoustID (fingerprint matching).
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeFilename } = require('./utils');

const TOOLS_DIR = path.join(__dirname, 'tools');
const IDENTIFY_SCRIPT = path.join(TOOLS_DIR, 'identify.py');
const BITRATE_SCRIPT = path.join(TOOLS_DIR, 'whatsmybitrate.py');
const FPCALC_PATH = path.join(TOOLS_DIR, 'fpcalc.exe');
const FFPROBE_PATH = path.join(TOOLS_DIR, 'ffprobe.exe');

// ── Config ──

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

function getAcoustIdKey() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return config.acoustid_api_key || '';
  } catch {
    return '';
  }
}

// ── Quality analysis via whatsmybitrate ──

async function analyseQuality(filePath, track, workspacePath, log) {
  const tmpDir = path.join(os.tmpdir(), 'tuneraider-analyse-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });

  log('Running quality analysis...');

  // Run in CSV mode for data
  const csvResult = await runPython([
    BITRATE_SCRIPT, filePath, '-c', '-n', '--ffprobe-path', FFPROBE_PATH,
  ], { timeout: 120000, cwd: tmpDir });

  if (csvResult.stderr?.trim()) {
    log(`  Quality stderr: ${csvResult.stderr.trim().slice(0, 300)}`);
  }

  // Parse CSV data
  let data = null;
  if (csvResult.status === 0) {
    try {
      const reportDirs = fs.readdirSync(tmpDir)
        .filter(d => d.startsWith('whatsmybitrate_report_'));

      for (const rd of reportDirs) {
        const rdPath = path.join(tmpDir, rd);
        const files = fs.readdirSync(rdPath);
        const csvFile = files.find(f => f.endsWith('.csv'));

        if (csvFile) {
          const csvContent = fs.readFileSync(path.join(rdPath, csvFile), 'utf-8');
          const lines = csvContent.split(/\r?\n/).filter(Boolean);
          if (lines.length >= 2) {
            const headers = parseCSVLine(lines[0]);
            const values = parseCSVLine(lines[1]);
            data = {};
            headers.forEach((h, i) => { data[h] = values[i] || 'N/A'; });

            log(`  Quality: codec=${data['Codec']} rate=${data['Sample Rate (Hz)']}Hz ` +
                `peak=${data['Peak Frequency (Hz)']}Hz est=${data['Estimated Quality']} ` +
                `lossless=${data['Lossless']}`);
            break;
          }
        }
      }
    } catch (e) {
      log(`  Quality report parse error: ${e.message}`);
    }
  } else {
    log(`  Quality analysis failed (exit ${csvResult.status})`);
  }

  // Clean CSV temp output before spectrogram run
  rmDir(tmpDir);

  return data;
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── Fingerprint identification via AcoustID ──

async function identifyFingerprint(filePath, expectedArtist, expectedTitle, log) {
  const apiKey = getAcoustIdKey();
  if (!apiKey) {
    log('  Fingerprint: skipped (no AcoustID API key configured)');
    return null;
  }

  log('Running fingerprint identification...');

  const result = await runPython([
    IDENTIFY_SCRIPT, filePath, FPCALC_PATH,
  ], {
    timeout: 60000,
    env: { ...process.env, ACOUSTID_API_KEY: apiKey },
  });

  if (result.stderr?.trim()) {
    log(`  Fingerprint stderr: ${result.stderr.trim().slice(0, 300)}`);
  }
  if (result.status !== 0 || !result.stdout?.trim()) {
    log(`  Fingerprint failed (exit ${result.status})`);
    return null;
  }

  try {
    const data = JSON.parse(result.stdout);
    if (data.error) {
      log(`  Fingerprint error: ${data.error}`);
      return null;
    }

    const top = data.matches?.[0];
    if (!top) {
      log('  Fingerprint: no matches found');
      return { matches: [], verified: false, topMatch: null };
    }

    // Check if top match matches expected
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const expA = norm(expectedArtist);
    const expT = norm(expectedTitle);
    const matchA = norm(top.artist);
    const matchT = norm(top.title);

    const artistMatch = matchA.includes(expA) || expA.includes(matchA);
    const titleMatch = matchT.includes(expT) || expT.includes(matchT);
    const verified = artistMatch && titleMatch;

    const status = verified ? 'VERIFIED' : 'MISMATCH';
    log(`  Fingerprint: ${status} (${(top.confidence * 100).toFixed(1)}%) — ` +
        `"${top.artist} - ${top.title}"`);

    return {
      matches: data.matches.slice(0, 3),
      verified,
      topMatch: {
        artist: top.artist,
        title: top.title,
        albums: top.albums,
        confidence: top.confidence,
        recording_id: top.recording_id,
      },
    };
  } catch (e) {
    log(`  Fingerprint parse error: ${e.message}`);
    return null;
  }
}

// ── Full analysis (quality + fingerprint) ──

async function analyseTrack(opts) {
  const { filePath, track, workspacePath, onProgress } = opts;
  const log = onProgress || (() => {});

  log(`Analysing: "${track.artist} - ${track.title}"`);

  const quality = await analyseQuality(filePath, track, workspacePath, log);
  const fingerprint = await identifyFingerprint(filePath, track.artist, track.title, log);

  return { quality, fingerprint };
}

// ── Helpers ──

function runPython(args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...(opts.env || process.env), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    execFile('python', args, {
      timeout: opts.timeout || 120000,
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
      env,
      cwd: opts.cwd || __dirname,
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

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

module.exports = { analyseTrack, analyseQuality, identifyFingerprint };
