const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const StorageAdapter = require('../StorageAdapter');
const {
  getSafeExtension,
  normalizeFolder,
  normalizeStorageKey,
} = require('../safeStoragePath');

class LocalStorageAdapter extends StorageAdapter {
  constructor(options = {}) {
    super();
    this.uploadDir = path.resolve(options.uploadDir || './uploads');
  }

  async _ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
  }

  _resolveStorageKey(key) {
    const normalizedKey = normalizeStorageKey(key);
    const resolvedPath = path.resolve(this.uploadDir, ...normalizedKey.split('/'));
    const rootPrefix = `${this.uploadDir}${path.sep}`;

    if (!resolvedPath.startsWith(rootPrefix)) {
      throw new Error('Storage key resolves outside upload directory');
    }

    return { normalizedKey, resolvedPath };
  }

  async upload(params) {
    const { file, fileName, contentType, folder = 'attachments' } = params;
    const normalizedFolder = normalizeFolder(folder);
    const id = crypto.randomBytes(16).toString('hex');
    const ext = getSafeExtension(fileName, contentType);
    const finalFileName = `${id}${ext}`;
    const storageKey = `${normalizedFolder}/${finalFileName}`;
    const { normalizedKey, resolvedPath } = this._resolveStorageKey(storageKey);

    await this._ensureDir(path.dirname(resolvedPath));

    if (Buffer.isBuffer(file)) {
      await fs.writeFile(resolvedPath, file, { flag: 'wx' });
    } else {
      const chunks = [];
      for await (const chunk of file) {
        chunks.push(chunk);
      }
      await fs.writeFile(resolvedPath, Buffer.concat(chunks), { flag: 'wx' });
    }

    return {
      id: normalizedKey,
      url: `/uploads/${normalizedKey}`,
      key: normalizedKey,
    };
  }

  async delete(fileId) {
    const { resolvedPath } = this._resolveStorageKey(fileId);
    try {
      await fs.unlink(resolvedPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async getPublicUrl(fileId) {
    const { normalizedKey } = this._resolveStorageKey(fileId);
    return `/uploads/${normalizedKey}`;
  }

  async deleteMany(fileIds) {
    await Promise.all(fileIds.map((id) => this.delete(id)));
  }
}

module.exports = LocalStorageAdapter;
