/**
 * build.js — University 4-Year Photo Gallery Build Script
 *
 * Scans the 图片/ folder, cross-references with cloud drive folders for dates,
 * groups by academic year, selects hero images, generates thumbnails,
 * and outputs photos.json manifest.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ============================================================
// CONFIGURATION
// ============================================================
const ROOT = __dirname;
const IMG_DIR = path.join(ROOT, '图片');
const THUMB_DIR = path.join(ROOT, 'thumbs');
const HERO_DIR = path.join(ROOT, 'heroes');
const MANIFEST_PATH = path.join(ROOT, 'photos.json');
const CLOUD_DRIVES = ['天翼云盘下载', '夸克网盘下载'];

const THUMB_WIDTH = 320;
const HERO_WIDTH = 1920;
const HERO_MIN_PIXELS = 8_000_000;  // 8MP minimum for hero
const HERO_MIN_WIDTH = 4000;        // or 4000px wide

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

/** Parse a cloud drive folder name like "2023年4月天津" or "2024年1-4月唐山" */
function parseFolderName(folderName) {
  // Match: YYYY年M月CITY or YYYY年M-M月CITY
  const m = folderName.match(/^(\d{4})年(\d{1,2})(?:-(\d{1,2}))?月(.+)$/);
  if (!m) return null;
  return {
    year: parseInt(m[1]),
    startMonth: parseInt(m[2]),
    endMonth: m[3] ? parseInt(m[3]) : parseInt(m[2]),
    location: m[4].trim()
  };
}

/** Determine academic year from calendar year and month */
function getAcademicYear(year, month) {
  // Academic year: Sept 1 – Aug 31
  // 大一 (2022.09–2023.08), 大二 (2023.09–2024.08), 大三 (2024.09–2025.08), 大四 (2025.09–2026.08)
  if (month >= 9) {
    const ay = year;
    if (ay === 2022) return { id: 'freshman', label: '大一', subtitle: '2022.09 – 2023.08', order: 1 };
    if (ay === 2023) return { id: 'sophomore', label: '大二', subtitle: '2023.09 – 2024.08', order: 2 };
    if (ay === 2024) return { id: 'junior', label: '大三', subtitle: '2024.09 – 2025.08', order: 3 };
    if (ay === 2025) return { id: 'senior', label: '大四', subtitle: '2025.09 – 2026.06', order: 4 };
    return { id: 'unknown', label: '其他', subtitle: '', order: 9 };
  } else {
    const ay = year - 1;
    if (ay === 2022) return { id: 'freshman', label: '大一', subtitle: '2022.09 – 2023.08', order: 1 };
    if (ay === 2023) return { id: 'sophomore', label: '大二', subtitle: '2023.09 – 2024.08', order: 2 };
    if (ay === 2024) return { id: 'junior', label: '大三', subtitle: '2024.09 – 2025.08', order: 3 };
    if (ay === 2025) return { id: 'senior', label: '大四', subtitle: '2025.09 – 2026.06', order: 4 };
    return { id: 'unknown', label: '其他', subtitle: '', order: 9 };
  }
}

/** Format month number to Chinese month string */
function formatMonth(year, month) {
  return `${year}年${month}月`;
}

/** Format date to ISO-like string */
function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ============================================================
// PHASE 1: BUILD DATE INDEX FROM CLOUD DRIVES
// ============================================================

