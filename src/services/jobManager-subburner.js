'use strict';

// =====================================================================
// YT Studio — Sub Burner Job Manager
//
// Calls sub_burner.py as a Python subprocess.
// sub_burner.py emits JSON lines to stdout; we parse them and
// broadcast to the shared ring-buffer logger (same SSE pattern as
// the Waz Clipper).
// =====================================================================

const { v4: uuid } = require('uuid');
const path         = require('path');
const fs           = require('fs');
const { spawn }    = require('child_process');
const { logger }   = require('../utils/logger');

const OUTPUT_DIR  = process.env.OUTPUT_DIR  || '/app/data/output';
const CONFIG_FILE = process.env.CONFIG_FILE || '/app/data/config.json';

const STORE_FILE    = path.join(OUTPUT_DIR, '_jobs-subburner.json');
const PYTHON_SCRIPT = path.join(__dirname, '..', '..', 'sub_burner.py');
// Prefer the venv python; fall back to system python3
const PYTHON_BIN    = fs.existsSync('/opt/venv/bin/python3')
  ? '/opt/venv/bin/python3'
  : 'python3';

let jobs = {};

// ── Global serial queue ──────────────────────────────────────────────
// Ensures only ONE job runs at a time.
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
  _queueRunning = true;
  const { id, resolve, reject } = _queue.shift();
  runJob(id).then(resolve, reject).finally(() => {
    _queueRunning = false;
    _drainQueue();
  });
}
// ────────────────────────────────────────────────────────────────────
const aborted     = new Set();
const activeProcs = new Map(); // jobId → child process

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE))
      jobs = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch (e) {
    logger.warn('[subburner] Could not load job store:', e.message);
  }
}
function saveStore() {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(jobs, null, 2));
  } catch (_) {}
}
loadStore();

// ── config helpers ────────────────────────────────────────────────────────────

function loadAppConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE))
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (_) {}
  return {};
}

function buildUploadsConfig(targets) {
  const cfg = loadAppConfig();
  const uploads = {};

  if (targets.includes('telegram')) {
    const enabled = !!(cfg.TG_BOT_TOKEN && cfg.TG_CHAT_ID);
    if (!enabled) logger.warn('[subburner] Telegram target selected but TG_BOT_TOKEN/TG_CHAT_ID not set in config');
    uploads.telegram = {
      enabled,
      bot_token: cfg.TG_BOT_TOKEN || '',
      chat_id:   cfg.TG_CHAT_ID   || '',
    };
  }

  if (targets.includes('facebook')) {
    const enabled = !!(cfg.FB_PAGE_TOKEN && cfg.FB_PAGE_ID);
    if (!enabled) logger.warn('[subburner] Facebook target selected but FB_PAGE_TOKEN/FB_PAGE_ID not set in config');
    uploads.facebook = {
      enabled,
      page_token: cfg.FB_PAGE_TOKEN || '',
      page_id:    cfg.FB_PAGE_ID    || '',
    };
  }

  if (targets.includes('youtube')) {
    const enabled = !!(cfg.YT_ACCESS_TOKEN);
    if (!enabled) logger.warn('[subburner] YouTube target selected but YT_ACCESS_TOKEN not set in config');
    uploads.youtube = {
      enabled,
      access_token: cfg.YT_ACCESS_TOKEN || '',
    };
  }

  return uploads;
}

// ── createJob ─────────────────────────────────────────────────────────────────

function createJob(payload) {
  const id = uuid().slice(0, 8);

  const job = {
    id,
    type:       'subburner',
    mode:       payload.mode      || 'full',
    videoUrl:   payload.videoUrl  || '',
    referer:    payload.referer   || '',
    srtPath:    payload.srtPath   || null,
    preset:     payload.preset    || '1',
    crop169:    !!payload.crop169,
    title:      payload.title     || 'SubBurner Video',
    clips:      Array.isArray(payload.clips)   ? payload.clips   : [],
    sources:    Array.isArray(payload.sources) ? payload.sources : [],  // recap mode
    recapMerge: !!payload.recapMerge,
    targets:    Array.isArray(payload.targets) ? payload.targets : [],
    // screenshot_recap fields
    sr_timestamps:   Array.isArray(payload.sr_timestamps) ? payload.sr_timestamps : [],
    sr_audio_path:   payload.sr_audio_path   || '',
    sr_atempo:       payload.sr_atempo       || 0.85,
    sr_drive_folder: payload.sr_drive_folder || '',
    status:     'queued',
    progress:   0,
    createdAt:  Date.now(),
    outputs:    [],
    error:      null,
  };

  jobs[id] = job;
  saveStore();
  setImmediate(() => enqueueJob(id));
  return job;
}

// ── runJob ────────────────────────────────────────────────────────────────────

