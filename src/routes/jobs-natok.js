'use strict';

const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const multer = require('multer');
const { createJob, getJob, listJobs, deleteJob, resumeWithCleanedAudio } = require('../services/jobManager-natok');
const { logger } = require('../utils/logger');

const TEMP_DIR = process.env.TEMP_DIR || '/tmp/waz';
const upload   = multer({ dest: TEMP_DIR });

router.post('/', (req, res) => {
  try {
    const {
      url, speaker, defaultStyle, cropMode, clips, partial,
      colorGrade, musicUrl, musicVolume, musicStart, musicEnd,
      headerText, followText, ducking, extractAudio,
    } = req.body || {};

    if (!url || !String(url).trim()) {
      logger.warn('[natok route] reject: missing url. body keys =', Object.keys(req.body || {}));
      return res.status(400).json({ error: 'url required' });
    }
    if (!Array.isArray(clips) || !clips.length) {
      logger.warn('[natok route] reject: clips[] missing/empty');
      return res.status(400).json({ error: 'clips[] required (at least one clip or recap item)' });
    }

    function hasAnyRange(c) {
      if (Array.isArray(c.ranges) && c.ranges.some(r => String(r || '').trim())) return true;
      if (typeof c.ranges === 'string' && c.ranges.trim()) return true;
      if (c.range && String(c.range).trim()) return true;
      return false;
    }
    for (const [i, c] of clips.entries()) {
      if (!hasAnyRange(c)) {
        logger.warn(`[natok route] reject: clips[${i}] has no range/ranges`, c);
        return res.status(400).json({ error: `clips[${i}] needs a 'range' or 'ranges' (got: ${JSON.stringify(c).slice(0,120)})` });
      }
    }

    const job = createJob({
      url, speaker, defaultStyle, cropMode, clips, partial,
      colorGrade, musicUrl, musicVolume, musicStart, musicEnd,
      headerText, followText, ducking, extractAudio,
    });
    logger.info(`[natok route] ✓ job ${job.id} created with ${job.clips.length} clip(s) extractAudio=${!!extractAudio}`);
    res.json({ ok: true, jobId: job.id, job });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ── Audio download — user downloads extracted audio for vocal clean ──
router.get('/:id/clips/:clipIndex/audio', (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'job not found' });
  const clip = j.clips[parseInt(req.params.clipIndex, 10)];
  if (!clip) return res.status(404).json({ error: 'clip not found' });
  if (!clip.audioPath || !fs.existsSync(clip.audioPath)) {
    return res.status(404).json({ error: 'audio not ready yet' });
  }
  res.download(clip.audioPath, clip.audioFilename || 'audio.m4a');
});

// ── Audio upload — user uploads vocal-cleaned audio ──────────────────
router.post('/:id/clips/:clipIndex/audio', upload.single('audio'), async (req, res) => {
  try {
    const j = getJob(req.params.id);
    if (!j) return res.status(404).json({ error: 'job not found' });
    const clipIndex = parseInt(req.params.clipIndex, 10);
    const clip = j.clips[clipIndex];
    if (!clip) return res.status(404).json({ error: 'clip not found' });
    if (clip.status !== 'waiting_audio') {
      return res.status(400).json({ error: `clip status is '${clip.status}', expected 'waiting_audio'` });
    }
    if (!req.file) return res.status(400).json({ error: 'no audio file uploaded' });

    const cleanedPath = req.file.path;
    // Run re-render async, respond immediately
    res.json({ ok: true, message: 'Audio received, re-rendering...' });
    await resumeWithCleanedAudio(req.params.id, clipIndex, cleanedPath);
  } catch (e) {
    logger.error('[natok audio upload]', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

router.get('/',     (req, res) => res.json({ jobs: listJobs() }));
router.get('/:id',  (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});
router.delete('/:id', (req, res) => {
  const ok = deleteJob(req.params.id);
  res.json({ ok, killed: ok });
});

router.get('/:id/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const tag = `[job:${req.params.id}]`;
  const { logger: lg } = require('../utils/logger');
  for (const e of lg.recent(300)) {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  const unsub = lg.subscribe(e => {
    if (e.line.includes(tag)) res.write(`data: ${JSON.stringify(e)}\n\n`);
  });
  req.on('close', () => unsub());
});

module.exports = router;
