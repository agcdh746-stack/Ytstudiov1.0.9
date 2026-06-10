'use strict';

const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { createJob, getJob, listJobs, deleteJob } = require('../services/jobManager-subburner');
const { logger } = require('../utils/logger');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';
const SRT_DIR    = process.env.TEMP_DIR
  ? path.join(process.env.TEMP_DIR, 'srt-uploads')
  : '/tmp/srt-uploads';
const AUDIO_DIR  = process.env.TEMP_DIR
  ? path.join(process.env.TEMP_DIR, 'audio-uploads')
  : '/tmp/audio-uploads';

fs.mkdirSync(SRT_DIR,   { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Multer storage — keep original extension so Python can read it
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SRT_DIR),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Audio multer — larger limit (150MB WAV/MP3)
const audioStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
  filename:    (_req, file, cb) => {
    cb(null, `${Date.now()}_sr_audio.wav`);
  },
});
const audioUpload = multer({ storage: audioStorage, limits: { fileSize: 150 * 1024 * 1024 } });

// ── POST /api/jobs/subburner/upload-srt ───────────────────────────────────────
router.post('/upload-srt', upload.single('srt'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'srt file required' });
  res.json({ ok: true, srtPath: req.file.path, originalName: req.file.originalname });
});

// ── POST /api/jobs/subburner/upload-audio ─────────────────────────────────────
router.post('/upload-audio', audioUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });
  res.json({ ok: true, audioPath: req.file.path, originalName: req.file.originalname });
});

// ── POST /api/jobs/subburner ──────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const {
      videoUrl, referer, srtPath, preset, crop169,
      mode, title, clips, targets,
      sources, recapMerge,           // recap mode fields

      // New common fields
      colorGrade, subPos, fontSize,  // color grading, subtitle position, font size
      bgm,                           // {url, start, end, volume} background music
      driveFolder,                   // Google Drive folder URL (all modes)

      // screenshot_recap fields
      sr_timestamps, sr_audio_path, sr_atempo, sr_drive_folder,
      sr_kb_effect, sr_ss_quality, sr_bgm,
    } = req.body || {};

    if (mode === 'recap') {
      if (!Array.isArray(sources) || !sources.length)
        return res.status(400).json({ error: 'sources[] required for recap mode' });
      for (const s of sources) {
        if (!s.url) return res.status(400).json({ error: 'each source must have url' });
        if (!Array.isArray(s.clips) || !s.clips.length)
          return res.status(400).json({ error: 'each source must have clips[]' });
      }
    } else if (mode === 'screenshot_recap') {
      if (!Array.isArray(sr_timestamps) || !sr_timestamps.length)
        return res.status(400).json({ error: 'sr_timestamps[] required for screenshot_recap mode' });
      if (!sr_audio_path)
        return res.status(400).json({ error: 'sr_audio_path required for screenshot_recap mode' });
      if (!fs.existsSync(sr_audio_path))
        return res.status(400).json({ error: `sr_audio_path not found: ${sr_audio_path}` });
      if (!videoUrl && (!Array.isArray(sources) || !sources.length))
        return res.status(400).json({ error: 'videoUrl or sources[] required for screenshot_recap' });
    } else {
      if (!videoUrl) return res.status(400).json({ error: 'videoUrl required' });
      if (mode === 'clip' && (!Array.isArray(clips) || !clips.length))
        return res.status(400).json({ error: 'clips[] required for clip mode' });
    }

    if (srtPath && !fs.existsSync(srtPath))
      return res.status(400).json({ error: `srtPath not found on server: ${srtPath}` });

    const job = createJob({
      videoUrl, referer, srtPath: srtPath || null, preset, crop169,
      mode, title, clips, targets, sources, recapMerge,

      // New common fields
      colorGrade: colorGrade || 'natural',
      subPos:     subPos     || 'bottom',
      fontSize:   fontSize   || 38,
      bgm:        bgm        || null,
      driveFolder: driveFolder || '',

      // screenshot_recap fields
      sr_timestamps, sr_audio_path, sr_atempo, sr_drive_folder,
      sr_kb_effect: sr_kb_effect || 'random',
      sr_ss_quality: sr_ss_quality || '2',
      sr_bgm: sr_bgm || null,
    });
    res.json({ ok: true, jobId: job.id, job });
  } catch (e) {
    logger.error('[subburner route]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/jobs/subburner ───────────────────────────────────────────────────
router.get('/', (_req, res) => res.json({ jobs: listJobs() }));

// ── GET /api/jobs/subburner/:id ───────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// ── DELETE /api/jobs/subburner/:id ────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const ok = deleteJob(req.params.id);
  res.json({ ok, killed: ok });
});

// ── GET /api/jobs/subburner/:id/logs  (SSE) ───────────────────────────────────
router.get('/:id/logs', (req, res) => {
  res.set({
    'Content-Type':    'text/event-stream',
    'Cache-Control':   'no-cache',
    'Connection':      'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const tag = `[job:${req.params.id}]`;
  const { logger: lg } = require('../utils/logger');

  // Replay recent ring-buffer entries that belong to this job
  for (const e of lg.recent(300)) {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }

  const unsub = lg.subscribe(e => {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  req.on('close', () => unsub());
});

// ── GET /api/jobs/subburner/:id/files/:filename  (output download) ────────────
router.get('/:id/files/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, 'subburner', req.params.id, req.params.filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'file not found' });
  res.setHeader('Cache-Control', 'no-store');
  res.download(filePath);
});

module.exports = router;
