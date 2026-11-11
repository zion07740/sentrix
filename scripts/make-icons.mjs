// Renders the Sentrix shield-and-keyhole icon to PNG at several sizes (no dependencies).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

const A = [0x2f, 0xd3, 0xa3] // mint
const B = [0x4f, 0x8c, 0xff] // blue
const HOLE = [0x0b, 0x0e, 0x13]

function inShield(x, y) {
  const dx = Math.abs(x - 0.5)
  if (dx > 0.38) return false
  const top = 0.06 + 0.12 * (dx / 0.38)
  if (y < top) return false
  if (y <= 0.5) return true
  const t = (y - 0.5) / 0.45
  if (t >= 1) return false
  return dx <= 0.38 * Math.sqrt(1 - t * t)
}
function inHole(x, y) {
  const dx = x - 0.5
  if (dx * dx + (y - 0.42) ** 2 <= 0.105 ** 2) return true
  if (y >= 0.45 && y <= 0.7) {
    const hw = 0.045 + (0.085 - 0.045) * ((y - 0.45) / 0.25)
    return Math.abs(dx) <= hw
  }
  return false
}

function render(size) {
  const out = Buffer.alloc(size * size * 4)
  const S = 4
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size
          const y = (py + (sy + 0.5) / S) / size
          if (!inShield(x, y)) continue
          let c
          if (inHole(x, y)) c = HOLE
          else {
            const t = Math.min(1, Math.max(0, (x + y) / 2))
            c = [0, 1, 2].map((i) => B[i] + (A[i] - B[i]) * (1 - t))
          }
          r += c[0]; g += c[1]; b += c[2]; a += 1
        }
      }
      const i = (py * size + px) * 4
      if (a) {
        out[i] = Math.round(r / a)
        out[i + 1] = Math.round(g / a)
        out[i + 2] = Math.round(b / a)
        out[i + 3] = Math.round((a / (S * S)) * 255)
      }
    }
  }
  return png(size, out)
}

const targets = [
  [join(root, 'build', 'icon.png'), 512],
  ...[16, 32, 48, 128].map((s) => [join(root, 'extension', 'icons', `icon-${s}.png`), s])
]
for (const [file, size] of targets) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, render(size))
  console.log(`[icons] ${file} (${size}px)`)
}
