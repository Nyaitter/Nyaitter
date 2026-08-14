class StorageAdapter {
  /**
   * ファイルをアップロードする
   * @param {Object} params
   * @param {Buffer|ReadableStream} params.file - ファイル本体
   * @param {string} params.fileName - 保存時のファイル名（ID含む）
   * @param {string} params.contentType - MIMEタイプ
   * @param {string} [params.folder] - フォルダ（例: "attachments", "icons"）
   * @returns {Promise<{id: string, url: string}>} - 保存されたファイルのIDと公開URL
   */
  async upload(params) {
    throw new Error('upload() must be implemented');
  }

  /**
   * ファイルを削除する
   * @param {string} fileId - upload時に返したID
   * @returns {Promise<void>}
   */
  async delete(fileId) {
    throw new Error('delete() must be implemented');
  }

  /**
   * 公開URLを取得する
   * @param {string} fileId
   * @returns {Promise<string>}
   */
  async getPublicUrl(fileId) {
    throw new Error('getPublicUrl() must be implemented');
  }

  /**
   * 複数ファイルを一括削除
   * @param {string[]} fileIds
   * @returns {Promise<void>}
   */
  async deleteMany(fileIds) {
    throw new Error('deleteMany() must be implemented');
  }
}

module.exports = StorageAdapter;
