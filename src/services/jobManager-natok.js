'use strict';

// =====================================================================
// YT Studio — Clipper Job Manager
//
// Inherits waz-clipper v2.6 job logic, plus:
//   • Immediate kill on delete
//   • Natok recap support (one title + many ranges => one merged video)
//   • Custom natok header text / follow text
//   • Optional audio ducking controls
// =====================================================================

const { v4: uuid } = require('uuid');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');
const { parseRange } = require('../utils/timestamp');
const { downloadVideo, killJob: killYtdlpJob } = require('./ytdlp-natok');
const ffmpegMod = require('./ffmpeg');
const { makeClip, concatClips, killJob: killFfmpegJob } = ffmpegMod;
const { injectThumbnailCard, killJob: killThumbJob } = require('./ffmpeg-thumbnail');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';
const TEMP_DIR   = process.env.TEMP_DIR   || '/tmp/waz';
const STORE_FILE = path.join(OUTPUT_DIR, '_jobs-clipper.json');

let jobs = {};
const aborted = new Set();

// ── Global serial queue ──────────────────────────────────────────────
// Ensures only ONE job runs at a time (download + ffmpeg).
// Prevents Railway OOM / ffmpeg frame-stuck caused by parallel jobs.
let _queueRunning = false;
const _queue = [];

function enqueueJob(id) {
  return new Promise((resolve, reject) => {
    _queue.push({ id, resolve, reject });
    _drainQueue();
  });
}

function _drainQueue() {
  if (_queueRunning || !_queue.length) return;
  // Skip any queued jobs that were aborted before they started
  while (_queue.length && aborted.has(_queue[0].id)) {
    const { id, resolve } = _queue.shift();
    logger.info(`[job:${id}] skipped from queue (already aborted)`);
    resolve();
  }
  if (!_queue.length) return;
  _queueRunning = true;
  const { id, resolve, reject } = _queue.shift();
  runJob(id).then(resolve, reject).finally(() => {
    _queueRunning = false;
    _drainQueue();
  });
}

// Remove a job from the waiting queue without running it
function _removeFromQueue(id) {
  const idx = _queue.findIndex(e => e.id === id);
  if (idx !== -1) {
    const { resolve } = _queue.splice(idx, 1)[0];
    resolve(); // resolve so the enqueueJob Promise doesn't hang
    return true;
  }
  return false;
}
// ────────────────────────────────────────────────────────────────────

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) jobs = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (e) {
    logger.warn('Could not load clipper job store:', e.message);
  }
}
function saveStore() {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(jobs, null, 2));
  } catch (_) {}
}
loadStore();

