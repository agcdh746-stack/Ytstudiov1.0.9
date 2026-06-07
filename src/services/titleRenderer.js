'use strict';

// =====================================================================
// Waz Title pre-renderer (Emoji Original Color Fixed)
// =====================================================================

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const FONT_DIR = path.join(__dirname, '..', 'public', 'fonts');

const PY_RENDERER = `
import sys, json, unicodedata
from PIL import Image, ImageDraw, ImageFont

try:
    cfg = json.loads(sys.argv[1])
except Exception as e:
    sys.exit(1)

# 1. 0-Pixel Safety Guard
W = max(1, int(cfg.get('width', 1280) or 1280))
H = max(1, int(cfg.get('height', 720) or 720))
out_path = cfg['out']
bg = tuple(cfg.get('bg', [0,0,0,0]))

# 2. Empty Text Guard
text = cfg.get('text', '').strip()
if not text:
    Image.new('RGBA', (W, H), bg).save(out_path)
    print('OK EMPTY', (W, H))
    sys.exit(0)

font_path = cfg['font_path']
emoji_font_path = cfg.get('emoji_font_path', None)
fg = tuple(cfg.get('fg', [255,255,255,255]))
shadow = cfg.get('shadow', None)
target_font_size = max(1, int(cfg.get('font_size', 50) or 50))
min_font_size = max(1, int(cfg.get('min_font_size', 18) or 18))
align = cfg.get('align', 'center')
padding_x = int(cfg.get('padding_x', 30))
padding_y = int(cfg.get('padding_y', 20))
max_lines = int(cfg.get('max_lines', 5))
line_height_ratio = float(cfg.get('line_height_ratio', 1.30))

try:
    layout = ImageFont.Layout.RAQM
except AttributeError:
    layout = ImageFont.LAYOUT_RAQM if hasattr(ImageFont, 'LAYOUT_RAQM') else ImageFont.LAYOUT_BASIC

def is_emoji(ch):
    try:
        cat = unicodedata.category(ch)
        cp = ord(ch)
        return cat in ('So', 'Sm') or (0x1F000 <= cp <= 0x1FFFF) or (0x2600 <= cp <= 0x27BF) or cp in (0xFE0F, 0x200D)
    except:
        return False

def get_chunks(text):
    chunks = []
    i = 0
    while i < len(text):
        if is_emoji(text[i]):
            seq = text[i]
            j = i + 1
            while j < len(text) and (is_emoji(text[j]) or text[j] in ('\uFE0F', '\u200D')):
                seq += text[j]
                j += 1
            chunks.append((seq, True))
        else:
            seq = ""
            j = i
            while j < len(text) and not is_emoji(text[j]):
                seq += text[j]
                j += 1
            chunks.append((seq, False))
        i = j
    return chunks

def get_mixed_text_width(text, main_font, emoji_font, current_size, draw):
    w_total = 0
    for seq, is_em in get_chunks(text):
        if is_em and emoji_font:
            bb = draw.textbbox((0, 0), seq, font=emoji_font)
            em_w = max(1, bb[2] - bb[0])
            w_total += int(em_w * (current_size / 109.0))
        else:
            bb = draw.textbbox((0, 0), seq, font=main_font)
            w_total += bb[2] - bb[0]
    return w_total

def wrap_by_pixel(words, font, em_font, current_size, max_w, draw):
    lines = []
    cur = []
    for w in words:
        candidate = ' '.join(cur + [w])
        if get_mixed_text_width(candidate, font, em_font, current_size, draw) <= max_w or not cur:
            cur.append(w)
        else:
            lines.append(' '.join(cur))
            cur = [w]
    if cur:
        lines.append(' '.join(cur))
    return lines

def measure(font_size):
    try:
        font = ImageFont.truetype(font_path, font_size, layout_engine=layout)
    except:
        font = ImageFont.load_default()
        
    em_font = None
    if emoji_font_path:
        try:
            em_font = ImageFont.truetype(emoji_font_path, 109)
        except:
            pass
            
    tmp = Image.new('RGBA', (10, 10))
    draw = ImageDraw.Draw(tmp)
    max_w = max(10, W - 2 * padding_x)
    lines = wrap_by_pixel(text.split(), font, em_font, font_size, max_w, draw)
    line_h = int(font_size * line_height_ratio)
    total_h = line_h * len(lines)
    max_line_w = 0
    max_descent = 0
    for ln in lines:
        max_line_w = max(max_line_w, get_mixed_text_width(ln, font, em_font, font_size, draw))
        bb = draw.textbbox((0, 0), ln, font=font)
        max_descent = max(max_descent, bb[3])
    return font, em_font, lines, line_h, total_h + max_descent // 4, max_line_w

font_size = target_font_size
final = None
while font_size >= min_font_size:
    font, em_font, lines, line_h, total_h, max_line_w = measure(font_size)
    if total_h <= H - 2 * padding_y and max_line_w <= W - 2 * padding_x and len(lines) <= max_lines:
        final = (font, em_font, lines, line_h, total_h, font_size)
        break
    font_size -= 1

if not final:
    final = measure(min_font_size)[:5] + (min_font_size,)

font, emoji_font, lines, line_h, total_h, used_size = final
img = Image.new('RGBA', (W, H), bg)
draw = ImageDraw.Draw(img)
y_start = max(padding_y, (H - total_h) // 2)

for i, ln in enumerate(lines):
    lw = get_mixed_text_width(ln, font, emoji_font, used_size, draw)
    ref_bb = draw.textbbox((0, 0), ln, font=font)
    
    if align == 'center':
        cx = (W - lw) // 2 - ref_bb[0]
    elif align == 'right':
        cx = W - lw - padding_x - ref_bb[0]
    else:
        cx = padding_x - ref_bb[0]
        
    y = y_start + i * line_h - ref_bb[1]

    for seq, is_em in get_chunks(ln):
        if is_em and emoji_font:
            em_bb = draw.textbbox((0, 0), seq, font=emoji_font)
            em_w, em_h = max(1, em_bb[2] - em_bb[0]), max(1, em_bb[3] - em_bb[1])
            pad = 20
            tmp_img = Image.new('RGBA', (em_w + pad*2, em_h + pad*2), (0,0,0,0))
            
            # --- মেইন ফিক্স: embedded_color=True ব্যবহার করা হয়েছে ইমোজির আসল কালার রাখতে ---
            try:
                ImageDraw.Draw(tmp_img).text((pad - em_bb[0], pad - em_bb[1]), seq, font=emoji_font, embedded_color=True)
            except TypeError:
                ImageDraw.Draw(tmp_img).text((pad - em_bb[0], pad - em_bb[1]), seq, font=emoji_font, fill=(255,255,255,255))
            
            target_w, target_h = max(1, int(em_w * (used_size / 109.0))), max(1, int(em_h * (used_size / 109.0)))
            target_pad = max(1, int(pad * (used_size / 109.0)))
            
            resized_em = tmp_img.resize((target_w + target_pad*2, target_h + target_pad*2), Image.Resampling.LANCZOS)
            img.alpha_composite(resized_em, (cx - target_pad, y + int(used_size * 0.08) - target_pad))
            cx += target_w
        else:
            if shadow:
                sr, sg, sb, sa, sox, soy = shadow
                draw.text((cx + sox, y + soy), seq, font=font, fill=(sr, sg, sb, sa))
            draw.text((cx, y), seq, font=font, fill=fg)
            cx += draw.textbbox((0, 0), seq, font=font)[2] - draw.textbbox((0, 0), seq, font=font)[0]

img.save(out_path)
print('OK', img.size)
`;

