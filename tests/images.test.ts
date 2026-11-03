import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { storeUpload } from '../server/images.ts';

/** A plain grey PNG of this size, as a phone might upload one. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits, greyscale
  const row = Buffer.alloc(width + 1, 0x80);
  row[0] = 0; // no filter
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

/** A JPEG's size, read from its frame header. */
function jpegSize(b: Buffer): { width: number; height: number } {
  assert.equal(b.readUInt16BE(0), 0xffd8, 'a JPEG');
  for (let i = 2; i + 9 < b.length; i += 2 + b.readUInt16BE(i + 2)) {
    const marker = b.readUInt16BE(i);
    if (marker >= 0xffc0 && marker <= 0xffc3) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
  }
  throw new Error('no frame header');
}

test('an uploaded poster is kept as a JPEG at most 1170 px on its longer side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'posters-'));
  const file = await storeUpload(dir, 'p1', png(1600, 2400));
  assert.deepEqual(jpegSize(readFileSync(file)), { width: 780, height: 1170 });
});
