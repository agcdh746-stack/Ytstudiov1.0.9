'use strict';

function toSeconds(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  const parts = String(str).trim().split(':').map(Number);
  if (parts.some(isNaN)) throw new Error(`Invalid timestamp: ${str}`);
  let s = 0;
  if (parts.length === 3) s = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) s = parts[0] * 60 + parts[1];
  else s = parts[0];
  return s;
}

function parseRange(range) {
  const [a, b] = String(range).split('-').map(s => s && s.trim());
  if (!a || !b) throw new Error(`Invalid range: ${range}`);
  const start = toSeconds(a);
  const end = toSeconds(b);
  if (end <= start) throw new Error(`End must be > start: ${range}`);
  return { start, end, duration: end - start };
}

function ffTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(3);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.padStart(6, '0')}`;
}

module.exports = { toSeconds, parseRange, ffTime };
