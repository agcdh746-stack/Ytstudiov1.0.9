'use strict';

// =====================================================================
// Xray-core integration for VMess/VLESS/Trojan/Shadowsocks tunneling
//
// Flow:
//   1. User saves VMess/VLESS link in Config tab → /app/data/config.json
//   2. On startup (and on save) we decode link → generate xray config.json
//   3. Spawn `xray run` as child process listening on socks5://127.0.0.1:10808
//   4. Set process.env.YTDLP_PROXY = socks5://127.0.0.1:10808
//   5. yt-dlp uses this proxy automatically
//
// Supported link formats:
//   - vmess://BASE64(JSON)
//   - vless://UUID@host:port?params
//   - trojan://password@host:port?params
//   - ss://BASE64(method:pass)@host:port
//   - socks5://user:pass@host:port (passthrough — no Xray needed)
// =====================================================================

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { logger } = require('../utils/logger');

const XRAY_BIN     = process.env.XRAY_BIN     || '/usr/local/bin/xray';
const XRAY_CONFIG  = process.env.XRAY_CONFIG  || '/app/data/xray-config.json';
const SOCKS_PORT   = parseInt(process.env.XRAY_SOCKS_PORT || '10808', 10);
const HTTP_PORT    = parseInt(process.env.XRAY_HTTP_PORT  || '10809', 10);
const LOCAL_PROXY  = `socks5://127.0.0.1:${SOCKS_PORT}`;

let xrayProc = null;

function isXrayInstalled() {
  return fs.existsSync(XRAY_BIN);
}