function sanitizeName(s) {
  return String(s || 'clip')
    .replace(/[\\/:"*?<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'clip';
}

function normalizeUrl(url) {
  if (!url) return url;
  return String(url).trim().replace(/^(Https?|HTTPS?):/i, m => m.toLowerCase());
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}

// Accepts ANY of these for a clip:
//   { range: "HH:MM:SS-HH:MM:SS" }                   -> single
//   { ranges: ["a-b", "c-d"] }                       -> recap (array)
//   { ranges: "a-b\nc-d, e-f; g-h" }                 -> recap (newline / comma / semicolon string)
//   { range:  "a-b\nc-d" }                           -> recap via range string too
function toRanges(clip) {
  const out = [];
  const push = v => {
    if (v == null) return;
    String(v).split(/[\n,;]+/).forEach(s => {
      const t = s.trim();
      if (t) out.push(t);
    });
  };
  if (Array.isArray(clip.ranges)) clip.ranges.forEach(push);
  else push(clip.ranges);
  if (!out.length) push(clip.range);
  return out;
}

const VALID_STYLES = new Set([
  'yellow_box', 'gradient', 'centered',
  'natok_emotional', 'natok_dark', 'natok_minimal', 'natok_warm',
  'natok_header_v1', 'natok_golden', 'natok_modern',
  'natok_purple', 'natok_gold2', 'natok_green',
]);
const VALID_CROPS  = new Set(['crop', 'fit']);
const VALID_GRADES = new Set(['none', 'warm', 'cool', 'cinema', 'vivid', 'bright', 'natural', 'custom']);

function buildDucking(payload) {
  const d = payload && typeof payload === 'object' ? payload : {};
  return {
    enabled: !!d.enabled,
    threshold: clamp(d.threshold, 0.001, 1, 0.03),
    ratio: clamp(d.ratio, 1, 40, 12),
    attack: clamp(d.attack, 1, 5000, 100),
    release: clamp(d.release, 1, 5000, 400),
  };
}

function parseSubTs(ts) {
  const parts = String(ts).trim().split(':');
  if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + +parts[2];
  if (parts.length === 2) return +parts[0] * 60 + +parts[1];
  return parseFloat(ts) || 0;
}

function normalizeSubtitles(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .map(s => ({
      t:    String(s.t || s.time || s.start || '0').trim(),
      text: String(s.text || s.txt || '').trim(),
    }))
    .filter(s => s.text.length > 0)
    .sort((a, b) => parseSubTs(a.t) - parseSubTs(b.t));
}

function createJob(payload) {
  const id = uuid().slice(0, 8);
  const defaultStyle = VALID_STYLES.has(payload.defaultStyle) ? payload.defaultStyle : 'centered';
  const cropMode     = VALID_CROPS.has(payload.cropMode) ? payload.cropMode : 'crop';
  const colorGrade   = VALID_GRADES.has(payload.colorGrade) ? payload.colorGrade : 'none';
  const customGradeFilter = (typeof payload.customGradeFilter === 'string' ? payload.customGradeFilter : '').trim();
  const partial      = payload.partial !== false;
  const extractAudio = !!payload.extractAudio;
  const musicUrl     = payload.musicUrl || null;
  const musicVolume  = clamp(payload.musicVolume, 0, 1, 0.15);
  const musicStart   = clamp(payload.musicStart, 0, 86400, 0);
  const musicEnd     = clamp(payload.musicEnd, 0, 86400, 0);
  const ducking      = buildDucking(payload.ducking);

  // Thumbnail card injection (mid-frame, ~0.004s, used as YT thumbnail).
  // Default ON. Disable per-job by passing { thumbnailCard: { enabled: false } }.
  const tcPayload    = payload.thumbnailCard && typeof payload.thumbnailCard === 'object' ? payload.thumbnailCard : {};
  const thumbnailCard = {
    enabled: tcPayload.enabled !== false,                         // default true
    durationSec: clamp(tcPayload.durationSec, 0.001, 1.0, 0.004),
  };

  const job = {
    id,
    type: 'clipper',
    url: normalizeUrl(payload.url),
    speaker: payload.speaker || '',
    headerText: String(payload.headerText || '').trim(),
    followText: String(payload.followText || '').trim(),
    defaultStyle,
    cropMode,
    colorGrade,
    customGradeFilter,
    partial,
    extractAudio,
    musicUrl,
    musicVolume,
    musicStart,
    musicEnd,
    ducking,
    thumbnailCard,
    musicPath: null,
    status: 'queued',
    createdAt: Date.now(),
    clips: payload.clips.map((c, i) => {
      const ranges = toRanges(c);
      return {
        index: i,
        title: c.title || `Clip ${i + 1}`,
        range: ranges[0] || '',
        ranges: ranges.length > 1 ? ranges : undefined,
        recap: ranges.length > 1,
        style: VALID_STYLES.has(c.style) ? c.style : defaultStyle,
        subtitles: normalizeSubtitles(c.subtitles),
        status: 'pending',
        filename: null,
        error: null,
        driveFileId: null,
        telegramUploaded: false,
        telegramMessageId: null,
        telegramFileId: null,
      };
    }),
    sourcePath: null,
    error: null,
  };

  jobs[id] = job;
  saveStore();
  setImmediate(() => enqueueJob(id));
  return job;
}

function checkAborted(id) {
  return aborted.has(id) || !jobs[id];
}

function downloadMusic(job, jl) {
  if (!job.musicUrl) return null;
  return new Promise((resolve) => {
    if (aborted.has(job.id)) { resolve(null); return; }
    const musicOut = path.join(TEMP_DIR, `${job.id}_music.%(ext)s`);
    try { fs.mkdirSync(path.dirname(musicOut), { recursive: true }); } catch (_) {}
    jl.info(`🎵 Downloading music: ${job.musicUrl}`);
    const { spawn: sp } = require('child_process');
    const proc = sp('yt-dlp', [
      '-x', '--audio-format', 'm4a',
      '-o', musicOut,
      '--no-playlist', '--no-warnings',
      job.musicUrl,
    ], { stdio: 'ignore' });

    // Register with ffmpeg's RUNNING map so killJob can reach it
    const RUNNING_MAP = ffmpegMod.__RUNNING__;
    if (RUNNING_MAP) {
      if (!RUNNING_MAP.has(job.id)) RUNNING_MAP.set(job.id, new Set());
      RUNNING_MAP.get(job.id).add(proc);
      proc.on('close', () => {
        const s = RUNNING_MAP.get(job.id);
        if (s) { s.delete(proc); if (!s.size) RUNNING_MAP.delete(job.id); }
      });
    }

    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch(_){} }, 120000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (aborted.has(job.id)) { resolve(null); return; }
      const dir = path.dirname(musicOut);
      const base = path.basename(musicOut, '.%(ext)s');
      try {
        const hit = fs.readdirSync(dir).find(f => f.startsWith(base + '.'));
        if (hit) {
          const full = path.join(dir, hit);
          jl.info(`✓ Music downloaded: ${full}`);
          resolve(full);
          return;
        }
      } catch (_) {}
      jl.warn('Music download failed or aborted (continuing without music)');
      resolve(null);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      jl.warn(`Music download error (continuing without music): ${e.message}`);
      resolve(null);
    });
  });
}

