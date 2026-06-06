'use strict';

// =====================================================================
// YT Studio — Unified Drive upload route
//
// Supports BOTH clipper jobs (have `clips[]`) and bulk jobs (have `items[]`).
// We auto-detect the job type by looking up in both managers.
// =====================================================================

const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const { uploadFile, extractFolderId } = require('../services/drive');
const clipperJM = require('../services/jobManager-clipper');
const natokJM   = require('../services/jobManager-natok');
const bulkJM    = require('../services/jobManager-bulk');
const { logger } = require('../utils/logger');

const OUTPUT_DIR = process.env.OUTPUT_DIR || '/app/data/output';

function requireAuth(req, res, next) {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated. Login at /auth/google' });
  next();
}

function buildClipDriveName(title, index) {
  const safe = String(title || `Clip ${index + 1}`)
    .replace(/[\\/:"*?<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || `Clip ${index + 1}`;
  return `${safe}.mp4`;
}

router.post('/upload', requireAuth, async (req, res) => {
  try {
    const { jobId, folderUrl, indices } = req.body || {};
    if (!jobId)     return res.status(400).json({ error: 'jobId required' });
    if (!folderUrl) return res.status(400).json({ error: 'folderUrl required' });

    const folderId = extractFolderId(folderUrl);
    if (!folderId) return res.status(400).json({ error: 'Could not parse Drive folder ID' });

    // Lookup in all managers
    const clipperJob = clipperJM.getJob(jobId);
    const natokJob   = natokJM.getJob(jobId);
    const bulkJob    = bulkJM.getJob(jobId);
    const job = natokJob || clipperJob || bulkJob;
    if (!job) return res.status(404).json({ error: 'job not found' });

    const isClipper = !!(clipperJob || natokJob);
    const results = [];

    if (isClipper) {
      let targets = job.clips.filter(c => c.status === 'ready' && c.filename);
      if (Array.isArray(indices) && indices.length) {
        const set = new Set(indices.map(Number));
        targets = targets.filter(c => set.has(c.index));
      }
      if (!targets.length) return res.status(400).json({ error: 'no ready clips selected' });

      for (const clip of targets) {
        const fp = path.join(OUTPUT_DIR, clip.filename);
        if (!fs.existsSync(fp)) {
          results.push({ index: clip.index, ok: false, error: 'file missing' });
          continue;
        }
        try {
          const displayName = buildClipDriveName(clip.title, clip.index);
          const description = `Speaker: ${job.speaker || '-'}\nRange: ${clip.range}\nStyle: ${clip.style}\nSource: ${job.url}`;
          const r = await uploadFile(req.session.googleTokens, fp, folderId, displayName, description);
          clip.driveFileId = r.id;
          results.push({ index: clip.index, ok: true, id: r.id, name: r.name, link: r.webViewLink });
        } catch (e) {
          logger.error('Drive upload failed:', e);
          results.push({ index: clip.index, ok: false, error: e.message });
        }
      }
    } else {
      let targets = job.items.filter(it => it.status === 'ready' && it.fileName);
      if (Array.isArray(indices) && indices.length) {
        const set = new Set(indices.map(Number));
        targets = targets.filter(it => set.has(it.index));
      }
      if (!targets.length) return res.status(400).json({ error: 'no ready items to upload' });

      for (const item of targets) {
        const fp = path.join(OUTPUT_DIR, item.fileName);
        if (!fs.existsSync(fp)) {
          results.push({ index: item.index, ok: false, error: 'file missing' });
          continue;
        }
        try {
          const displayName = item.fileName;
          const description = `Source: ${item.url}\nMode: ${job.mode}\nTitle: ${item.title || '-'}\nHashtags: ${(item.hashtags || []).join(' ')}`;
          const r = await uploadFile(req.session.googleTokens, fp, folderId, displayName, description);
          item.driveFileId = r.id;
          results.push({ index: item.index, ok: true, id: r.id, name: r.name, link: r.webViewLink });
        } catch (e) {
          logger.error('Drive upload failed:', e);
          results.push({ index: item.index, ok: false, error: e.message });
        }
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