// ---------- Link decoders ----------
function decodeVmess(link) {
  // vmess://BASE64(JSON)
  const b64 = link.replace(/^vmess:\/\//i, '').trim();
  let json;
  try {
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('VMess link decode failed: invalid base64/JSON');
  }
  // Standard vmess JSON fields: v, ps, add, port, id, aid, net, type, host, path, tls
  return {
    type: 'vmess',
    address:    json.add,
    port:       parseInt(json.port, 10),
    uuid:       json.id,
    alterId:    parseInt(json.aid || '0', 10),
    network:    json.net || 'tcp',
    security:   json.tls === 'tls' ? 'tls' : 'none',
    host:       json.host || json.add,
    path:       json.path || '/',
    sni:        json.sni || json.host || json.add,
    type_field: json.type || 'none',
    ps:         json.ps || 'vmess-server',
  };
}

function decodeVless(link) {
  // vless://UUID@host:port?type=ws&security=tls&sni=...&path=...&host=...
  const m = link.match(/^vless:\/\/([^@]+)@([^:/?]+):(\d+)(\?[^#]*)?/i);
  if (!m) throw new Error('VLESS link parse failed');
  const [, uuid, host, port, qs] = m;
  const params = new URLSearchParams((qs || '').replace(/^\?/, ''));
  return {
    type: 'vless',
    address:  host,
    port:     parseInt(port, 10),
    uuid,
    network:  params.get('type') || 'tcp',
    security: params.get('security') || 'none',
    host:     params.get('host') || host,
    path:     params.get('path') || '/',
    sni:      params.get('sni') || host,
    flow:     params.get('flow') || '',
  };
}

function decodeTrojan(link) {
  // trojan://password@host:port?security=tls&sni=...
  const m = link.match(/^trojan:\/\/([^@]+)@([^:/?]+):(\d+)(\?[^#]*)?/i);
  if (!m) throw new Error('Trojan link parse failed');
  const [, password, host, port, qs] = m;
  const params = new URLSearchParams((qs || '').replace(/^\?/, ''));
  return {
    type: 'trojan',
    address:  host,
    port:     parseInt(port, 10),
    password,
    network:  params.get('type') || 'tcp',
    sni:      params.get('sni') || host,
    host:     params.get('host') || host,
    path:     params.get('path') || '/',
  };
}

function decodeSs(link) {
  // ss://BASE64(method:pass)@host:port
  // OR ss://method:pass@host:port (legacy)
  let s = link.replace(/^ss:\/\//i, '');
  if (!s.includes('@')) {
    s = Buffer.from(s, 'base64').toString('utf8');
  } else {
    const [methodPassB64, hostPort] = s.split('@');
    try {
      const decoded = Buffer.from(methodPassB64, 'base64').toString('utf8');
      if (decoded.includes(':')) s = `${decoded}@${hostPort}`;
    } catch (_) {}
  }
  const m = s.match(/^([^:]+):([^@]+)@([^:/?]+):(\d+)/);
  if (!m) throw new Error('Shadowsocks link parse failed');
  const [, method, password, host, port] = m;
  return {
    type: 'shadowsocks',
    address: host,
    port: parseInt(port, 10),
    method,
    password,
  };
}

function decodeLink(link) {
  link = String(link || '').trim();
  if (!link) throw new Error('empty link');
  if (/^vmess:\/\//i.test(link))   return decodeVmess(link);
  if (/^vless:\/\//i.test(link))   return decodeVless(link);
  if (/^trojan:\/\//i.test(link))  return decodeTrojan(link);
  if (/^ss:\/\//i.test(link))      return decodeSs(link);
  if (/^socks5?:\/\//i.test(link)) return { type: 'passthrough', url: link };
  throw new Error('Unsupported link scheme. Use vmess://, vless://, trojan://, ss://, or socks5://');
}

// ---------- Xray config builder ----------
function buildXrayConfig(decoded) {
  // Build outbound based on type
  let outbound;
  if (decoded.type === 'vmess') {
    outbound = {
      tag: 'proxy',
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: decoded.address,
          port:    decoded.port,
          users: [{
            id:      decoded.uuid,
            alterId: decoded.alterId || 0,
            security: 'auto',
          }],
        }],
      },
      streamSettings: buildStreamSettings(decoded),
    };
  } else if (decoded.type === 'vless') {
    outbound = {
      tag: 'proxy',
      protocol: 'vless',
      settings: {
        vnext: [{
          address: decoded.address,
          port:    decoded.port,
          users: [{
            id:         decoded.uuid,
            encryption: 'none',
            flow:       decoded.flow || '',
          }],
        }],
      },
      streamSettings: buildStreamSettings(decoded),
    };
  } else if (decoded.type === 'trojan') {
    outbound = {
      tag: 'proxy',
      protocol: 'trojan',
      settings: {
        servers: [{
          address:  decoded.address,
          port:     decoded.port,
          password: decoded.password,
        }],
      },
      streamSettings: buildStreamSettings({ ...decoded, security: 'tls' }),
    };
  } else if (decoded.type === 'shadowsocks') {
    outbound = {
      tag: 'proxy',
      protocol: 'shadowsocks',
      settings: {
        servers: [{
          address:  decoded.address,
          port:     decoded.port,
          method:   decoded.method,
          password: decoded.password,
        }],
      },
    };
  }

  return {
    log: { loglevel: 'warning' },
    inbounds: [{
      tag: 'socks-in',
      listen:   '127.0.0.1',
      port:     SOCKS_PORT,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true },
    }, {
      tag: 'http-in',
      listen:   '127.0.0.1',
      port:     HTTP_PORT,
      protocol: 'http',
      settings: { allowTransparent: false },
    }],
    outbounds: [
      outbound,
      { tag: 'direct',  protocol: 'freedom', settings: {} },
      { tag: 'blocked', protocol: 'blackhole', settings: {} },
    ],
  };
}

function buildStreamSettings(d) {
  const ss = { network: d.network || 'tcp' };
  if (d.security === 'tls') {
    ss.security = 'tls';
    ss.tlsSettings = { serverName: d.sni || d.host || d.address, allowInsecure: false };
  }
  if (d.network === 'ws') {
    ss.wsSettings = { path: d.path || '/', headers: { Host: d.host || d.address } };
  } else if (d.network === 'grpc') {
    ss.grpcSettings = { serviceName: d.path || '' };
  } else if (d.network === 'h2') {
    ss.httpSettings = { host: [d.host || d.address], path: d.path || '/' };
  }
  return ss;
}

// ---------- Process management ----------
function stopXray() {
  if (xrayProc) {
    try { xrayProc.kill('SIGTERM'); } catch (_) {}
    xrayProc = null;
    logger.info('🛑 Xray stopped');
  }
}

function startXray() {
  if (!isXrayInstalled()) {
    logger.warn(`⚠ xray binary not found at ${XRAY_BIN} — VMess/VLESS support disabled`);
    return false;
  }
  stopXray();

  const link = process.env.VMESS_LINK || process.env.PROXY_LINK || '';
  if (!link) {
    logger.info('   xray  : ✗ no VMESS_LINK set');
    return false;
  }

  try {
    const decoded = decodeLink(link);
    if (decoded.type === 'passthrough') {
      // Direct socks5 — just set as YTDLP_PROXY
      process.env.YTDLP_PROXY = decoded.url;
      logger.info(`✓ Using direct proxy (no xray): ${decoded.url.replace(/:[^:@]*@/, ':***@')}`);
      return true;
    }

    const cfg = buildXrayConfig(decoded);
    fs.mkdirSync(path.dirname(XRAY_CONFIG), { recursive: true });
    fs.writeFileSync(XRAY_CONFIG, JSON.stringify(cfg, null, 2));

    xrayProc = spawn(XRAY_BIN, ['run', '-c', XRAY_CONFIG], { stdio: ['ignore', 'pipe', 'pipe'] });
    xrayProc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && logger.info(`xray> ${l}`)));
    xrayProc.stderr.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && logger.warn(`xray> ${l}`)));
    xrayProc.on('exit', (code) => {
      logger.warn(`xray exited with code ${code}`);
      xrayProc = null;
    });

    // Set local SOCKS5 as the yt-dlp proxy
    process.env.YTDLP_PROXY = LOCAL_PROXY;
    process.env.FFMPEG_HTTP_PROXY = `http://127.0.0.1:${HTTP_PORT}`;
    logger.info(`✓ Xray started: ${decoded.type} → ${decoded.address}:${decoded.port} → SOCKS5 ${LOCAL_PROXY}`);
    return true;
  } catch (e) {
    logger.error('Xray start failed:', e.message);
    return false;
  }
}

async function testXrayProxy() {
  if (!process.env.YTDLP_PROXY) return { ok: false, error: 'no proxy active' };
  return new Promise((resolve) => {
    const start = Date.now();
    const proc = spawn('curl', [
      '-x', process.env.YTDLP_PROXY,
      '-s', '--max-time', '15',
      '-o', '/dev/null',
      '-w', '%{http_code}',
      'https://api.ipify.org'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => {
      const latency = Date.now() - start;
      if (code === 0 && out.startsWith('2')) {
        // Get IP separately
        try {
          const ip = execSync(`curl -x "${process.env.YTDLP_PROXY}" -s --max-time 10 https://api.ipify.org`).toString().trim();
          resolve({ ok: true, ip, latency_ms: latency });
        } catch (_) {
          resolve({ ok: true, ip: 'unknown', latency_ms: latency });
        }
      } else {
        resolve({ ok: false, error: err.trim() || `curl exit ${code}`, latency_ms: latency });
      }
    });
    proc.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

module.exports = {
  startXray, stopXray, testXrayProxy, decodeLink,
  isXrayInstalled, LOCAL_PROXY, SOCKS_PORT,
};