function pickFont(weight = 'bold') {
  const candidates = weight === 'bold' ? [
    path.join(FONT_DIR, 'HindSiliguri-Bold.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Bold.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Bold.ttf',
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
  ] : [
    path.join(FONT_DIR, 'HindSiliguri-Regular.ttf'),
    path.join(FONT_DIR, 'NotoSansBengali-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansBengali-Regular.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('No Bengali font available');
}

function pickEmojiFont() {
  const candidates = [
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/noto/NotoColorEmoji.ttf',
    '/usr/share/fonts/truetype/NotoColorEmoji.ttf',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function renderTitlePng(opts) {
  const safeWidth = Math.max(1, Math.round(Number(opts.width) || 1280));
  const safeHeight = Math.max(1, Math.round(Number(opts.height) || 720));
  const safeFontSize = Math.max(1, Math.round(Number(opts.fontSize) || 50));

  const {
    text, outPath,
    fg = [255, 255, 255, 255],
    bg = [0, 0, 0, 0],
    shadow = null,
    fontWeight = 'bold',
    minFontSize = 18,
    maxLines = 5,
    paddingX = 30,
    paddingY = 20,
    lineHeightRatio = 1.30,
  } = opts;

  const cfg = {
    width: safeWidth, height: safeHeight,
    font_size: safeFontSize,
    min_font_size: Math.max(1, Number(minFontSize) || 18),
    font_path: pickFont(fontWeight),
    emoji_font_path: pickEmojiFont(),
    text: typeof text === 'string' ? text : ' ',
    fg, bg, shadow,
    out: outPath,
    align: 'center',
    padding_x: paddingX,
    padding_y: paddingY,
    max_lines: maxLines,
    line_height_ratio: lineHeightRatio,
  };

  const r = spawnSync('python3', ['-c', PY_RENDERER, JSON.stringify(cfg)], {
    encoding: 'utf8',
  });

  if (r.status !== 0) {
    throw new Error(`Waz Title render failed: ${r.stderr || r.stdout || 'python3 exited ' + r.status}`);
  }
  if (!fs.existsSync(outPath)) {
    throw new Error('Waz Title render: output PNG not created');
  }
  return outPath;
}

// =====================================================================
// Pro Title Background PNG generator (Style C)
// - Halftone dots
// - Top-to-bottom gradient (#FFE033 -> #e6b800)
// - Left accent strip (5px black)
// - Top shiny highlight (white fade)
// =====================================================================
const PY_HALFTONE = `
import sys, json
from PIL import Image, ImageDraw

cfg = json.loads(sys.argv[1])
W = int(cfg['width'])
H = int(cfg['height'])
out = cfg['out']
spacing = int(cfg.get('spacing', 6))
radius = float(cfg.get('radius', 1.0))
accent_w = int(cfg.get('accent_w', 5))

# Gradient: #FFE033 top -> #e6b800 bottom
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

for y in range(H):
    t = y / max(H - 1, 1)
    r = int(255 + (230 - 255) * t)
    g = int(224 + (184 - 224) * t)
    b = int(51  + (0   - 51)  * t)
    draw.line([(0, y), (W, y)], fill=(r, g, b, 255))

# Halftone dots (skip accent zone)
dot_fill = (
    int(255 * 0.82),
    int(197 * 0.82),
    int(24  * 0.82),
    255
)
cx = accent_w + spacing // 2
while cx < W:
    cy = spacing // 2
    while cy < H:
        draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=dot_fill)
        cy += spacing
    cx += spacing

# Left accent strip (black)
draw.rectangle([0, 0, accent_w - 1, H - 1], fill=(17, 17, 17, 255))

# Top shiny highlight (white fade, upper 35%)
highlight_h = int(H * 0.35)
for y in range(highlight_h):
    alpha = int(50 * (1 - y / highlight_h))
    draw.line([(accent_w, y), (W, y)], fill=(255, 255, 255, alpha))

img.save(out)
print('OK', img.size)
`;

function renderHalftoneBg({ width, height, outPath, spacing = 6, radius = 1.0, accentW = 5 }) {
  const cfg = { width, height, out: outPath, spacing, radius, accent_w: accentW };
  const r = require('child_process').spawnSync('python3', ['-c', PY_HALFTONE, JSON.stringify(cfg)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`HalftoneBg render failed: ${r.stderr || r.stdout}`);
  if (!require('fs').existsSync(outPath)) throw new Error('HalftoneBg: output PNG not created');
  return outPath;
}

module.exports = { renderTitlePng, renderHalftoneBg, pickFont, pickEmojiFont };
