'use strict';

// =====================================================================
// YT Studio — Bulk downloader service (bulk-yt-downloader v3.0 as-is)
// No POT. Deno JS runtime required. Three modes: video+audio / audio / video.
// =====================================================================

const YTDLP_MODULE_VERSION = '3.0.9-bulk-sections-fast';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

const COOKIES_FILE = process.env.COOKIES_FILE || '/app/data/cookies/cookies.txt';
const TEMP_DIR     = process.env.TEMP_DIR     || '/tmp/waz';
const OUTPUT_DIR   = process.env.OUTPUT_DIR   || '/app/data/output';

// ---------- Deno JS runtime detection ----------
let DENO_BIN = null;
function detectDeno() {
  if (DENO_BIN !== null) return DENO_BIN;
  for (const candidate of ['/usr/local/bin/deno', '/usr/bin/deno', 'deno']) {
    try {
      execSync(`${candidate} --version`, { stdio: 'pipe' });
      DENO_BIN = candidate;
      return DENO_BIN;
    } catch (_) {}
  }
  DENO_BIN = '';
  return DENO_BIN;
}

function detectProxyType() {
  const link = process.env.VMESS_LINK || '';
  if (/^vmess:/i.test(link))   return 'vmess';
  if (/^vless:/i.test(link))   return 'vless';
  if (/^trojan:/i.test(link))  return 'trojan';
  if (/^ss:/i.test(link))      return 'shadowsocks';
  if (/^socks5/i.test(link))   return 'socks5';
  const proxy = process.env.YTDLP_PROXY || '';
  if (/^socks5/i.test(proxy))  return 'socks5';
  if (/^https?:\/\//i.test(proxy)) return 'http-proxy';
  return 'direct';
}

function buildCommonArgs(jobLog) {
  const proxyType = detectProxyType();
  const isSocks   = proxyType !== 'direct' && proxyType !== 'http-proxy';
  const denoBin   = detectDeno();

  const args = [
    '--no-warnings',
    '--no-check-certificates',
    // FIX (v3.0.6): Removed --no-progress so UI live-log shows download
    // progress every ~1s (e.g. "[download] 45.2% of 9.00MiB at 1.20MiB/s
    // ETA 00:04"). Previously the log went silent for 2-4 minutes after
    // "Destination:" line, making it look frozen even though the file
    // was actually downloading in the background.
    '--progress',
    '--newline',
    '--no-playlist',
    '--retries', '10',
    '--fragment-retries', '10',
    '--retry-sleep', '3',
    '--socket-timeout', '60',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--geo-bypass',
    '--referer', 'https://www.youtube.com/',
    '--add-header', 'Origin:https://www.youtube.com',
  ];

  if (denoBin) {
    args.push('--extractor-args', `youtube:jsruntime=deno`);
    if (jobLog) jobLog.info(`✓ Deno JS runtime: ${denoBin}`);
  } else if (jobLog) {
    jobLog.warn('⚠ Deno not installed — YouTube JS challenge may fail');
  }

  // CRITICAL FIX (v3.0.2):
  // The previous code forced --hls-prefer-ffmpeg + --downloader-args
  // (ffmpeg reconnect flags) for SOCKS5. But our new format string
  // selects PROGRESSIVE mp4 (format 18) which is a single HTTPS GET,
  // NOT HLS. Forcing ffmpeg as downloader on a progressive stream made
  // ffmpeg exit non-zero after the download finished → yt-dlp wrapper
  // exit non-zero → our code marked the strategy as failed even though
  // the file was fully on disk. This matched the log:
  //   yt-dlp> [download] Download completed
  //   ✗ "web_safari" failed (OTHER) after 149.9s
  //
  // Fix: use the SAME approach as the clipper (which works perfectly):
  // native yt-dlp downloader for everything, low concurrency on SOCKS5
  // to avoid keepalive issues if HLS fallback kicks in.
  // CRITICAL FIX (v3.0.5): Parallel chunking like the Clipper.
  // Previous code used -N 1 + --concurrent-fragments 1 for SOCKS5,
  // forcing a single-connection sequential download → 64 KB/s for a 9 MB
  // short (137s total). The Clipper uses --concurrent-fragments 4 over
  // the SAME SOCKS5 tunnel and gets 10 MB/s. The slowness was NOT the
  // tunnel — it was our own throttling.
  //
  // For progressive MP4 (format 18, single HTTPS GET), --http-chunk-size
  // makes yt-dlp split the file into byte-range chunks and download them
  // in parallel (-N 4). This is what gives Clipper its speed.
  if (isSocks) {
    args.push(
      '--hls-prefer-native',
      '--concurrent-fragments', '4',
      '-N', '4',
      '--http-chunk-size', '10M',
    );
    if (jobLog) jobLog.info('🔧 Tunnel mode: parallel chunking (4 connections, 10M chunks)');
  } else {
    args.push(
      '--hls-prefer-native',
      '--concurrent-fragments', '4',
      '-N', '4',
      '--http-chunk-size', '10M',
    );
    if (jobLog) jobLog.info('🔧 Direct mode: parallel chunking (4 connections, 10M chunks)');
  }

  if (fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100) {
    args.push('--cookies', COOKIES_FILE);
    if (jobLog) jobLog.info(`✓ cookies: ${COOKIES_FILE}`);
  } else if (jobLog) {
    jobLog.warn(`⚠ No cookies.txt at ${COOKIES_FILE} — bot detection more likely`);
  }

  if (process.env.YTDLP_PROXY) {
    args.push('--proxy', process.env.YTDLP_PROXY);
    if (jobLog) jobLog.info(`✓ proxy: ${process.env.YTDLP_PROXY.replace(/:[^:@]*@/, ':***@')} (type: ${proxyType})`);
  }

  return args;
}

const STRATEGIES = [
  { name: 'web_embedded', client: 'web_embedded', desc: 'embeddable only, best success rate', maxSec: 150 },
  { name: 'mweb',         client: 'mweb',         desc: 'mobile web',                         maxSec: 300 },
  { name: 'ios',          client: 'ios',          desc: 'iOS client, bypasses most restrictions', maxSec: 120 },
  { name: 'android',      client: 'android',      desc: 'Android client, strong bypass',      maxSec: 120 },
  { name: 'web_safari',   client: 'web_safari',   desc: 'HLS, cookie-friendly',               maxSec: 150 },
  { name: 'tv_simply',    client: 'tv_simply',    desc: 'no PO required',                     maxSec: 60  },
  { name: 'android_vr',   client: 'android_vr',   desc: 'kids-safe fallback',                 maxSec: 60  },
];

function formatForMode(mode) {
  switch (mode) {
    case 'audio':
      return {
        format: 'bestaudio[ext=m4a]/bestaudio',
        mergeFormat: null,
        ext: 'm4a',
        extraArgs: ['-x', '--audio-format', 'm4a', '--audio-quality', '0'],
      };
    case 'video':
      // Prefer single-file progressive mp4 first (≤720p, much faster over
      // SOCKS5 than HLS-fragmented variants like format 298/299/300).
      return {
        format: 'b[height<=720][ext=mp4][protocol*=https]/bv*[height<=720][ext=mp4]/bv*[ext=mp4]/bv*',
        mergeFormat: 'mp4',
        ext: 'mp4',
        extraArgs: ['--download-sections', '*0-inf'],
      };
    case 'video_audio':
    default:
      // CRITICAL FIX (v3.0.1):
      //   Old: 'bv*[ext=mp4]+ba[ext=m4a]/bv*+ba/b[ext=mp4]/b'
      //   New: progressive mp4 FIRST (format 18 = 360p single-file mp4,
      //        format 22 = 720p single-file mp4), HLS merged as fallback.
      //
      // Why: progressive formats serve from ONE googlevideo CDN host with
      // a single HTTPS GET. Merged HLS hops across hosts every 6 s, which
      // breaks under SOCKS5/Xray tunnels with "keepalive request failed"
      // and takes 40-50 s for a 90 s Shorts video. Progressive nails the
      // same job in ~10 s.
      return {
        format:
          'b[height<=720][ext=mp4][protocol*=https]' +     // progressive 360p/720p
          '/bv*[height<=720][ext=mp4]+ba[ext=m4a]' +       // merged ≤720p
          '/bv*+ba' +
          '/b[ext=mp4]/b',
        mergeFormat: 'mp4',
        ext: 'mp4',
        extraArgs: ['--download-sections', '*0-inf'],
      };
  }
}

// Track running child processes per-job so deleteJob can kill them
const RUNNING = new Map();
function trackProc(jobId, proc) {
  if (!RUNNING.has(jobId)) RUNNING.set(jobId, new Set());
  RUNNING.get(jobId).add(proc);
  proc.on('close', () => {
    const set = RUNNING.get(jobId);
    if (set) { set.delete(proc); if (!set.size) RUNNING.delete(jobId); }
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

function runYtdlpOnce(args, jobLog, jobId, maxMs) {
  return new Promise((resolve, reject) => {
    jobLog.info('yt-dlp', args.map(a => a.includes(' ') ? `"${a}"` : a).join(' '));
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let stderrBuf = '', stdoutBuf = '', done = false;
    let killTimer = null;
    if (maxMs) {
      killTimer = setTimeout(() => {
        if (done) return;
        jobLog.warn(`⏱ Strategy timeout (${maxMs/1000}s) — killing yt-dlp`);
        try { proc.kill('SIGKILL'); } catch (_) {}
      }, maxMs);
    }
    proc.stdout.on('data', d => {
      const s = d.toString(); stdoutBuf += s;
      s.split(/\r?\n/).forEach(line => { if (line) jobLog.info(`yt-dlp> ${line}`); });
    });
    proc.stderr.on('data', d => {
      const text = d.toString(); stderrBuf += text;
      text.split(/\r?\n/).forEach(line => {
        if (!line) return;
        if (/WARNING/i.test(line)) jobLog.warn(`yt-dlp> ${line}`);
        else jobLog.error(`yt-dlp> ${line}`);
      });
    });
    proc.on('error', (e) => { done = true; if (killTimer) clearTimeout(killTimer); reject(e); });
    proc.on('close', code => {
      done = true; if (killTimer) clearTimeout(killTimer);
      if (code === 0) resolve({ stdout: stdoutBuf, stderr: stderrBuf });
      else reject(Object.assign(new Error(`yt-dlp exited ${code}`), { code, stderr: stderrBuf }));
    });
  });
}

// Cross-filesystem-safe move: rename(2) fails with EXDEV when src and dst
// live on different mounts (very common on Railway/Docker where /tmp is
// tmpfs and /app/data is a persistent volume). Fall back to copyFile+unlink
// in that case.
function safeMove(src, dst) {
  try {
    fs.renameSync(src, dst);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
  }
  // Cross-device: copy then delete the source.
  fs.copyFileSync(src, dst);
  try { fs.unlinkSync(src); } catch (_) {}
}

function sanitizeFilename(s) {
  return String(s || '')
    .replace(/[\\/:"*?<>|\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractHashtags(description) {
  if (!description) return [];
  const matches = description.match(/#[\p{L}\p{N}\p{M}_\u200C\u200D]+/gu) || [];
  const seen = new Set();
  const out = [];
  for (const tag of matches) {
    const lc = tag.toLowerCase();
    if (!seen.has(lc)) { seen.add(lc); out.push(tag); }
    if (out.length >= 8) break;
  }
  return out;
}

function buildOutputFilename(title, hashtags, ext) {
  const safeTitle = sanitizeFilename(title) || 'video';
  let name = safeTitle;
  if (hashtags && hashtags.length) {
    const tagStr = hashtags.map(t => sanitizeFilename(t)).filter(Boolean).join(' ');
    if (tagStr) name = `${safeTitle} ${tagStr}`;
  }
  if (name.length > 200) name = name.slice(0, 200).trim();
  return `${name}.${ext}`;
}

async function fetchMetadata(url, jobLog, jobId) {
  const args = [
    ...buildCommonArgs(jobLog),
    '--skip-download',
    '--print', '%(.{id,title,description,uploader,duration,ext})j',
    url,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (jobId) trackProc(jobId, proc);
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`metadata fetch failed: ${stderr.slice(-300)}`));
      try {
        const line = stdout.trim().split('\n').find(l => l.trim().startsWith('{'));
        if (!line) return reject(new Error('no metadata JSON in output'));
        resolve(JSON.parse(line));
      } catch (e) { reject(e); }
    });
  });
}

async function downloadOne(url, jobId, jobLog, opts = {}) {
  const mode = ['video_audio', 'audio', 'video'].includes(opts.mode) ? opts.mode : 'video_audio';
  jobLog.info(`[ytdlp=${YTDLP_MODULE_VERSION}] mode=${mode} url=${url}`);

  const workDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let meta = {};
  try {
    meta = await fetchMetadata(url, jobLog, jobId);
    jobLog.info(`📄 title="${(meta.title || '').slice(0, 80)}" | duration=${meta.duration || '?'}s`);
  } catch (e) {
    jobLog.warn(`metadata fetch failed (${e.message}) — will use yt-dlp output template`);
  }

  const fmtSpec = formatForMode(mode);
  const hashtags = extractHashtags(meta.description || '');
  const baseTitle = meta.title || meta.id || 'video';
  const tmpTemplate = path.join(workDir, `dl_%(id)s.%(ext)s`);

  const proxyType  = detectProxyType();
  const errors     = [];

  for (let i = 0; i < STRATEGIES.length; i++) {
    const strategy = STRATEGIES[i];
    jobLog.info(`━━━ Strategy ${i + 1}/${STRATEGIES.length}: ${strategy.name} (${strategy.desc}) ━━━`);

    try {
      for (const f of fs.readdirSync(workDir)) {
        if (f.startsWith('dl_') || f.endsWith('.part') || f.endsWith('.ytdl')) {
          fs.unlinkSync(path.join(workDir, f));
        }
      }
    } catch (_) {}

    const args = [
      ...buildCommonArgs(jobLog),
      '--extractor-args', `youtube:player_client=${strategy.client}`,
      '-f', fmtSpec.format,
      ...(fmtSpec.mergeFormat ? ['--merge-output-format', fmtSpec.mergeFormat] : []),
      ...fmtSpec.extraArgs,
      '-o', tmpTemplate,
      url,
    ];

    const startMs = Date.now();
    let ytdlpError = null;
    try {
      await runYtdlpOnce(args, jobLog, jobId, strategy.maxSec ? strategy.maxSec * 1000 : null);
    } catch (e) {
      // CRITICAL FIX (v3.0.3):
      // Do NOT immediately mark as failed on non-zero exit. yt-dlp returns
      // non-zero in several harmless situations when the actual mp4 IS on
      // disk and complete — the most common being progressive mp4 + the
      // '--merge-output-format mp4' flag triggering a no-op post-processor
      // warning. The log will show:
      //   [download] Download completed
      //   yt-dlp exited 1
      // but /tmp/waz/<jobId>/dl_<id>.mp4 is fully written.
      //
      // The asli (real) success indicator is: does the file exist on disk?
      // The clipper has been using this pattern (check file existence after
      // run, regardless of exit code) all along, which is why the clipper
      // works. We now do the same here.
      ytdlpError = e;
      jobLog.warn(`yt-dlp wrapper returned non-zero (${e.code || '?'}) — checking if output file exists anyway…`);
    }

    // Check for output file regardless of exit code.
    let files = [];
    try {
      files = fs.readdirSync(workDir).filter(f =>
        f.startsWith('dl_') && !f.endsWith('.part') && !f.endsWith('.ytdl')
      );
    } catch (_) {}

    // Pick the largest dl_* file (the merged/final one, not partial fragments)
    let pick = null;
    let pickSize = 0;
    for (const f of files) {
      try {
        const sz = fs.statSync(path.join(workDir, f)).size;
        if (sz > pickSize) { pickSize = sz; pick = f; }
      } catch (_) {}
    }

    // Sanity threshold: anything under 50 KB is almost certainly an aborted/
    // empty placeholder, not a real video.
    const MIN_USABLE_BYTES = 50 * 1024;

    if (pick && pickSize >= MIN_USABLE_BYTES) {
      // SUCCESS path — file is on disk and looks valid, whether yt-dlp's
      // exit code was 0 or not.
      try {
        const tmpPath = path.join(workDir, pick);
        const realExt = path.extname(pick).slice(1) || fmtSpec.ext;

        let finalName = buildOutputFilename(baseTitle, hashtags, realExt);
        let finalPath = path.join(OUTPUT_DIR, finalName);
        let counter = 1;
        while (fs.existsSync(finalPath)) {
          const stem = finalName.replace(new RegExp(`\\.${realExt}$`), '');
          finalName  = `${stem} (${counter}).${realExt}`;
          finalPath  = path.join(OUTPUT_DIR, finalName);
          counter++;
        }
        safeMove(tmpPath, finalPath);

        const elapsed = Date.now() - startMs;
        const sizeMB = (pickSize / (1024 * 1024)).toFixed(2);
        if (ytdlpError) {
          jobLog.info(`✅ "${strategy.name}" SUCCESS in ${(elapsed/1000).toFixed(1)}s (${sizeMB} MB) — file on disk despite yt-dlp exit code ${ytdlpError.code || '?'} → ${finalName}`);
        } else {
          jobLog.info(`✅ "${strategy.name}" SUCCESS in ${(elapsed/1000).toFixed(1)}s (${sizeMB} MB) → ${finalName}`);
        }

        return {
          filePath: finalPath,
          fileName: finalName,
          title:    baseTitle,
          hashtags,
          mode,
          strategy: strategy.name,
          proxyType,
          sizeBytes: pickSize,
          durationMs: elapsed,
        };
      } catch (renameErr) {
        jobLog.error(`Rename failed after successful download: ${renameErr.message}`);
        ytdlpError = ytdlpError || renameErr;
      }
    }

    // Genuine failure path.
    {
      const elapsed = Date.now() - startMs;
      const e = ytdlpError || new Error('finished but no usable output file produced');
      const stderrText = e.stderr || e.message || '';
      const isBotError = /Sign in to confirm|not a bot|requires.*login/i.test(stderrText);
      const isFormatError = /requested format|no video formats|HTTP Error 4\d\d/i.test(stderrText);
      const isJsError = /jsruntime|deno|n.?sig|JSChallenge/i.test(stderrText);
      const reason = isBotError ? 'BOT_DETECTION' : isJsError ? 'JS_CHALLENGE' : isFormatError ? 'FORMAT_UNAVAILABLE' : 'OTHER';
      jobLog.warn(`✗ "${strategy.name}" failed (${reason}) after ${(elapsed/1000).toFixed(1)}s${pick ? ` — file too small (${pickSize} bytes)` : ' — no output file'}`);
      errors.push(`[${strategy.name}] ${(e.message || '').slice(0, 200)}`);
    }
  }

  throw new Error(
    `All ${STRATEGIES.length} strategies failed for ${url}.\n` +
    `Possible fixes: 1) refresh cookies.txt 2) check VMess/proxy validity 3) ensure Deno is installed.\n` +
    `Errors:\n  → ${errors.join('\n  → ')}`
  );
}

module.exports = {
  downloadOne,
  YTDLP_MODULE_VERSION,
  STRATEGIES,
  detectDeno,
  detectProxyType,
  formatForMode,
  extractHashtags,
  buildOutputFilename,
  killJob,
};