function buildCloudDateIndex() {
  console.log('\n📂 Phase 1: Building cloud drive date index...');
  const index = new Map(); // filename -> { year, month, location, folder }

  for (const drive of CLOUD_DRIVES) {
    const drivePath = path.join(ROOT, drive);
    if (!fs.existsSync(drivePath)) {
      console.log(`  ⚠ Skipping ${drive} (not found)`);
      continue;
    }

    function walk(dir, parentFolderInfo) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { return; }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Try to parse folder name for date/location
          const info = parseFolderName(entry.name);
          walk(fullPath, info || parentFolderInfo);
        } else if (/\.(jpg|jpeg|png|webp)$/i.test(entry.name)) {
          if (!index.has(entry.name)) {
            index.set(entry.name, []);
          }
          if (parentFolderInfo) {
            index.get(entry.name).push({
              ...parentFolderInfo,
              source: drive,
              subfolder: path.relative(drivePath, dir)
            });
          }
        }
      }
    }

    // Special handling for top-level folders
    const topEntries = fs.readdirSync(drivePath, { withFileTypes: true });
    for (const entry of topEntries) {
      if (!entry.isDirectory()) continue;
      const folderInfo = parseFolderName(entry.name);

      // Special: 毕业照 -> June 2026
      if (entry.name === '毕业照') {
        const gradInfo = { year: 2026, startMonth: 6, endMonth: 6, location: '校园' };
        walk(path.join(drivePath, entry.name), gradInfo);
        continue;
      }
      // Special: 随拍 -> no specific date, use null to fall through to mtime
      if (entry.name === '随拍') {
        walk(path.join(drivePath, entry.name), null);
        continue;
      }

      walk(path.join(drivePath, entry.name), folderInfo);
    }
    console.log(`  ✓ ${drive}: indexed`);
  }

  console.log(`  Total unique filenames indexed: ${index.size}`);
  return index;
}

// ============================================================
// PHASE 2: SCAN IMAGES AND ASSIGN DATES
// ============================================================

function scanImages(cloudIndex) {
  console.log('\n📷 Phase 2: Scanning images and assigning dates...');

  const files = fs.readdirSync(IMG_DIR).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
  const results = [];
  let exactDates = 0, cloudDates = 0, mtimeDates = 0;

  for (const filename of files) {
    const filePath = path.join(IMG_DIR, filename);
    const stat = fs.statSync(filePath);
    let dateInfo = null;
    let dateSource = 'unknown';

    // Priority 1: Embedded date in filename (IMGYYYYMMDDHHMMSS.jpg)
    const imgDateMatch = filename.match(/^IMG(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(jpg|jpeg)$/i);
    if (imgDateMatch) {
      dateInfo = {
        year: parseInt(imgDateMatch[1]),
        month: parseInt(imgDateMatch[2]),
        day: parseInt(imgDateMatch[3]),
        hour: parseInt(imgDateMatch[4]),
        minute: parseInt(imgDateMatch[5]),
        second: parseInt(imgDateMatch[6]),
      };
      dateSource = 'filename_exact';
      exactDates++;
    }

    // Priority 1b: IMG_YYYYMMDD_HHMMSS.jpg
    if (!dateInfo) {
      const imgDateMatch2 = filename.match(/^IMG_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.(jpg|jpeg)$/i);
      if (imgDateMatch2) {
        dateInfo = {
          year: parseInt(imgDateMatch2[1]),
          month: parseInt(imgDateMatch2[2]),
          day: parseInt(imgDateMatch2[3]),
          hour: parseInt(imgDateMatch2[4]),
          minute: parseInt(imgDateMatch2[5]),
          second: parseInt(imgDateMatch2[6]),
        };
        dateSource = 'filename_exact';
        exactDates++;
      }
    }

    // Priority 1c: mmexport timestamp
    if (!dateInfo) {
      const mmMatch = filename.match(/^mmexport(\d{13})\.(jpg|jpeg)$/i);
      if (mmMatch) {
        const ts = parseInt(mmMatch[1]);
        const d = new Date(ts);
        dateInfo = {
          year: d.getFullYear(),
          month: d.getMonth() + 1,
          day: d.getDate(),
          hour: d.getHours(),
          minute: d.getMinutes(),
          second: d.getSeconds(),
        };
        dateSource = 'filename_timestamp';
        exactDates++;
      }
    }

    // Priority 2: Cloud drive cross-reference
    if (!dateInfo && cloudIndex.has(filename)) {
      const entries = cloudIndex.get(filename);
      // Pick the most specific entry (single month preferred over ranges)
      entries.sort((a, b) => {
        const aRange = a.endMonth - a.startMonth;
        const bRange = b.endMonth - b.startMonth;
        return aRange - bRange;
      });
      const entry = entries[0];
      dateInfo = {
        year: entry.year,
        month: entry.startMonth,
        day: 1,
        hour: 12,
        minute: 0,
        second: 0,
      };
      dateSource = 'cloud_folder';
      cloudDates++;
    }

    // Priority 3: File modification time fallback
    if (!dateInfo) {
      const mtime = stat.mtime;
      dateInfo = {
        year: mtime.getFullYear(),
        month: mtime.getMonth() + 1,
        day: mtime.getDate(),
        hour: mtime.getHours(),
        minute: mtime.getMinutes(),
        second: mtime.getSeconds(),
      };
      dateSource = 'mtime_fallback';
      mtimeDates++;
    }

    // Get location from cloud index if available
    let location = '';
    if (cloudIndex.has(filename)) {
      const entries = cloudIndex.get(filename);
      const locs = [...new Set(entries.map(e => e.location).filter(Boolean))];
      location = locs.join(' / ');
    }

    results.push({
      filename,
      filePath,
      date: formatDate(dateInfo.year, dateInfo.month, dateInfo.day),
      time: `${String(dateInfo.hour).padStart(2, '0')}:${String(dateInfo.minute).padStart(2, '0')}:${String(dateInfo.second).padStart(2, '0')}`,
      year: dateInfo.year,
      month: dateInfo.month,
      day: dateInfo.day,
      hour: dateInfo.hour,
      minute: dateInfo.minute,
      location,
      dateSource,
      sizeBytes: stat.size,
    });
  }

  console.log(`  ✓ Total images: ${results.length}`);
  console.log(`     Exact dates (filename): ${exactDates}`);
  console.log(`     Cloud folder dates: ${cloudDates}`);
  console.log(`     Mtime fallback: ${mtimeDates}`);

  // Sort by date
  results.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    if (a.month !== b.month) return a.month - b.month;
    if (a.day !== b.day) return a.day - b.day;
    if (a.hour !== b.hour) return a.hour - b.hour;
    if (a.minute !== b.minute) return a.minute - b.minute;
    return a.second - b.second;
  });

  return results;
}

