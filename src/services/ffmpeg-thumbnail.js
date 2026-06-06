'use strict';

// =====================================================================
// YT Studio — Thumbnail Card Injector  (v1.1.0)
//
// Purpose:
//   After a clip is fully rendered by ffmpeg.js / ffmpeg-natok.js,
//   inject a "thumbnail card" overlay at the VERY START of the video
//   for an extremely short duration (default 0.004 seconds — just a
//   single frame at 30fps).
//
//   YouTube's auto-thumbnail picker samples the first frames of the
//   video as candidate thumbnails, so putting the card right at the
//   beginning makes YouTube reliably surface it as a suggestion.
//
//   This single frame is enough for YouTube's auto-thumbnail picker
//   to detect a visually distinct title image and surface it as one
//   of the suggested thumbnails — so the uploader doesn't have to
//   design a separate thumbnail.
//
//   Everything else in the video stays IDENTICAL (audio, length,
//   visual look). Only ~1 frame in the middle has the title card.
//
// Style mapping:
//   The title card uses the SAME visual template (background color +
//   text color + outline) as the clip's titleStyle. We mirror the
//   rules from ffmpeg.js getStyleConfig() / applyTitleBackground().
//
// Usage:
//   const { injectThumbnailCard } = require('./ffmpeg-thumbnail');
//   await injectThumbnailCard({
//     videoPath, title, titleStyle,
//     workDir, jobLog, jobId,
//     durationSec: 0.004,   // optional
//   });
// =====================================================================

const THUMBNAIL_MODULE_VERSION = '1.1.0-thumbnail-card-start-frame';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { renderTitlePng } = require('./titleRenderer');

const PRESET  = process.env.FFMPEG_PRESET  || 'ultrafast';
const CRF     = process.env.FFMPEG_CRF     || '24';
const THREADS = process.env.FFMPEG_THREADS || '0';

// Inherit the same process tracking as ffmpeg.js (so deleteJob can kill us too)
const RUNNING = new Map();
function trackProc(jobId, proc) {
  if (!jobId) return;
  if (!RUNNING.has(jobId)) RUNNING.set(jobId, new Set());
  RUNNING.get(jobId).add(proc);
  proc.on('close', () => {
    const set = RUNNING.get(jobId);
    if (set) {
      set.delete(proc);
      if (!set.size) RUNNING.delete(jobId);
    }
  });
}
function killJob(jobId) {
  const set = RUNNING.get(jobId);
  if (!set) return 0;
  let n = 0;
  for (const p of set) {
    try { p.kill('SIGKILL'); n++; } catch (_) {}
  }
  RUNNING.delete(jobId);
  return n;
}

// ---------------------------------------------------------------------
//   Style table — mirrors ffmpeg.js so the thumbnail card looks like
//   the chosen template. Each entry returns:
//     { fg:[r,g,b,a], borderColor:'0xRRGGBB'|null, bgFill:'0xRRGGBB[@a]'|null }
// ---------------------------------------------------------------------
function getThumbStyle(titleStyle) {
  const map = {
    yellow_box: {
      fg: [0, 0, 0, 255],
      bgFill: '0xFFD700',
      borderColor: '0x000000',
      borderThickness: 3,
      shadow: null,
    },
    gradient: {
      fg: [255, 231, 90, 255],
      bgFill: '0x2a0845@0.85',
      borderColor: null,
      borderThickness: 0,
      shadow: [0, 0, 0, 220, 2, 2],
    },
    centered: {
      fg: [255, 255, 255, 255],
      bgFill: '0x000000@0.55',
      borderColor: null,
      borderThickness: 0,
      shadow: [0, 0, 0, 220, 2, 2],
    },
    natok_emotional: {
      fg: [80, 0, 120, 255],
      bgFill: '0xFFFFFF',
      borderColor: '0x6600aa',
      borderThickness: 4,
      shadow: null,
    },
    natok_dark: {
      fg: [255, 255, 255, 255],
      bgFill: '0x001a33@0.92',
      borderColor: '0x00ccff',
      borderThickness: 3,
      shadow: [0, 200, 255, 200, 2, 2],
    },
    natok_minimal: {
      fg: [255, 255, 255, 255],
      bgFill: '0x000000@0.55',
      borderColor: null,
      borderThickness: 0,
      shadow: [0, 0, 0, 200, 1, 1],
    },
    natok_warm: {
      fg: [255, 240, 200, 255],
      bgFill: '0x8b0000@0.85',
      borderColor: null,
      borderThickness: 0,
      shadow: [100, 0, 0, 220, 2, 2],
    },
    natok_header_v1: {
      fg: [60, 60, 60, 255],
      bgFill: '0xFFFFFF',
      borderColor: '0x99008c',
      borderThickness: 4,
      shadow: null,
    },
    natok_golden: {
      fg: [255, 244, 210, 255],
      bgFill: '0x101010@0.95',
      borderColor: '0xC9A64B',
      borderThickness: 4,
      shadow: [0, 0, 0, 200, 2, 2],
    },
    natok_modern: {
      fg: [255, 255, 255, 255],
      bgFill: '0x0f1326@0.92',
      borderColor: '0xff3ea5',
      borderThickness: 3,
      shadow: [0, 0, 0, 200, 2, 2],
    },
    natok_purple: {
      fg: [26, 26, 26, 255],
      bgFill: '0xFFFFFF',
      borderColor: '0x7B2D8B',
      borderThickness: 4,
      shadow: null,
    },
    natok_gold2: {
      fg: [255, 255, 255, 255],
      bgFill: '0x0a0a0a@0.92',
      borderColor: '0xf0c040',
      borderThickness: 4,
      shadow: [0, 0, 0, 200, 2, 2],
    },
    natok_green: {
      fg: [255, 255, 255, 255],
      bgFill: '0x0d3d22@0.92',
      borderColor: '0x4caf80',
      borderThickness: 3,
      shadow: [0, 0, 0, 200, 2, 2],
    },
  };
  return map[titleStyle] || map.centered;
}

