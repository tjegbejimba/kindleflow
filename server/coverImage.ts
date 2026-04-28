import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

interface CoverInput {
  title: string;
  sourceUrl?: string;
}

const WIDTH = 900;
const HEIGHT = 1200;
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["10010", "10010", "10010", "11111", "00010", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "&": ["01000", "10100", "10100", "01000", "10101", "10010", "01101"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

export function generateCoverPng(input: CoverInput): Buffer {
  const hash = createHash("sha256").update(`${input.title}|${input.sourceUrl ?? ""}`).digest();
  const hue = hash[0] / 255;
  const accent = hslToRgb(hue, 0.62, 0.32);
  const backgroundA = hslToRgb((hue + 0.08) % 1, 0.45, 0.22);
  const backgroundB = hslToRgb((hue + 0.58) % 1, 0.5, 0.12);
  const pixels = new Uint8Array((WIDTH * 4 + 1) * HEIGHT);

  for (let y = 0; y < HEIGHT; y += 1) {
    const rowOffset = y * (WIDTH * 4 + 1);
    pixels[rowOffset] = 0;
    const verticalMix = y / (HEIGHT - 1);
    for (let x = 0; x < WIDTH; x += 1) {
      const radial = Math.hypot((x - WIDTH * 0.15) / WIDTH, (y - HEIGHT * 0.15) / HEIGHT);
      const mix = Math.min(1, verticalMix * 0.72 + radial * 0.42);
      const color = mixRgb(backgroundA, backgroundB, mix);
      setPixel(pixels, x, y, color[0], color[1], color[2], 255);
    }
  }

  const paper = [248, 241, 229] as const;
  const ink = [29, 26, 23] as const;
  drawRect(pixels, 78, 86, 744, 1028, 255, 250, 243, 232);
  drawRect(pixels, 110, 118, 680, 8, accent[0], accent[1], accent[2], 255);
  drawText(pixels, "KINDLEFLOW", 112, 162, 6, accent);
  drawText(pixels, "KF", 112, 250, 18, ink);

  const titleLines = wrapTitle(input.title, 18, 6);
  let titleY = 510;
  for (const line of titleLines) {
    drawText(pixels, line, 112, titleY, 8, ink);
    titleY += 78;
  }

  drawRect(pixels, 112, 958, 320, 5, accent[0], accent[1], accent[2], 255);
  const source = sourceLabel(input.sourceUrl);
  drawText(pixels, source, 112, 990, 5, [86, 75, 64]);

  for (let i = 0; i < 5; i += 1) {
    const lineWidth = 360 + ((hash[i + 1] % 180) - 90);
    drawRect(pixels, 112, 398 + i * 22, lineWidth, 8, paper[0] - 18, paper[1] - 18, paper[2] - 18, 255);
  }

  return encodePng(WIDTH, HEIGHT, pixels);
}

function drawText(
  pixels: Uint8Array,
  text: string,
  x: number,
  y: number,
  scale: number,
  color: readonly [number, number, number]
): void {
  let cursor = x;
  for (const char of normalizeCoverText(text)) {
    const glyph = FONT[char] ?? FONT[" "];
    for (let gy = 0; gy < glyph.length; gy += 1) {
      for (let gx = 0; gx < glyph[gy].length; gx += 1) {
        if (glyph[gy][gx] === "1") {
          drawRect(pixels, cursor + gx * scale, y + gy * scale, scale, scale, color[0], color[1], color[2], 255);
        }
      }
    }
    cursor += 6 * scale;
  }
}

function drawRect(
  pixels: Uint8Array,
  x: number,
  y: number,
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number
): void {
  const startX = Math.max(0, x);
  const startY = Math.max(0, y);
  const endX = Math.min(WIDTH, x + width);
  const endY = Math.min(HEIGHT, y + height);
  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      setPixel(pixels, px, py, r, g, b, a);
    }
  }
}

function setPixel(pixels: Uint8Array, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const offset = y * (WIDTH * 4 + 1) + 1 + x * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

function encodePng(width: number, height: number, raw: Uint8Array): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND")]);
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hueToRgb = (p: number, q: number, tInput: number) => {
    let t = tInput;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hueToRgb(p, q, h + 1 / 3) * 255),
    Math.round(hueToRgb(p, q, h) * 255),
    Math.round(hueToRgb(p, q, h - 1 / 3) * 255)
  ];
}

function mixRgb(a: readonly [number, number, number], b: readonly [number, number, number], amount: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * amount),
    Math.round(a[1] + (b[1] - a[1]) * amount),
    Math.round(a[2] + (b[2] - a[2]) * amount)
  ];
}

function wrapTitle(title: string, maxLineLength: number, maxLines: number): string[] {
  const words = normalizeCoverText(title)
    .split(/\s+/)
    .filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLineLength) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    current = word.slice(0, maxLineLength);
    if (lines.length === maxLines - 1) {
      break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, Math.max(0, maxLineLength - 1))}?`;
  }
  return lines.length ? lines : ["UNTITLED", "ARTICLE"];
}

function normalizeCoverText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9&\-.:?!/ ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceLabel(sourceUrl: string | undefined): string {
  if (!sourceUrl) {
    return "SAVED ARTICLE";
  }
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./, "").toUpperCase().slice(0, 24);
  } catch {
    return "SAVED ARTICLE";
  }
}