// ============================================================
// PHASE 3: READ IMAGE DIMENSIONS
// ============================================================

async function readDimensions(images) {
  console.log('\n📐 Phase 3: Reading image dimensions and extracting palettes...');
  let count = 0;

  for (const img of images) {
    try {
      const metadata = await sharp(img.filePath).metadata();
      img.width = metadata.width;
      img.height = metadata.height;
      img.format = metadata.format;

      // Extract dominant colors for ALL images
      try {
        const { dominant } = await sharp(img.filePath)
          .resize(100, 100, { fit: 'inside' })
          .raw()
          .stats();
        img.palette = {
          dominant: { r: Math.round(dominant.r), g: Math.round(dominant.g), b: Math.round(dominant.b) }
        };
      } catch (e) { /* ignore palette errors */ }
      count++;
      if (count % 50 === 0) console.log(`  ... ${count}/${images.length}`);
    } catch (e) {
      console.warn(`  ⚠ Failed to read ${img.filename}: ${e.message}`);
      img.width = 0;
      img.height = 0;
      img.error = e.message;
    }
  }

  console.log(`  ✓ Dimensions read for ${count}/${images.length} images`);
}

// ============================================================
// PHASE 4: GROUP BY ACADEMIC YEAR AND SELECT HEROES
// ============================================================