async function runJob(id) {
  const job = jobs[id];
  if (!job) return;

  const jl = logger.forJob(id);
  job.status   = 'running';
  job.progress = 0;
  saveStore();

  // Per-job working directory inside OUTPUT_DIR
  const jobDir = path.join(OUTPUT_DIR, 'subburner', id);
  fs.mkdirSync(jobDir, { recursive: true });

  // Build the Python config object
  const pyConfig = {
    job_id:      id,
    mode:        job.mode,
    video_url:   job.videoUrl,
    referer:     job.referer,
    srt_path:    job.srtPath,
    preset:      job.preset,
    crop_169:    job.crop169,
    output_dir:  jobDir,
    title:       job.title,
    uploads:     buildUploadsConfig(job.targets),
    clips:       job.clips,
    sources:     job.sources,     // recap mode: [{url, referer, clips:[{start,end}]}]
    recap_merge: job.recapMerge,  // true = সব clips concat করে একটা video
    // screenshot_recap fields
    sr_timestamps:   job.sr_timestamps   || [],
    sr_audio_path:   job.sr_audio_path   || '',
    sr_atempo:       job.sr_atempo       || 0.85,
    sr_drive_folder: job.sr_drive_folder || '',
  };

  const configPath = path.join(jobDir, 'job_config.json');
  fs.writeFileSync(configPath, JSON.stringify(pyConfig, null, 2));

  jl.info(`🔥 Sub Burner starting (mode=${job.mode}, preset=${job.preset}, crop169=${job.crop169})`);
  if (job.mode === 'recap') {
    jl.info(`   Sources: ${job.sources.length} URL(s), recap_merge=${job.recapMerge}`);
  } else {
    jl.info(`   Video : ${job.videoUrl}`);
  }
  jl.info(`   Title : ${job.title}`);
  jl.info(`   Upload: ${job.targets.join(', ') || '(none)'}`);

  const child = spawn(PYTHON_BIN, [PYTHON_SCRIPT, '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FFMPEG_HTTP_PROXY: process.env.FFMPEG_HTTP_PROXY || '',
    },
  });
  activeProcs.set(id, child);

  // Parse stdout JSON lines
  let buf = '';
  child.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop(); // keep incomplete line
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        handlePyEvent(id, jl, obj);
      } catch (_) {
        jl.info(line); // plain text fallback
      }
    }
  });

  // stderr → warn log (Python tracebacks, etc.)
  child.stderr.on('data', chunk => {
    const lines = chunk.toString().split('\n');
    for (const l of lines) {
      const t = l.trim();
      if (t) jl.warn(`[py] ${t}`);
    }
  });

  child.on('close', code => {
    activeProcs.delete(id);
    if (aborted.has(id)) {
      jl.warn('Job aborted by user.');
      aborted.delete(id);
      return;
    }
    const j2 = jobs[id];
    if (!j2) return;
    if (code !== 0 && j2.status === 'done') {
      // Python emitted {type:'done'} then crashed on cleanup — treat as success
      // but warn so the log shows the crash.
      jl.warn(`⚠ Python exited ${code} after job was already marked done — treating as success.`);
      saveStore();
    } else if (code !== 0 && j2.status !== 'failed') {
      j2.status = 'failed';
      j2.error  = `Python exited with code ${code}`;
      jl.error(`❌ Python process exited: code ${code}`);
      saveStore();
    } else if (j2.status === 'running') {
      // Python exited 0 but never emitted {type:'done'} — mark done anyway
      j2.status = 'done';
      saveStore();
      jl.info('🏁 Job finished.');
    }
  });
}

function handlePyEvent(id, jl, obj) {
  const job = jobs[id];
  if (!job) return;

  switch (obj.type) {
    case 'log': {
      const fn = jl[obj.level] || jl.info;
      fn.call(jl, obj.msg);
      break;
    }
    case 'progress': {
      job.progress = obj.pct;
      saveStore();
      // Small milestones only (avoid spam)
      if (obj.pct % 10 === 0 || obj.stage === 'done') {
        jl.info(`⏳ ${obj.pct}% [${obj.stage}]`);
      }
      break;
    }
    case 'clip_start': {
      jl.info(`🎬 Clip ${obj.index + 1} starting: "${obj.title}"`);
      break;
    }
    case 'clip_done': {
      if (obj.status === 'ready') {
        job.outputs.push({
          clip:  obj.index + 1,
          title: obj.title,
          file:  obj.file,
          links: obj.links || {},
        });
        jl.info(`✅ Clip ${obj.index + 1} ready: ${obj.file}`);
      } else {
        jl.error(`❌ Clip ${obj.index + 1} failed: ${obj.title}`);
      }
      saveStore();
      break;
    }
    case 'done': {
      if (aborted.has(id)) break;
      job.status   = 'done';
      job.progress = 100;
      if (Array.isArray(obj.outputs) && obj.outputs.length) {
        job.outputs = obj.outputs;
      }
      jl.info('🏁 Job done');
      saveStore();
      break;
    }
    case 'error': {
      job.status = 'failed';
      job.error  = obj.msg;
      jl.error(`❌ Error: ${obj.msg}`);
      saveStore();
      break;
    }
    default:
      break;
  }
}

// ── public API ────────────────────────────────────────────────────────────────

function getJob(id)  { return jobs[id] || null; }
function listJobs()  {
  return Object.values(jobs)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50);
}

function deleteJob(id) {
  const j = jobs[id];
  if (!j) return false;

  aborted.add(id);

  const child = activeProcs.get(id);
  if (child) {
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
    activeProcs.delete(id);
  }

  // Clean up job output directory
  const jobDir = path.join(OUTPUT_DIR, 'subburner', id);
  try { if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}

  delete jobs[id];
  saveStore();
  return true;
}

module.exports = { createJob, getJob, listJobs, deleteJob };