// ---------------------------------------------------------------------
//   ffprobe helpers
// ---------------------------------------------------------------------
function probeVideo(input) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
    '-of', 'json',
    input,
  ], { encoding: 'utf8' });

  if (r.status !== 0) {
    throw new Error(`ffprobe failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch (e) {
    throw new Error(`ffprobe JSON parse error: ${e.message}`);
  }
  const s = (parsed.streams && parsed.streams[0]) || {};
  const W = parseInt(s.width, 10) || 720;
  const H = parseInt(s.height, 10) || 1280;
  const fr = String(s.r_frame_rate || '30/1').split('/');
  const fps = (parseFloat(fr[0]) || 30) / (parseFloat(fr[1]) || 1);
  const dur = parseFloat((parsed.format && parsed.format.duration) || '0') || 0;
  return { W, H, fps, dur };
}

// ---------------------------------------------------------------------
//   MAIN — inject thumbnail card on a single mid-frame.
// ---------------------------------------------------------------------
async function injectThumbnailCard({
  videoPath,
  title,
  titleStyle = 'centered',
  workDir,
  jobLog,
  jobId,
  durationSec = 0.004,
  cardWidthRatio = 0.92,   // width of card relative to video width
  cardHeightRatio = 0.32,  // height of card relative to video height
}) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`injectThumbnailCard: video not found at ${videoPath}`);
  }
  if (!title || !String(title).trim()) {
    if (jobLog) jobLog.info('thumbnail-card: empty title — skipping injection');
    return videoPath;
  }

  const log = jobLog || { info: () => {}, warn: () => {}, error: () => {} };
  fs.mkdirSync(workDir, { recursive: true });

  const { W, H, fps, dur } = probeVideo(videoPath);
  if (dur <= 0.05) {
    log.warn(`thumbnail-card: video too short (${dur.toFixed(3)}s) — skipping`);
    return videoPath;
  }

  // ---- 1) Render the thumbnail title PNG -----------------------------
  const styleCfg     = getThumbStyle(titleStyle);
  const cardW        = Math.floor(W * cardWidthRatio);
  const cardH        = Math.floor(H * cardHeightRatio);
  const cardFontSize = Math.max(40, Math.floor(cardH / 4.2));

  const thumbPng = path.join(
    workDir,
    `_thumbcard_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.png`,
  );

  // Render the text PNG (transparent bg; we draw box separately with drawbox
  // so the box color exactly matches the template).
  renderTitlePng({
    text: String(title),
    width: cardW - 40,                 // padding inside the box
    height: cardH - 30,
    fontSize: cardFontSize,
    outPath: thumbPng,
    fg: styleCfg.fg,
    bg: [0, 0, 0, 0],
    shadow: styleCfg.shadow,
    fontWeight: 'bold',
    maxLines: 4,
    paddingX: 24,
    paddingY: 18,
    lineHeightRatio: 1.25,
  });
  log.info(`thumbnail-card: title.png rendered (${cardW - 40}x${cardH - 30}, style=${titleStyle})`);

  // ---- 2) Compute timing --------------------------------------------
  // Card sits at the VERY START of the video (so YouTube's auto-thumb
  // picker grabs it as a suggested thumbnail). Window = [0, durationSec].
  const winLen   = Math.max(0.001, Number(durationSec) || 0.004);
  const tStart   = 0;
  const tEnd     = Math.min(dur, winLen);
  const enableExp = `between(t,${tStart.toFixed(6)},${tEnd.toFixed(6)})`;

  // ---- 3) Card placement (centered) ---------------------------------
  const cardX = Math.floor((W - cardW) / 2);
  const cardY = Math.floor((H - cardH) / 2);

  // ---- 4) Build filter graph ----------------------------------------
  // Chain on the main video stream [0:v]:
  //   - optional outer border drawbox (enable=enableExp)
  //   - inner bg fill drawbox        (enable=enableExp)
  //   - overlay text PNG             (enable=enableExp)
  const filters = [];
  let chain = '[0:v]';
  let stepIdx = 0;
  const nextLabel = () => `[tc${++stepIdx}]`;

  if (styleCfg.borderColor && styleCfg.borderThickness > 0) {
    const bt = styleCfg.borderThickness;
    const bx = cardX - bt;
    const by = cardY - bt;
    const bw = cardW + 2 * bt;
    const bh = cardH + 2 * bt;
    const out = nextLabel();
    filters.push(
      `${chain}drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:` +
      `color=${styleCfg.borderColor}:t=fill:enable='${enableExp}'${out}`
    );
    chain = out;
  }

  if (styleCfg.bgFill) {
    const out = nextLabel();
    filters.push(
      `${chain}drawbox=x=${cardX}:y=${cardY}:w=${cardW}:h=${cardH}:` +
      `color=${styleCfg.bgFill}:t=fill:enable='${enableExp}'${out}`
    );
    chain = out;
  }

  // Center the text PNG inside the card
  const txtW = cardW - 40;
  const txtH = cardH - 30;
  const txtX = cardX + Math.floor((cardW - txtW) / 2);
  const txtY = cardY + Math.floor((cardH - txtH) / 2);

  const outFinal = '[vout]';
  filters.push(
    `${chain}[1:v]overlay=${txtX}:${txtY}:enable='${enableExp}':format=auto${outFinal}`
  );

  const filterComplex = filters.join(';');

  // ---- 5) Run ffmpeg (re-encode video, copy audio) ------------------
  const tmpOut = videoPath.replace(/\.mp4$/i, `.thumb.tmp.mp4`);

  const args = [
    '-hide_banner', '-loglevel', 'error', '-stats', '-y',
    '-i', videoPath,
    '-i', thumbPng,
    '-filter_complex', filterComplex,
    '-map', outFinal,
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-crf', CRF,
    '-pix_fmt', 'yuv420p',
    '-r', String(Math.round(fps) || 30),
    '-c:a', 'copy',
    '-movflags', '+faststart',
    '-threads', THREADS,
    '-max_muxing_queue_size', '1024',
    tmpOut,
  ];

  log.info(
    `thumbnail-card: inject @start (0s) for ${(tEnd - tStart).toFixed(4)}s ` +
    `[v=${THUMBNAIL_MODULE_VERSION}] → ${path.basename(videoPath)}`
  );

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let lastErr = '';
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && log.info(`ffmpeg-thumb> ${l}`)));
    proc.stderr.on('data', d => {
      const t = d.toString();
      lastErr += t;
      t.split(/\r?\n/).forEach(l => l && log.info(`ffmpeg-thumb> ${l.trim()}`));
    });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg-thumb exited ${code}: ${lastErr.slice(-500)}`));
    });
  });

  // Atomic replace
  try { fs.unlinkSync(videoPath); } catch (_) {}
  fs.renameSync(tmpOut, videoPath);

  // Cleanup PNG
  try { fs.unlinkSync(thumbPng); } catch (_) {}

  log.info(`thumbnail-card: ✓ embedded into ${path.basename(videoPath)}`);
  return videoPath;
}

module.exports = {
  injectThumbnailCard,
  killJob,
  THUMBNAIL_MODULE_VERSION,
};