function groupByAcademicYear(images) {
  console.log('\n🎓 Phase 4: Grouping by academic year...');

  const yearGroups = {};
  const allHeroes = [];

  for (const img of images) {
    if (img.error) continue;

    const ay = getAcademicYear(img.year, img.month);
    if (!yearGroups[ay.id]) {
      yearGroups[ay.id] = {
        ...ay,
        images: [],
        heroes: [],
        stats: {
          count: 0,
          heroCount: 0,
          locations: new Set(),
          dateRange: { start: null, end: null }
        }
      };
    }

    const group = yearGroups[ay.id];

    // Determine if hero
    const pixels = img.width * img.height;
    img.isHero = (pixels >= HERO_MIN_PIXELS) || (img.width >= HERO_MIN_WIDTH);
    img.thumb = `thumbs/${path.basename(img.filename, path.extname(img.filename))}.webp`;
    img.heroFile = img.isHero ? `heroes/${path.basename(img.filename, path.extname(img.filename))}.webp` : null;

    group.images.push(img);
    group.stats.count++;
    if (img.location) group.stats.locations.add(img.location);

    // Track date range
    const dateStr = img.date;
    if (!group.stats.dateRange.start || dateStr < group.stats.dateRange.start) {
      group.stats.dateRange.start = dateStr;
    }
    if (!group.stats.dateRange.end || dateStr > group.stats.dateRange.end) {
      group.stats.dateRange.end = dateStr;
    }
  }

  // Select heroes per year (top by resolution, deduplicated)
  for (const [yearId, group] of Object.entries(yearGroups)) {
    const heroes = group.images
      .filter(img => img.isHero && !img.error)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));

    // Deduplicate near-duplicates (same day, similar time, keep larger)
    const deduped = [];
    for (const h of heroes) {
      const isDup = deduped.some(d =>
        d.date === h.date &&
        Math.abs(d.hour * 60 + d.minute - (h.hour * 60 + h.minute)) <= 3
      );
      if (!isDup) deduped.push(h);
    }

    group.heroes = deduped.slice(0, 8); // Top 8 heroes per year
    group.stats.heroCount = group.heroes.length;
    allHeroes.push(...group.heroes);

    // Convert Set to array for JSON
    group.stats.locations = [...group.stats.locations];
  }

  // Sort groups by academic year order
  const sortedGroups = Object.values(yearGroups).sort((a, b) => a.order - b.order);

  console.log('  Academic year distribution:');
  for (const g of sortedGroups) {
    console.log(`    ${g.label} (${g.subtitle}): ${g.stats.count} images, ${g.stats.heroCount} heroes`);
  }

  return { yearGroups: sortedGroups, allHeroes };
}

// ============================================================
// PHASE 4b: GROUP BY LOCATION + MONTH
// ============================================================

function groupByLocation(images) {
  const groups = new Map();

  for (const img of images) {
    if (img.error) continue;
    // Clean location: strip sub-location like "太原 / 青岛" → "太原"
    let loc = (img.location || '未知').split(' / ')[0].trim();
    if (!loc || loc === '未知') loc = '未知';
    const key = `${img.year}年${img.month}月 · ${loc}`;
    if (!groups.has(key)) {
      groups.set(key, { label: key, year: img.year, month: img.month, location: loc, images: [] });
    }
    groups.get(key).images.push(img);
  }

  // Sort groups chronologically
  let sorted = [...groups.values()].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  // ---- MERGE: same location, adjacent months (≤1 gap) ----
  const merged = [];
  for (const g of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.location === g.location && g.month - last.month <= 1 && g.year === last.year) {
      // Merge into last
      last.images.push(...g.images);
      last.label = `${last.year}年${last.month}-${g.month}月 · ${last.location}`;
      last.month = g.month; // extend range
    } else {
      merged.push({ ...g, images: [...g.images] });
    }
  }

  // ---- MERGE: "未知" into same-month known location ----
  for (const g of merged) {
    if (g.location === '未知') {
      const sameMonth = merged.find(m => m.year === g.year && m.month === g.month && m.location !== '未知');
      if (sameMonth) {
        sameMonth.images.push(...g.images);
        g.merged = true; // mark for removal
      }
    }
  }
  const filtered = merged.filter(g => !g.merged);

  console.log(`  Location groups: ${sorted.length} → ${filtered.length} (after merge)`);
  for (const g of filtered) {
    console.log(`    ${g.label}: ${g.images.length} images`);
  }

  return filtered;
}

