'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R2StorageAdapter = require('../server/adapters/storage/r2/R2StorageAdapter');

test('R2StorageAdapter works with mocked S3 client', async () => {
  const store = new Map();
  const mockS3Client = {
    send: async (command) => {
      const name = command.constructor.name;
      if (name === 'PutObjectCommand') {
        store.set(command.input.Key, {
          body: command.input.Body,
          contentType: command.input.ContentType,
          metadata: command.input.Metadata,
        });
        return {};
      }
      if (name === 'GetObjectCommand') {
        const item = store.get(command.input.Key);
        if (!item) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToByteArray: async () => Buffer.from(item.body),
          },
          ContentType: item.contentType,
        };
      }
      if (name === 'CopyObjectCommand') {
        const srcKey = command.input.CopySource.replace(/^[^/]+\//, '');
        const item = store.get(srcKey);
        if (!item) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        store.set(command.input.Key, { ...item });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        store.delete(command.input.Key);
        return {};
      }
      if (name === 'DeleteObjectsCommand') {
        for (const obj of command.input.Delete.Objects) {
          store.delete(obj.Key);
        }
        return { Deleted: command.input.Delete.Objects };
      }
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = [];
        for (const [k, v] of store.entries()) {
          if (k.startsWith(prefix)) {
            contents.push({
              Key: k,
              Size: Buffer.byteLength(v.body),
              LastModified: new Date(),
            });
          }
        }
        return { Contents: contents };
      }
      throw new Error(`Unknown command ${name}`);
    },
  };

  const r2 = new R2StorageAdapter({
    bucket: 'test-bucket',
    publicUrl: 'https://cdn.example.com',
  });
  r2.client = mockS3Client;

  // 1. upload
  const uploadRes = await r2.upload({
    file: Buffer.from('r2 content'),
    fileName: 'hello.txt',
    contentType: 'text/plain',
    folder: 'attachments',
  });
  assert.ok(uploadRes.id);
  assert.ok(uploadRes.url.startsWith('https://cdn.example.com/'));

  // 2. read
  const readRes = await r2.read(uploadRes.id);
  assert.equal(readRes.buffer.toString('utf-8'), 'r2 content');

  // 3. copy
  const copyRes = await r2.copy(uploadRes.id, 'attachments/copied.txt');
  assert.ok(copyRes.id);

  // 4. listFiles
  const list = await r2.listFiles('attachments');
  assert.equal(list.length, 2);

  // 5. usage
  const usage = await r2.getUsage('attachments');
  assert.ok(usage > 0);

  // 6. delete
  await r2.delete(uploadRes.id);
  await r2.delete(copyRes.id);
  assert.equal(store.size, 0);
});
