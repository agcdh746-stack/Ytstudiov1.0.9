'use strict';

const router = require('express').Router();
const { createJob, getJob, listJobs, deleteJob } = require('../services/jobManager-clipper');
const natokJM = require('../services/jobManager-natok');
const { logger } = require('../utils/logger');


const WAZ_ONLY_STYLES = new Set(['natok_purple', 'natok_gold2', 'natok_green']);
function looksLikeNatok(body = {}) {
  const clips = Array.isArray(body.clips) ? body.clips : [];
  if (typeof body.defaultStyle === 'string' && /^natok_/.test(body.defaultStyle) && !WAZ_ONLY_STYLES.has(body.defaultStyle)) return true;
  if (String(body.headerText || '').trim()) return true;
  if (String(body.followText || '').trim()) return true;
  if (body.ducking && typeof body.ducking === 'object') return true;
  for (const c of clips) {
    if (typeof c.style === 'string' && /^natok_/.test(c.style) && !WAZ_ONLY_STYLES.has(c.style)) return true;
    if (Array.isArray(c.ranges) && c.ranges.length) return true;
    if (typeof c.ranges === 'string' && c.ranges.trim()) return true;
    if (c.recap) return true;
  }
  return false;
}

router.post('/', (req, res) => {
  try {
    const {
      url, speaker, defaultStyle, cropMode, clips, partial,
      colorGrade, musicUrl, musicVolume,
      headerText, followText, ducking,
      thumbnailCard, zoomEffect,
    } = req.body || {};

    if (!url || !String(url).trim()) {
      logger.warn('[clipper route] reject: missing url. body keys =', Object.keys(req.body || {}));
      return res.status(400).json({ error: 'url required' });
    }
    if (!Array.isArray(clips) || !clips.length) {
      logger.warn('[clipper route] reject: clips[] missing/empty');
      return res.status(400).json({ error: 'clips[] required (at least one clip or recap item)' });
    }

    // Defensive server-side auto-routing: if browser cache / old UI / wrong button
    // still posts a Natok payload into /api/jobs/clipper, move it into Natok manager
    // instead of failing with shared clipper logic.
    if (looksLikeNatok(req.body || {})) {
      const job = natokJM.createJob({
        url, speaker, defaultStyle, cropMode, clips, partial,
        colorGrade, musicUrl, musicVolume,
        headerText, followText, ducking,
        thumbnailCard,
      });
      logger.warn(`[clipper route] ↪ auto-routed natok-like payload to natok manager: ${job.id}`);
      return res.json({ ok: true, jobId: job.id, job, rerouted: 'natok' });
    }

    // Accept range as string OR ranges as string/array. Title auto-fills if missing.
    function hasAnyRange(c) {
      if (Array.isArray(c.ranges) && c.ranges.some(r => String(r || '').trim())) return true;
      if (typeof c.ranges === 'string' && c.ranges.trim()) return true;
      if (c.range && String(c.range).trim()) return true;
      return false;
    }
    for (const [i, c] of clips.entries()) {
      if (!hasAnyRange(c)) {
        logger.warn(`[clipper route] reject: clips[${i}] has no range/ranges`, c);
        return res.status(400).json({ error: `clips[${i}] needs a 'range' or 'ranges' (got: ${JSON.stringify(c).slice(0,120)})` });
      }
    }

    const job = createJob({
      url, speaker, defaultStyle, cropMode, clips, partial,
      colorGrade, musicUrl, musicVolume,
      headerText, followText, ducking,
      thumbnailCard, zoomEffect,
    });
    logger.info(`[clipper route] ✓ job ${job.id} created with ${job.clips.length} clip(s)`);
    res.json({ ok: true, jobId: job.id, job });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
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
