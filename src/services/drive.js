'use strict';

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { logger } = require('../utils/logger');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl() {
  const oAuth2 = makeOAuth2Client();
  return oAuth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

async function exchangeCode(code) {
  const oAuth2 = makeOAuth2Client();
  const { tokens } = await oAuth2.getToken(code);
  return tokens;
}

function clientFromTokens(tokens) {
  const o = makeOAuth2Client();
  o.setCredentials(tokens);
  return o;
}

function extractFolderId(input) {
  if (!input) return null;
  const m = String(input).match(/folders\/([A-Za-z0-9_\-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_\-]{10,}$/.test(input)) return input;
  return null;
}

/**
 * Upload to Drive.
 *  - displayName  → file name visible in Drive (acts as caption)
 *  - description  → Drive file description (extra metadata)
 */
async function uploadFile(tokens, filePath, folderId, displayName, description) {
  const auth = clientFromTokens(tokens);
  const drive = google.drive({ version: 'v3', auth });

  const fileMetadata = {
    name: displayName || path.basename(filePath),
    parents: folderId ? [folderId] : undefined,
  };
  if (description) fileMetadata.description = description;

  const media = {
    mimeType: 'video/mp4',
    body: fs.createReadStream(filePath),
  };
  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  logger.info(`Uploaded to Drive: ${res.data.name} (${res.data.id})`);
  return res.data;
}

module.exports = { getAuthUrl, exchangeCode, uploadFile, extractFolderId, SCOPES };