async function runJob(id) {
  const job = jobs[id];
  if (!job) return;

  const jl = logger.forJob(id);
  job.status = 'downloading';
  saveStore();

  try {
    job.musicPath = await downloadMusic(job, jl);

    const rangeMap = [];
    const clipRanges = [];
    for (const clip of job.clips) {
      const ranges = clip.ranges && clip.ranges.length ? clip.ranges : [clip.range];
      const idxs = [];
      for (const r of ranges) {
        idxs.push(clipRanges.length);
        clipRanges.push(r);
      }
      rangeMap.push(idxs);
    }

    jl.info(`📥 Source download starting: ${job.url} (partial=${job.partial}, sections=${clipRanges.length})`);
    const dl = await downloadVideo(job.url, id, jl, {
      partial: job.partial,
      clipRanges,
    });

    if (checkAborted(id)) { jl.warn('Job aborted by user — stopping after download.'); return; }

    job.sourcePath = dl.sources[0] && dl.sources[0].sourcePath;
    jl.info(`✅ Download complete (mode=${dl.mode}); ${dl.sources.filter(s => s.sourcePath).length}/${dl.sources.length} sources ready`);

    job.status = 'clipping';
    saveStore();

    for (const clip of job.clips) {
      if (checkAborted(id)) { jl.warn('Job aborted — stopping clip loop.'); return; }

      try {
        const partSourceIndexes = rangeMap[clip.index] || [];
        const partRanges = clip.ranges && clip.ranges.length ? clip.ranges : [clip.range];
        const safeTitle = sanitizeName(clip.title);
        const filename = `${id}__${String(clip.index + 1).padStart(2, '0')}__${safeTitle}.mp4`;
        const out = path.join(OUTPUT_DIR, filename);
        const tempParts = [];

        clip.status = partRanges.length > 1 ? 'rendering_recap' : 'rendering';
        saveStore();

        jl.info(`🎬 Clip ${clip.index + 1}: ${partRanges.length > 1 ? `recap mode (${partRanges.length} ranges)` : partRanges[0]}`);

        for (let partNo = 0; partNo < partRanges.length; partNo++) {
          if (checkAborted(id)) { jl.warn('Job aborted during recap render.'); return; }

          const src = dl.sources[partSourceIndexes[partNo]];
          if (!src || !src.sourcePath) {
            throw new Error(`Source download failed for this section: ${src && src.error ? src.error : (dl.sources && dl.sources.length ? 'source file missing' : 'all sources failed')}`);
          }

          const { start: origStart, duration } = parseRange(partRanges[partNo]);
          const localStart = Math.max(0, origStart - (src.sectionStart || 0));
          const partOut = partRanges.length > 1
            ? path.join(TEMP_DIR, id, `${clip.index + 1}_${partNo + 1}_${safeTitle}.mp4`)
            : out;

          jl.info(`   ↳ Part ${partNo + 1}/${partRanges.length}: source=${path.basename(src.sourcePath)}, sectionStart=${(src.sectionStart || 0).toFixed(2)}s, origStart=${origStart}s → localStart=${localStart.toFixed(2)}s, dur=${duration}s`);
          jl.info(`   ↳ subtitles count: ${(clip.subtitles || []).length} | first: ${clip.subtitles && clip.subtitles[0] ? JSON.stringify(clip.subtitles[0]) : 'none'}`);

          await makeClip({
            input: src.sourcePath,
            start: localStart,
            duration,
            title: clip.title,
            speaker: job.speaker,
            titleStyle: clip.style,
            cropMode: job.cropMode,
            colorGrade: job.colorGrade || 'none',
            customGradeFilter: job.customGradeFilter || '',
            musicFile: job.musicPath || null,
            musicVolume: job.musicVolume || 0.15,
            musicStart: job.musicStart || 0,
            musicEnd: job.musicEnd || 0,
            output: partOut,
            workDir: path.join(TEMP_DIR, id),
            jobLog: jl,
            jobId: id,
            customHeaderText: job.headerText,
            followText: job.followText,
            ducking: job.ducking,
            subtitles: clip.subtitles || [],
          });

          tempParts.push(partOut);
        }

        if (partRanges.length > 1) {
          clip.status = 'merging';
          saveStore();
          jl.info(`🧩 Recap merge starting: ${tempParts.length} parts → ${filename}`);
          await concatClips(tempParts, out, jl, id);
          jl.info(`🧩 Recap merge done: ${filename}`);
        }

        if (checkAborted(id)) { jl.warn('Job aborted right after clip ' + (clip.index + 1)); return; }

        // ----- Thumbnail card injection (mid-frame ~0.004s) -----
        if (job.thumbnailCard && job.thumbnailCard.enabled) {
          try {
            clip.status = 'thumbnailing';
            saveStore();
            await injectThumbnailCard({
              videoPath: out,
              title: clip.title,
              titleStyle: clip.style,
              workDir: path.join(TEMP_DIR, id, 'thumb'),
              jobLog: jl,
              jobId: id,
              durationSec: job.thumbnailCard.durationSec,
            });
          } catch (te) {
            // Never fail the whole clip just because of the thumbnail step
            jl.warn(`thumbnail-card: skipped (${te.message})`);
          }
        }

        clip.filename = filename;
        clip.status = 'ready';
        saveStore();
        jl.info(`🎬 Clip ${clip.index + 1} ready: ${filename}`);

        // ── Audio Extract (vocal clean workflow) ─────────────────────
        if (job.extractAudio) {
          try {
            const audioOut = path.join(OUTPUT_DIR, filename.replace(/\.mp4$/, '.m4a'));
            jl.info(`🎵 Extracting audio for vocal clean: ${path.basename(audioOut)}`);
            await new Promise((resolve, reject) => {
              const { spawn: sp } = require('child_process');
              const proc = sp('ffmpeg', [
                '-y', '-i', out,
                '-vn', '-acodec', 'copy',
                audioOut,
              ], { stdio: 'ignore' });
              proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg audio extract exited ${code}`)));
              proc.on('error', reject);
            });
            clip.audioPath = audioOut;
            clip.audioFilename = path.basename(audioOut);
            clip.status = 'waiting_audio';
            clip.waitingForAudio = true;
            saveStore();
            jl.info(`⏸ Clip ${clip.index + 1} waiting for cleaned audio upload: ${path.basename(audioOut)}`);
          } catch (ae) {
            jl.warn(`Audio extract failed (skipping): ${ae.message}`);
          }
        }
      } catch (e) {
        clip.status = 'failed';
        clip.error = e.message;
        jl.error(`❌ Clip ${clip.index + 1} failed: ${e.message}`);
        saveStore();
      }
    }

    if (!checkAborted(id)) {
      job.status = 'done';
      saveStore();
      jl.info('🏁 Job done');
    }
  } catch (e) {
    if (checkAborted(id)) {
      jl.warn(`Job aborted: ${e.message}`);
    } else {
      job.status = 'failed';
      job.error = e.message;
      jl.error('Job failed:', e);
      saveStore();
    }
  } finally {
    try {
      const dir = path.join(TEMP_DIR, id);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
    aborted.delete(id);
  }
}

function getJob(id) { return jobs[id] || null; }
function listJobs() {
  return Object.values(jobs).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

function deleteJob(id) {
  const j = jobs[id];
  if (!j) return false;

  aborted.add(id);
  _removeFromQueue(id); // cancel if still waiting in queue
  const ytKilled    = killYtdlpJob(id);
  const ffKilled    = killFfmpegJob ? killFfmpegJob(id) : 0;
  const thumbKilled = killThumbJob ? killThumbJob(id) : 0;
  if (ytKilled || ffKilled || thumbKilled) {
    logger.info(`[job:${id}] killed ${ytKilled} yt-dlp + ${ffKilled} ffmpeg + ${thumbKilled} thumb proc(s)`);
  }

  for (const c of j.clips) {
    if (c.filename) {
      try { fs.unlinkSync(path.join(OUTPUT_DIR, c.filename)); } catch (_) {}
    }
  }

  try {
    const dir = path.join(TEMP_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}

  delete jobs[id];
  saveStore();
  return true;
}

// ── Resume clip with cleaned audio ──────────────────────────────────
// Called from route when user uploads vocal-cleaned audio.
// Re-renders the clip with cleaned audio + bg music, replaces the file.
async function resumeWithCleanedAudio(jobId, clipIndex, cleanedAudioPath) {
  const job = jobs[jobId];
  if (!job) throw new Error('Job not found');
  const clip = job.clips[clipIndex];
  if (!clip) throw new Error('Clip not found');
  if (clip.status !== 'waiting_audio') throw new Error('Clip is not waiting for audio');

  const jl = logger.child(`[job:${jobId}]`);
  const out = path.join(OUTPUT_DIR, clip.filename);
  const tempOut = out.replace(/\.mp4$/, '_rerender.mp4');

  clip.status = 'rerendering';
  saveStore();
  jl.info(`🔁 Re-rendering clip ${clipIndex + 1} with cleaned audio: ${path.basename(cleanedAudioPath)}`);

  try {
    // Mix cleaned audio + bg music using ffmpeg
    const inputs = ['-i', out, '-i', cleanedAudioPath];
    const hasBgMusic = job.musicPath && fs.existsSync(job.musicPath);
    if (hasBgMusic) inputs.push('-i', job.musicPath);

    let audioFilter, audioMap;
    if (hasBgMusic) {
      const vol = job.musicVolume || 0.15;
      audioFilter = `[1:a]highpass=f=180,speechnorm=e=12.5:r=0.0001:l=1[va];[2:a]volume=${vol},aloop=loop=-1:size=2e+09[bg];[va][bg]amix=inputs=2:duration=first:dropout_transition=3[aout]`;
      audioMap = '[aout]';
    } else {
      audioFilter = `[1:a]highpass=f=180,speechnorm=e=12.5:r=0.0001:l=1[aout]`;
      audioMap = '[aout]';
    }

    await new Promise((resolve, reject) => {
      const { spawn: sp } = require('child_process');
      const args = [
        '-y',
        ...inputs,
        '-filter_complex', audioFilter,
        '-map', '0:v',
        '-map', audioMap,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100',
        '-shortest',
        '-movflags', '+faststart',
        tempOut,
      ];
      const proc = sp('ffmpeg', args, { stdio: 'ignore' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg rerender exited ${code}`)));
      proc.on('error', reject);
    });

    // Replace original with re-rendered
    fs.renameSync(tempOut, out);
    clip.status = 'ready';
    clip.waitingForAudio = false;
    clip.cleanedAudioPath = cleanedAudioPath;
    saveStore();
    jl.info(`✅ Clip ${clipIndex + 1} re-rendered with cleaned audio`);
  } catch (e) {
    if (fs.existsSync(tempOut)) try { fs.unlinkSync(tempOut); } catch (_) {}
    clip.status = 'failed';
    clip.error = `Re-render failed: ${e.message}`;
    saveStore();
    jl.error(`❌ Re-render failed: ${e.message}`);
    throw e;
  }
}

module.exports = { createJob, getJob, listJobs, deleteJob, saveStore, resumeWithCleanedAudio };