// ============================================================
// PHASE 5: GENERATE THUMBNAILS
// ============================================================

async function generateThumbnails(images) {
  console.log('\n🖼️  Phase 5: Generating thumbnails...');

  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
  if (!fs.existsSync(HERO_DIR)) fs.mkdirSync(HERO_DIR, { recursive: true });

  let thumbCount = 0;
  let heroCount = 0;
  let errors = 0;
  const THUMB_MIN_SIZE = 1024; // 1KB minimum — regenerate if smaller

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.error) { errors++; continue; }

    const ext = path.extname(img.filename);
    const baseName = path.basename(img.filename, ext);
    const thumbPath = path.join(THUMB_DIR, `${baseName}.webp`);

    try {
      // Generate thumbnail (force-regenerate if file is missing or suspiciously small)
      let needRegen = !fs.existsSync(thumbPath);
      if (!needRegen) {
        try {
          const existing = fs.statSync(thumbPath);
          if (existing.size < THUMB_MIN_SIZE) needRegen = true;
        } catch (e) { needRegen = true; }
      }
      if (needRegen) {
        await sharp(img.filePath)
          .resize(THUMB_WIDTH, undefined, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 75 })
          .toFile(thumbPath);
      }
      thumbCount++;

      // Generate hero version for hero images
      if (img.isHero) {
        const heroPath = path.join(HERO_DIR, `${baseName}.webp`);
        if (!fs.existsSync(heroPath)) {
          await sharp(img.filePath)
            .resize(HERO_WIDTH, undefined, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 92 })
            .toFile(heroPath);
        }
        heroCount++;
      }

      if ((i + 1) % 30 === 0) {
        console.log(`  ... ${i + 1}/${images.length} (${thumbCount} thumbs, ${heroCount} heroes)`);
      }
    } catch (e) {
      console.warn(`  ⚠ Failed to process ${img.filename}: ${e.message}`);
      errors++;
    }
  }

  console.log(`  ✓ Generated ${thumbCount} thumbnails, ${heroCount} hero images (${errors} errors)`);
}

// ============================================================
// PHASE 6: BUILD AND SAVE MANIFEST
// ============================================================

function buildManifest(yearGroups, allHeroes, locationGroups) {
  console.log('\n📋 Phase 6: Building manifest...');

  // For each image, only keep serializable fields (drop filePath, etc.)
  const cleanImage = (img) => ({
    filename: img.filename,
    date: img.date,
    time: img.time,
    year: img.year,
    month: img.month,
    day: img.day,
    location: img.location || '',
    width: img.width || 0,
    height: img.height || 0,
    sizeKB: Math.round((img.sizeBytes || 0) / 1024),
    isHero: img.isHero || false,
    thumb: img.thumb || '',
    heroFile: img.heroFile || null,
    palette: img.palette || null,
  });

  const manifest = {
    generated: new Date().toISOString(),
    totalImages: yearGroups.reduce((sum, g) => sum + g.stats.count, 0),
    years: yearGroups.map(g => ({
      id: g.id,
      label: g.label,
      subtitle: g.subtitle,
      order: g.order,
      stats: g.stats,
      images: g.images.map(cleanImage),
      heroes: g.heroes.map(cleanImage),
    })),
    locations: locationGroups.map(g => ({
      label: g.label,
      year: g.year,
      month: g.month,
      location: g.location,
      images: g.images.map(cleanImage),
    })),
    allHeroes: allHeroes.map(cleanImage),
  };

  // Save JSON
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`  ✓ Manifest saved to photos.json (${JSON.stringify(manifest).length} bytes)`);

  // Also save as JS for file:// protocol loading
  const jsPath = path.join(ROOT, 'photos.js');
  const jsContent = 'window.PHOTO_MANIFEST = ' + JSON.stringify(manifest) + ';';
  fs.writeFileSync(jsPath, jsContent, 'utf-8');
  console.log(`  ✓ Manifest saved to photos.js (${jsContent.length} bytes)`);

  return manifest;
}

