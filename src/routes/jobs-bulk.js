'use strict';

const router = require('express').Router();
const { createJob, getJob, listJobs, deleteJob } = require('../services/jobManager-bulk');
const { logger } = require('../utils/logger');

router.post('/', (req, res) => {
  try {
    const { urls, urlsText, mode } = req.body || {};
    if (!urls && !urlsText) {
      return res.status(400).json({ error: 'urls[] or urlsText required' });
    }
    const job = createJob({ urls, urlsText, mode });
    res.json({ ok: true, jobId: job.id, job });
  } catch (e) {
    logger.error(e);
    res.status(400).json({ error: e.message });
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
