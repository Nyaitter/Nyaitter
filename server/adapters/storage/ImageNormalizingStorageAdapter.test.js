const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sharp = require('sharp');
const LocalStorageAdapter = require('./local/LocalStorageAdapter');
const ImageNormalizingStorageAdapter = require('./ImageNormalizingStorageAdapter');

test('ラッパーは正規化済みWebPのみをローカルストレージへ保存する', async () => {
  const uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nyaitter-image-upload-'));
  try {
    const input = await sharp({
      create: {
        width: 1600,
        height: 1200,
        channels: 3,
        background: { r: 30, g: 100, b: 180 },
      },
    })
      .withMetadata({ exif: { IFD0: { Artist: 'private photographer' } } })
      .jpeg({ quality: 95 })
      .toBuffer();

    const storage = new ImageNormalizingStorageAdapter(
      new LocalStorageAdapter({ uploadDir }),
      {
        maxWidth: 800,
        maxHeight: 800,
        maxPixels: 10_000_000,
        maxOutputSizeMB: 5,
        webpQuality: 82,
        minWebpQuality: 60,
      },
    );

    const stored = await storage.upload({
      file: input,
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
      folder: 'attachments/1',
    });
    const saved = await fs.readFile(path.join(uploadDir, ...stored.id.split('/')));
    const metadata = await sharp(saved).metadata();

    assert.match(stored.id, /\.webp$/);
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 800);
    assert.equal(metadata.height, 600);
    assert.equal(metadata.exif, undefined);
  } finally {
    await fs.rm(uploadDir, { recursive: true, force: true });
  }
});