// ============================================================
// PHASE 7: VALIDATE GENERATED FILES
// ============================================================

async function validateGeneratedFiles(manifest) {
  console.log('\n🔍 Phase 7: Validating generated files...');
  const issues = [];

  for (const year of manifest.years) {
    for (const img of year.images) {
      // Check thumbnail exists and is valid
      const thumbPath = path.join(ROOT, img.thumb);
      try {
        if (!fs.existsSync(thumbPath)) {
          issues.push(`Missing thumb: ${img.thumb} (${img.filename})`);
        } else {
          const meta = await sharp(thumbPath).metadata();
          if (!meta.width || !meta.height) {
            issues.push(`Corrupt thumb: ${img.thumb} (${img.filename})`);
          }
        }
      } catch (e) {
        issues.push(`Invalid thumb: ${img.thumb} — ${e.message}`);
      }

      // Check hero file if applicable
      if (img.heroFile) {
        const heroPath = path.join(ROOT, img.heroFile);
        try {
          if (!fs.existsSync(heroPath)) {
            issues.push(`Missing hero: ${img.heroFile} (${img.filename})`);
          } else {
            const meta = await sharp(heroPath).metadata();
            if (!meta.width || !meta.height) {
              issues.push(`Corrupt hero: ${img.heroFile} (${img.filename})`);
            }
          }
        } catch (e) {
          issues.push(`Invalid hero: ${img.heroFile} — ${e.message}`);
        }
      }
    }
  }

  if (issues.length > 0) {
    console.log(`  ⚠ Found ${issues.length} issues:`);
    issues.forEach(i => console.log(`    - ${i}`));
  } else {
    console.log(`  ✅ All ${manifest.totalImages} images validated (thumbs + heroes OK)`);
  }

  return issues;
}

async function main() {
  console.log('🎓 大学四年照片墙 — 构建脚本');
  console.log('='.repeat(50));

  const startTime = Date.now();

  // Phase 1: Build cloud date index
  const cloudIndex = buildCloudDateIndex();

  // Phase 2: Scan and date images
  const images = scanImages(cloudIndex);

  // Phase 3: Read dimensions
  await readDimensions(images);

  // Phase 4: Group by academic year
  const { yearGroups, allHeroes } = groupByAcademicYear(images);

  // Phase 4b: Group by location + month
  const locationGroups = groupByLocation(images);

  // Phase 5: Generate thumbnails
  await generateThumbnails(images);

  // Phase 6: Build and save manifest
  const manifest = buildManifest(yearGroups, allHeroes, locationGroups);

  // Phase 7: Validate generated files
  await validateGeneratedFiles(manifest);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Build complete in ${elapsed}s`);
  console.log(`   ${manifest.totalImages} images across ${manifest.years.length} academic years`);
  console.log(`   ${manifest.allHeroes.length} hero images`);

  return manifest;
}

// Run directly: `node build.js`
// Used as module: `require('./build.js')` from add-photos.js
if (require.main === module) {
  main().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}

module.exports = {
  main,
  buildCloudDateIndex,
  scanImages,
  readDimensions,
  groupByAcademicYear,
  groupByLocation,
  generateThumbnails,
  buildManifest,
  validateGeneratedFiles,
  parseFolderName,
  getAcademicYear,
  formatDate,
  ROOT, IMG_DIR, THUMB_DIR, HERO_DIR, CLOUD_DRIVES,
};
