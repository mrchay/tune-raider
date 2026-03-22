const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const RELEASE_DIR = path.join(__dirname, 'release');
const SRC_DIR = path.join(__dirname, 'src');
const CACHE_DIR = path.join(__dirname, '.build-cache');

// Versions to bundle
const PYTHON_VERSION = '3.12.9';
const NODE_VERSION = '22.16.0';
const NWJS_VERSION = '0.109.0';

// Python packages — install librosa without numba/llvmlite (saves ~130 MB)
// librosa works fine without numba, just uses numpy fallbacks
const PIP_PACKAGES = [
  'pyacoustid', 'numpy', 'soundfile', 'scipy', 'matplotlib', 'tqdm',
  'librosa', 'scikit-learn', 'soxr', 'decorator', 'lazy_loader',
  'pooch', 'joblib', 'msgpack', 'typing_extensions',
];

async function build() {
  console.log('=== Tune Raider Release Build ===\n');

  // Clean release directory
  if (fs.existsSync(RELEASE_DIR)) {
    fs.rmSync(RELEASE_DIR, { recursive: true });
  }
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const buildDir = path.join(RELEASE_DIR, 'tune-raider');
  fs.mkdirSync(buildDir, { recursive: true });

  // ── Step 1: Download runtimes ──
  console.log('[1/8] Downloading runtimes...\n');

  const pythonZip = `python-${PYTHON_VERSION}-embed-amd64.zip`;
  const pythonUrl = `https://www.python.org/ftp/python/${PYTHON_VERSION}/${pythonZip}`;

  const nodeZip = `node-v${NODE_VERSION}-win-x64.zip`;
  const nodeUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${nodeZip}`;

  const nwjsZip = `nwjs-v${NWJS_VERSION}-win-x64.zip`;
  const nwjsUrl = `https://dl.nwjs.io/v${NWJS_VERSION}/${nwjsZip}`;

  await Promise.all([
    downloadIfMissing(pythonUrl, path.join(CACHE_DIR, pythonZip)),
    downloadIfMissing(nodeUrl, path.join(CACHE_DIR, nodeZip)),
    downloadIfMissing(nwjsUrl, path.join(CACHE_DIR, nwjsZip)),
  ]);

  // ── Step 2: Extract Python ──
  console.log('\n[2/8] Setting up embedded Python...');
  const pythonDir = path.join(buildDir, 'python');
  await extractZip(path.join(CACHE_DIR, pythonZip), pythonDir);

  // Enable pip in embedded Python: uncomment "import site" in python3XX._pth
  const pthFiles = fs.readdirSync(pythonDir).filter(f => f.match(/^python\d+\._pth$/));
  for (const pth of pthFiles) {
    const pthPath = path.join(pythonDir, pth);
    let content = fs.readFileSync(pthPath, 'utf-8');
    content = content.replace(/^#\s*import site/m, 'import site');
    if (!content.includes('Lib\\site-packages')) {
      content += '\nLib\\site-packages\n';
    }
    fs.writeFileSync(pthPath, content);
  }

  // Install pip via get-pip.py
  const getPipPath = path.join(CACHE_DIR, 'get-pip.py');
  await downloadIfMissing('https://bootstrap.pypa.io/get-pip.py', getPipPath);
  const pythonExe = path.join(pythonDir, 'python.exe');
  console.log('  Installing pip...');
  await run(`"${pythonExe}" "${getPipPath}" --no-warn-script-location`, { cwd: pythonDir });

  // Install setuptools+wheel (needed to build pyacoustid from source)
  console.log('  Installing setuptools...');
  await run(`"${pythonExe}" -m pip install --no-warn-script-location setuptools wheel`, { cwd: pythonDir });

  // Install Python packages — use --no-deps for librosa to avoid pulling in numba/llvmlite
  console.log('  Installing Python packages...');
  const packagesWithoutLibrosa = PIP_PACKAGES.filter(p => p !== 'librosa');
  await run(
    `"${pythonExe}" -m pip install --no-warn-script-location ${packagesWithoutLibrosa.join(' ')}`,
    { cwd: pythonDir }
  );
  // Install librosa separately with --no-deps to skip numba
  console.log('  Installing librosa (without numba)...');
  await run(
    `"${pythonExe}" -m pip install --no-warn-script-location --no-deps librosa`,
    { cwd: pythonDir }
  );

  // ── Step 3: Extract Node.js (only node.exe) ──
  console.log('\n[3/8] Setting up Node.js...');
  const nodeTempDir = path.join(RELEASE_DIR, '_node_temp');
  await extractZip(path.join(CACHE_DIR, nodeZip), nodeTempDir);
  const nodeExtracted = fs.readdirSync(nodeTempDir).find(d => d.startsWith('node-'));
  const nodeFullDir = path.join(nodeTempDir, nodeExtracted);

  // Only keep node.exe for runtime — npm is only needed at build time
  const nodeDir = path.join(buildDir, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.copyFileSync(path.join(nodeFullDir, 'node.exe'), path.join(nodeDir, 'node.exe'));

  // ── Step 4: Extract NW.js ──
  console.log('\n[4/8] Setting up NW.js...');
  const nwTempDir = path.join(RELEASE_DIR, '_nw_temp');
  await extractZip(path.join(CACHE_DIR, nwjsZip), nwTempDir);
  const nwExtracted = fs.readdirSync(nwTempDir).find(d => d.startsWith('nwjs-'));
  const nwDir = path.join(buildDir, 'nwjs');
  fs.renameSync(path.join(nwTempDir, nwExtracted), nwDir);
  fs.rmSync(nwTempDir, { recursive: true });

  // ── Step 5: Copy application source ──
  console.log('\n[5/8] Copying application files...');
  const appDir = path.join(buildDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });

  copyDirSync(path.join(SRC_DIR, 'backend'), path.join(appDir, 'backend'));
  copyDirSync(path.join(SRC_DIR, 'frontend'), path.join(appDir, 'frontend'));

  // ── Step 6: Install Node.js production dependencies ──
  console.log('\n[6/8] Installing Node.js production dependencies...');
  const pkg = require('./package.json');
  const prodDeps = { ...pkg.dependencies };
  delete prodDeps.nw;

  const prodPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    dependencies: prodDeps,
  };
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(prodPkg, null, 2));

  // Use the full Node distro (still in temp) for npm install, then discard it
  const nodeExeFull = path.join(nodeFullDir, 'node.exe');
  const npmCli = path.join(nodeFullDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await run(`"${nodeExeFull}" "${npmCli}" install --omit=dev`, { cwd: appDir });

  // Now we can clean up the full Node distro
  fs.rmSync(nodeTempDir, { recursive: true });

  // ── Step 7: Clean up build-only artifacts from release ──
  console.log('\n[7/8] Cleaning up build-only artifacts...');

  const sitePackages = path.join(pythonDir, 'Lib', 'site-packages');

  // Remove pip, setuptools, wheel — only needed at build time
  const buildOnlyPackages = ['pip', 'setuptools', 'wheel', 'pkg_resources'];
  for (const pkg of buildOnlyPackages) {
    removeMatchingDirs(sitePackages, pkg);
  }
  // Remove Scripts dir (pip executables etc)
  const scriptsDir = path.join(pythonDir, 'Scripts');
  if (fs.existsSync(scriptsDir)) fs.rmSync(scriptsDir, { recursive: true });

  // Remove Python test suites and unnecessary data
  removeMatchingDirs(sitePackages, '__pycache__', true);
  removeMatchingDirs(sitePackages, 'tests', true);
  removeMatchingDirs(sitePackages, 'test', true);

  // Remove .dist-info directories (package metadata, not needed at runtime)
  for (const entry of fs.readdirSync(sitePackages)) {
    if (entry.endsWith('.dist-info')) {
      fs.rmSync(path.join(sitePackages, entry), { recursive: true });
    }
  }

  // ── Step 8: Create launcher scripts ──
  console.log('\n[8/8] Creating launcher scripts...');

  const launcherBat = `@echo off
setlocal

cd /d "%~dp0"

set "PATH=%~dp0python;%~dp0python\\Scripts;%~dp0node;%PATH%"

:: Start backend
start "Tune Raider Backend" /min "%~dp0node\\node.exe" "%~dp0app\\backend\\server.js"

:: Wait for backend to start
timeout /t 2 /nobreak >nul

:: Launch NW.js frontend
start "" "%~dp0nwjs\\nw.exe" "%~dp0app\\frontend"
`;
  fs.writeFileSync(path.join(buildDir, 'TuneRaider.bat'), launcherBat);

  const launcherVbs = `Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
Dim baseDir
baseDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = baseDir

' Add bundled python and node to PATH so child processes find them
Dim env
Set env = WshShell.Environment("Process")
env("PATH") = baseDir & "\\python;" & baseDir & "\\python\\Scripts;" & baseDir & "\\node;" & env("PATH")

' Start backend hidden
WshShell.Run """" & baseDir & "\\node\\node.exe"" """ & baseDir & "\\app\\backend\\server.js""", 0, False

WScript.Sleep 2000

' Start NW.js frontend
WshShell.Run """" & baseDir & "\\nwjs\\nw.exe"" """ & baseDir & "\\app\\frontend""", 1, False
`;
  fs.writeFileSync(path.join(buildDir, 'TuneRaider.vbs'), launcherVbs);

  // ── Done ──
  const totalSize = getDirSize(buildDir);
  console.log(`\n=== Build complete ===`);
  console.log(`Output: ${buildDir}`);
  console.log(`Size: ${(totalSize / 1024 / 1024).toFixed(0)} MB`);
  console.log(`\nTo distribute: zip the "tune-raider" folder and share.`);
  console.log(`Users run TuneRaider.bat (with console) or TuneRaider.vbs (no console).`);
}

