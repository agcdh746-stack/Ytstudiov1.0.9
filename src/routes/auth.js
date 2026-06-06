'use strict';

const router = require('express').Router();
const { getAuthUrl, exchangeCode } = require('../services/drive');
const { logger } = require('../utils/logger');

router.get('/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).send('GOOGLE_CLIENT_ID is not configured. Check env vars.');
  }
  res.redirect(getAuthUrl());
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error}`);
    if (!code)  return res.status(400).send('Missing ?code');
    const tokens = await exchangeCode(code);
    req.session.googleTokens = tokens;
    logger.info('Google OAuth success');
    res.redirect('/?auth=ok');
  } catch (e) {
    logger.error('OAuth callback failed:', e);
    res.status(500).send('OAuth failed: ' + e.message);
  }
});

router.post('/logout', (req, res) => {
  req.session.googleTokens = null;
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({ authenticated: !!req.session.googleTokens });
});

module.exports = router;
