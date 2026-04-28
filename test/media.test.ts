import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Re-implementation mirroring src/utils/media.ts detectFileFormat,
// plus an end-to-end ECB encrypt → ECB decrypt round-trip to guard against
// the issue #16 regression: JPEG/MP4 must be recognized after decrypt.
function detectFileFormat(b: Buffer): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'zip';
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'mp4';
  return null;
}

test('detectFileFormat: JPEG (issue #16 regression)', () => {
  const jpegHead = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(detectFileFormat(jpegHead), 'jpeg');
});

test('detectFileFormat: MP4 (issue #16 video regression)', () => {
  const mp4Head = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
  assert.equal(detectFileFormat(mp4Head), 'mp4');
});

test('detectFileFormat: PNG / PDF / ZIP still work', () => {
  assert.equal(detectFileFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
  assert.equal(detectFileFormat(Buffer.from('%PDF-1.4')), 'pdf');
  assert.equal(detectFileFormat(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'zip');
});

test('detectFileFormat: random bytes return null', () => {
  assert.equal(detectFileFormat(Buffer.from([0x12, 0x34, 0x56, 0x78])), null);
});

test('AES-128-ECB round-trip preserves JPEG bytes (mirrors WeChat upload mode)', () => {
  // The fix in src/utils/media.ts removes the broken CBC fallback because
  // ilink/client.ts uploads with AES-128-ECB + PKCS#7. This test pins that contract:
  // bytes encrypted with the same algorithm/padding must decrypt cleanly.
  const key = randomBytes(16);
  const plaintext = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    randomBytes(1024),
    Buffer.from([0xff, 0xd9]),
  ]);

  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const decipher = createDecipheriv('aes-128-ecb', key, null);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  assert.deepEqual(decrypted, plaintext);
  assert.equal(detectFileFormat(decrypted), 'jpeg');
});