// ── Helpers ──

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.name === '__pycache__') continue;
    if (entry.name === 'node_modules') continue;
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Remove directories matching a name pattern from a base path */
function removeMatchingDirs(baseDir, name, recursive = false) {
  if (!fs.existsSync(baseDir)) return;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === name || entry.name.startsWith(name + '-')) {
        fs.rmSync(fullPath, { recursive: true });
      } else if (recursive) {
        removeMatchingDirs(fullPath, name, true);
      }
    }
  }
}

function downloadIfMissing(url, dest) {
  if (fs.existsSync(dest)) {
    console.log(`  Cached: ${path.basename(dest)}`);
    return Promise.resolve();
  }
  return downloadFile(url, dest);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading: ${path.basename(dest)}...`);
    const file = fs.createWriteStream(dest + '.tmp');
    const get = url.startsWith('https') ? https.get : http.get;

    get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest + '.tmp');
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest + '.tmp');
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const totalBytes = parseInt(res.headers['content-length'], 10);
      let downloaded = 0;
      let lastPct = 0;

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalBytes) {
          const pct = Math.floor((downloaded / totalBytes) * 100);
          if (pct >= lastPct + 10) {
            process.stdout.write(`    ${pct}%\r`);
            lastPct = pct;
          }
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.renameSync(dest + '.tmp', dest);
        const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
        console.log(`    Done (${sizeMB} MB)`);
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(dest + '.tmp')) fs.unlinkSync(dest + '.tmp');
      reject(err);
    });
  });
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  console.log(`  Extracting: ${path.basename(zipPath)}...`);
  return run(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`,
    { timeout: 300000 }
  );
}

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log(`  > ${cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd}`);
    const proc = exec(cmd, {
      ...opts,
      maxBuffer: 50 * 1024 * 1024,
      timeout: opts.timeout || 600000,
    });
    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command exited with code ${code}`));
    });
  });
}

function getDirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += getDirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

build().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});
