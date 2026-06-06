'use strict';

// =====================================================================
// Download statistics tracker
// Records: which strategy succeeded, which proxy/cookies/POT were used,
// counts per service, success/failure reasons.
// Persisted to /app/data/stats.json
// =====================================================================

const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

const STATS_FILE = process.env.STATS_FILE || '/app/data/stats.json';

const EMPTY = () => ({
  total_attempts: 0,
  total_success: 0,
  total_failed: 0,
  by_strategy: {},        // { 'web_safari': {success: 5, fail: 1}, ... }
  by_proxy_type: {},      // { 'vmess': {success:3, fail:0}, 'socks5':..., 'direct':... }
  by_cookies: { with: 0, without: 0 },
  by_pot: { with: 0, without: 0 },
  recent: [],             // last 50 entries
  first_seen: Date.now(),
  last_seen: Date.now(),
});

let _statsCache = null;
let _statsMtime = 0;

function load() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const st = fs.statSync(STATS_FILE);
      if (_statsCache && st.mtimeMs <= _statsMtime) return _statsCache;
      _statsCache = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      _statsMtime = st.mtimeMs;
      return _statsCache;
    }
  } catch (e) { logger.warn('stats load failed:', e.message); }
  return EMPTY();
}

function save(s) {
  try {
    fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(s, null, 2));
    _statsCache = s;
    _statsMtime = Date.now();
  } catch (e) { logger.warn('stats save failed:', e.message); }
}

function bump(obj, key, field) {
  obj[key] = obj[key] || { success: 0, fail: 0 };
  obj[key][field] = (obj[key][field] || 0) + 1;
}

/**
 * Record a download attempt.
 *
 * @param {object} entry
 *   {
 *     url:       'https://youtu.be/...',
 *     success:   true | false,
 *     strategy:  'web_safari' | 'tv_simply' | ...,
 *     proxyType: 'vmess' | 'vless' | 'trojan' | 'shadowsocks' | 'socks5' | 'direct' | null,
 *     hasCookies:boolean,
 *     hasPOT:    boolean,
 *     duration_ms: number,
 *     error:     string?,
 *   }
 */
function record(entry) {
  const s = load();
  s.total_attempts++;
  if (entry.success) s.total_success++; else s.total_failed++;

  if (entry.strategy) bump(s.by_strategy, entry.strategy, entry.success ? 'success' : 'fail');
  bump(s.by_proxy_type, entry.proxyType || 'direct', entry.success ? 'success' : 'fail');
  s.by_cookies[entry.hasCookies ? 'with' : 'without']++;
  s.by_pot[entry.hasPOT ? 'with' : 'without']++;

  s.recent.unshift({
    ts:        Date.now(),
    url:       (entry.url || '').slice(0, 80),
    success:   !!entry.success,
    strategy:  entry.strategy || null,
    proxyType: entry.proxyType || 'direct',
    hasCookies: !!entry.hasCookies,
    hasPOT:    !!entry.hasPOT,
    duration_ms: entry.duration_ms || 0,
    error:     entry.error ? String(entry.error).slice(0, 200) : null,
  });
  s.recent = s.recent.slice(0, 50);
  s.last_seen = Date.now();
  save(s);
  return s;
}

function getStats() { return load(); }

function reset() {
  save(EMPTY());
  return EMPTY();
}

module.exports = { record, getStats, reset };
