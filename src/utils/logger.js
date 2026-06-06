'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || '/app/data/logs';
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}

const LOG_FILE = path.join(LOG_DIR, 'app.log');

const RING_SIZE = 500;
const ring = [];
const subscribers = new Set();

function broadcast(entry) {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  for (const sub of subscribers) {
    try { sub(entry); } catch (_) {}
  }
}

function fmt(level, args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => {
    if (a instanceof Error) return `${a.message}\n${a.stack}`;
    if (typeof a === 'object') return JSON.stringify(a);
    return String(a);
  }).join(' ');
  return { ts, level, msg, line: `[${ts}] [${level}] ${msg}` };
}

function write(level, ...args) {
  const e = fmt(level, args);
  if (level === 'error') console.error(e.line);
  else console.log(e.line);
  try { fs.appendFileSync(LOG_FILE, e.line + '\n'); } catch (_) {}
  broadcast(e);
}

const logger = {
  info:  (...a) => write('info', ...a),
  warn:  (...a) => write('warn', ...a),
  error: (...a) => write('error', ...a),
  debug: (...a) => write('debug', ...a),
  forJob(jobId) {
    const tag = `[job:${jobId}]`;
    return {
      info:  (...a) => write('info',  tag, ...a),
      warn:  (...a) => write('warn',  tag, ...a),
      error: (...a) => write('error', tag, ...a),
      debug: (...a) => write('debug', tag, ...a),
    };
  },
  recent(n = 200) { return ring.slice(-n); },
  subscribe(fn)   { subscribers.add(fn); return () => subscribers.delete(fn); },
};

module.exports = { logger };
