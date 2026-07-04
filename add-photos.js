/**
 * add-photos.js — Photo Import Server
 *
 * Starts a local HTTP server with a web UI for adding photos to the gallery.
 * Usage: node add-photos.js [--port PORT] [--no-browser]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

// ============================================================
// CONFIGURATION
// ============================================================
const ROOT = __dirname;
const IMG_DIR = path.join(ROOT, '图片');
const CLOUD_DIR = path.join(ROOT, '夸克网盘下载');
const TEMP_DIR = path.join(ROOT, '.temp-import');
const MANIFEST_PATH = path.join(ROOT, 'photos.json');
const PORT = parseInt(process.argv[process.argv.indexOf('--port') + 1]) || 3456;
const NO_BROWSER = process.argv.includes('--no-browser');

// Ensure directories exist
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ============================================================
// EXIF EXTRACTION (using sharp's raw buffer — zero extra deps)
// ============================================================
let sharp;
try { sharp = require('sharp'); } catch (e) { /* will check later */ }

function extractExifFromBuffer(exifBuf) {
  if (!exifBuf || !exifBuf.byteLength) return null;
  const str = exifBuf.toString('latin1');

  // Extract DateTimeOriginal (format: "2026:06:05 10:23:48")
  const dateMatch = str.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  const dateTaken = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}`
    : '';

  // Extract camera make/model from readable ASCII portions
  let make = '', model = '';

  // Try to find known camera manufacturers
  const knownMakes = ['Canon', 'NIKON', 'SONY', 'OPPO', 'Xiaomi', 'Apple', 'HUAWEI', 'HMD', 'samsung', 'Google'];
  for (const m of knownMakes) {
    const idx = str.indexOf(m);
    if (idx >= 0) {
      make = m;
      // Try to extract model — read a chunk after the make
      const after = str.substring(idx + m.length, idx + m.length + 50).replace(/[^\x20-\x7E]/g, ' ').trim();
      const modelPart = after.split(/\s{2,}/)[0];
      if (modelPart && modelPart.length < 40) model = modelPart;
      break;
    }
  }

  // Fallback: look for known model patterns
  if (!make) {
    if (str.includes('Find X')) { make = 'OPPO'; model = 'Find X'; }
    else if (str.includes('iPhone')) { make = 'Apple'; const m = str.match(/iPhone\s*\d+/); if (m) model = m[0]; }
  }

  return { dateTaken, make, model };
}

async function readExifFromFile(filePath) {
  if (!sharp) return null;
  try {
    const metadata = await sharp(filePath).metadata();
    if (metadata.exif) {
      return extractExifFromBuffer(metadata.exif);
    }
    return { dateTaken: '', make: '', model: '' };
  } catch (e) {
    return { dateTaken: '', make: '', model: '', error: e.message };
  }
}

// ============================================================
// MULTIPART PARSER (zero-dependency)
// ============================================================
function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const endBoundary = Buffer.from('--' + boundary + '--');

  let pos = 0;
  while (pos < buffer.length) {
    // Find next boundary
    const boundaryPos = buffer.indexOf(boundaryBuf, pos);
    if (boundaryPos < 0) break;

    // Check if it's the end boundary
    if (buffer.indexOf(endBoundary, boundaryPos) === boundaryPos) break;

    // Find end of this part's boundary line
    const lineEnd = buffer.indexOf('\r\n', boundaryPos);
    if (lineEnd < 0) break;
    pos = lineEnd + 2;

    // Parse headers
    const headerEnd = buffer.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headerStr = buffer.subarray(pos, headerEnd).toString('utf-8');
    pos = headerEnd + 4;

    // Parse Content-Disposition
    const cdMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!cdMatch) {
      // Still need to find next boundary to advance
      const nextBoundary = buffer.indexOf(boundaryBuf, pos);
      if (nextBoundary >= 0) pos = nextBoundary;
      continue;
    }

    const fieldName = cdMatch[1];
    const filename = cdMatch[2] || null;

    // Find next boundary for body end
    let bodyEnd = buffer.indexOf(boundaryBuf, pos);
    if (bodyEnd < 0) bodyEnd = buffer.length;
    // Trim trailing \r\n before boundary
    let body = buffer.subarray(pos, bodyEnd);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 2);
    }

    parts.push({ fieldName, filename, data: body, contentType: (headerStr.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1] });
    pos = bodyEnd;
  }

  return parts;
}

// ============================================================
// EXISTING LOCATIONS
// ============================================================
function getExistingLocations() {
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    const locs = new Set();
    for (const loc of manifest.locations || []) {
      if (loc.location && loc.location !== '未知') locs.add(loc.location);
    }
    return [...locs].sort();
  } catch (e) {
    return [];
  }
}

// ============================================================
// IMPORT LOGIC
// ============================================================
function getNextAvailableFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const base = path.basename(originalName, ext);
  let target = originalName;
  let counter = 1;
  while (fs.existsSync(path.join(IMG_DIR, target))) {
    target = `${base}_(${counter})${ext}`;
    counter++;
  }
  return target;
}

function formatCloudFolderName(year, month, location) {
  return `${year}年${month}月${location}`;
}

function importPhotos(items) {
  // items: [{ tempPath, originalFilename, year, month, location, subLocation }]
  const results = { copied: [], errors: [] };

  for (const item of items) {
    try {
      // Copy to 图片/
      const targetFilename = getNextAvailableFilename(item.originalFilename);
      const targetPath = path.join(IMG_DIR, targetFilename);
      fs.copyFileSync(item.tempPath, targetPath);
      results.copied.push({ filename: targetFilename, originalFilename: item.originalFilename });

      // Copy to cloud drive folder
      if (item.location && item.year && item.month) {
        const folderName = formatCloudFolderName(item.year, item.month, item.location);
        let cloudFolder = path.join(CLOUD_DIR, folderName);
        if (item.subLocation) {
          cloudFolder = path.join(cloudFolder, item.subLocation);
        }
        if (!fs.existsSync(cloudFolder)) {
          fs.mkdirSync(cloudFolder, { recursive: true });
        }
        const cloudTarget = path.join(cloudFolder, targetFilename);
        if (!fs.existsSync(cloudTarget)) {
          fs.copyFileSync(item.tempPath, cloudTarget);
        }
      }
    } catch (e) {
      results.errors.push({ filename: item.originalFilename, error: e.message });
    }
  }

  return results;
}

// ============================================================
// BUILD STATUS (shared state for SSE polling)
// ============================================================
let buildState = { running: false, done: false, progress: 0, phase: '', log: '', lastLog: '', error: null };

async function runBuild() {
  buildState = { running: true, done: false, progress: 0, phase: '启动构建…', log: '', lastLog: '', error: null };

  return new Promise((resolve) => {
    const child = spawn('node', ['build.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.on('data', (data) => {
      const text = data.toString('utf-8');
      buildState.log += text;
      buildState.lastLog += text;

      // Parse progress from build.js output
      if (text.includes('Phase 1')) { buildState.progress = 0.05; buildState.phase = '扫描网盘目录…'; }
      else if (text.includes('Phase 2')) { buildState.progress = 0.15; buildState.phase = '分析图片日期…'; }
      else if (text.includes('Phase 3')) { buildState.progress = 0.3; buildState.phase = '读取图片信息…'; }
      else if (text.includes('Phase 4')) { buildState.progress = 0.5; buildState.phase = '分组归类…'; }
      else if (text.includes('Phase 5')) { buildState.progress = 0.65; buildState.phase = '生成缩略图…'; }
      else if (text.includes('Phase 6')) { buildState.progress = 0.85; buildState.phase = '生成清单文件…'; }
      else if (text.includes('Build complete')) { buildState.progress = 1; buildState.phase = '构建完成'; }
    });

    child.stderr.on('data', (data) => {
      buildState.log += data.toString('utf-8');
      buildState.lastLog += data.toString('utf-8');
    });

    child.on('close', (code) => {
      buildState.running = false;
      buildState.done = true;
      if (code !== 0) {
        buildState.error = `Build exited with code ${code}`;
        buildState.phase = '构建失败';
      } else {
        buildState.progress = 1;
        buildState.phase = '✅ 构建完成';
      }
      resolve(buildState);
    });

    child.on('error', (err) => {
      buildState.running = false;
      buildState.done = true;
      buildState.error = err.message;
      buildState.phase = '构建失败';
      resolve(buildState);
    });
  });
}

// ============================================================
// HTTP SERVER
// ============================================================
const GALLERY_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const method = req.method;

  // CORS headers (not strictly needed for same-origin but good practice)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  try {
    // Route: GET /
    if (method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(GALLERY_HTML);
      return;
    }

    // Route: GET /favicon.ico — 消除浏览器自动请求导致的 404 报错
    if (method === 'GET' && url.pathname === '/favicon.ico') {
      const favicon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="3" fill="#0d0a08"/><circle cx="16" cy="16" r="12" fill="none" stroke="#c9a96e" stroke-width="2"/><circle cx="16" cy="16" r="5" fill="none" stroke="#c9a96e" stroke-width="1.5"/><circle cx="16" cy="16" r="1.5" fill="#c9a96e"/></svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(favicon);
      return;
    }

    // Route: GET /api/locations
    if (method === 'GET' && url.pathname === '/api/locations') {
      const locs = getExistingLocations();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(locs));
      return;
    }

    // Route: GET /api/build-status
    if (method === 'GET' && url.pathname === '/api/build-status') {
      const payload = {
        running: buildState.running,
        done: buildState.done,
        progress: buildState.progress,
        phase: buildState.phase,
        log: buildState.lastLog,
        error: buildState.error,
      };
      // Only send incremental log
      buildState.lastLog = '';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }

    // Route: POST /api/scan — EXIF extraction
    if (method === 'POST' && url.pathname === '/api/scan') {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
        return;
      }

      const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        const parts = parseMultipart(buffer, boundary);
        const results = [];

        for (const part of parts) {
          if (!part.filename) continue;
          // Save to temp for EXIF reading
          const tempPath = path.join(TEMP_DIR, part.filename);
          fs.writeFileSync(tempPath, part.data);
          const exif = await readExifFromFile(tempPath);

          // Also try to extract date from filename
          let filenameDate = '';
          const imgMatch = part.filename.match(/^IMG(\d{4})(\d{2})(\d{2})/i);
          if (imgMatch) {
            filenameDate = `${imgMatch[1]}-${imgMatch[2]}-${imgMatch[3]}`;
          }

          results.push({
            filename: part.filename,
            dateTaken: exif?.dateTaken || filenameDate || '',
            make: exif?.make || '',
            model: exif?.model || '',
            sizeKB: Math.round(part.data.length / 1024),
            tempPath,
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(results));
      });
      return;
    }

    // Route: POST /api/import — execute import
    if (method === 'POST' && url.pathname === '/api/import') {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected multipart/form-data' }));
        return;
      }

      const boundary = boundaryMatch[1].replace(/^"|"$/g, '');
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        const parts = parseMultipart(buffer, boundary);
        const metaMap = {}; // filename -> metadata
        const fileParts = [];

        for (const part of parts) {
          if (part.fieldName.startsWith('meta_')) {
            try {
              const meta = JSON.parse(part.data.toString('utf-8'));
              metaMap[meta.filename] = meta;
            } catch (e) { /* skip */ }
          } else if (part.filename) {
            fileParts.push(part);
          }
        }

        // Build import items
        const items = [];
        const logLines = [];

        for (const part of fileParts) {
          const meta = metaMap[part.filename];
          if (!meta) { logLines.push(`⚠ 跳过 ${part.filename}：缺少元数据`); continue; }

          // Parse date
          let year, month;
          const dateParts = meta.dateTaken.match(/^(\d{4})-(\d{1,2})/);
          if (dateParts) { year = parseInt(dateParts[1]); month = parseInt(dateParts[2]); }
          else { logLines.push(`⚠ 跳过 ${part.filename}：日期格式无效`); continue; }

          const tempPath = path.join(TEMP_DIR, part.filename);
          fs.writeFileSync(tempPath, part.data);

          items.push({
            tempPath,
            originalFilename: part.filename,
            year,
            month,
            location: meta.location,
            subLocation: meta.subLocation || '',
          });

          logLines.push(`✓ ${part.filename} → ${year}年${month}月 · ${meta.location}${meta.subLocation ? ' / ' + meta.subLocation : ''}`);
        }

        if (!items.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: '没有可导入的照片', log: logLines.join('\n') }));
          return;
        }

        // Execute import
        const importResult = importPhotos(items);
        logLines.push(`\n📦 复制了 ${importResult.copied.length} 个文件到 图片/`);
        if (importResult.errors.length) {
          logLines.push(`⚠ ${importResult.errors.length} 个错误:`);
          importResult.errors.forEach(e => logLines.push(`  ✗ ${e.filename}: ${e.error}`));
        }

        // Trigger build asynchronously
        runBuild().then(() => {
          logLines.push('\n✅ 构建完成');
        });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          imported: importResult.copied.length,
          errors: importResult.errors.length,
          log: logLines.join('\n'),
        }));
      });
      return;
    }

    // Static file serving (photos.js, thumbs/, heroes/, etc.)
    if (method === 'GET') {
      const safePath = path.normalize(url.pathname).replace(/^\/+/, '');
      if (safePath && !safePath.startsWith('..')) {
        const filePath = path.join(ROOT, safePath);
        try {
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeMap = {
              '.js': 'application/javascript',
              '.json': 'application/json',
              '.webp': 'image/webp',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
              '.png': 'image/png',
              '.svg': 'image/svg+xml',
              '.css': 'text/css',
              '.html': 'text/html',
            };
            const mime = mimeMap[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        } catch (e) { /* fall through to 404 */ }
      }
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (e) {
    console.error('Server error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// ============================================================
// STARTUP
// ============================================================
server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  📷  照片导入工具');
  console.log('  ─────────────────────');
  console.log(`  🌐  ${url}`);
  console.log('  ─────────────────────');
  console.log('  拖放照片或点击上传，自动读取 EXIF 日期');
  console.log('');

  if (!NO_BROWSER) {
    const platform = process.platform;
    const cmd = platform === 'win32'
      ? `start "" "${url}"`
      : platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});

// Clean shutdown
process.on('SIGINT', () => {
  console.log('\n👋 关闭服务器…');
  server.close();
  // Clean temp files
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(0);
});
