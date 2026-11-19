-- ポストの言語と、翻訳結果の保存。
ALTER TABLE posts ADD COLUMN IF NOT EXISTS language TEXT;
CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  source_text TEXT NOT NULL,
  source_normalized TEXT NOT NULL,
  norm_length INTEGER NOT NULL,
  bigram_count INTEGER NOT NULL DEFAULT 0,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS translations_lookup_idx ON translations (source_hash, target_language);
CREATE INDEX IF NOT EXISTS translations_fuzzy_idx ON translations (target_language, source_language, norm_length);
CREATE TABLE IF NOT EXISTS translation_terms (
  translation_id TEXT NOT NULL REFERENCES translations(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  PRIMARY KEY (translation_id, term)
);
CREATE INDEX IF NOT EXISTS translation_terms_term_idx ON translation_terms (term, translation_id);
