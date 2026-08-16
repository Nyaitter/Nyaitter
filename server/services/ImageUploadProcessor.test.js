const assert = require('node:assert/strict');
const test = require('node:test');
const sharp = require('sharp');
const {
  ImageUploadError,
  normalizeImageUpload,
} = require('./ImageUploadProcessor');

test('JPEGをEXIFなしのWebPへ変換し、アスペクト比を保って縮小する', async () => {
  const input = await sharp({
    create: {
      width: 3000,
      height: 2000,
      channels: 3,
      background: { r: 220, g: 80, b: 40 },
    },
  })
    .withMetadata({ exif: { IFD0: { Artist: 'private photographer' } } })
    .jpeg({ quality: 95 })
    .toBuffer();

  const result = await normalizeImageUpload({
    file: input,
    fileName: 'holiday-photo.jpg',
    contentType: 'image/jpeg',
  }, {
    maxWidth: 1000,
    maxHeight: 1000,
    maxPixels: 10_000_000,
    maxOutputSizeMB: 5,
    webpQuality: 82,
    minWebpQuality: 60,
  });

  const metadata = await sharp(result.file).metadata();
  assert.equal(result.contentType, 'image/webp');
  assert.equal(result.fileName, 'holiday-photo.webp');
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1000);
  assert.equal(metadata.height, 667);
  assert.equal(metadata.exif, undefined);
  assert.ok(result.file.length <= 5 * 1024 * 1024);
});

test('画像以外の添付は変更しない', async () => {
  const file = Buffer.from('plain attachment');
  const params = {
    file,
    fileName: 'memo.txt',
    contentType: 'text/plain',
  };

  const result = await normalizeImageUpload(params);
  assert.equal(result, params);
});

test('5 MBを超える画像入力は処理前に拒否する', async () => {
  const oversized = Buffer.alloc((5 * 1024 * 1024) + 1);

  await assert.rejects(
    () => normalizeImageUpload({
      file: oversized,
      fileName: 'oversized.jpg',
      contentType: 'image/jpeg',
    }),
    (error) => error instanceof ImageUploadError && error.statusCode === 413,
  );
});
