-- Community Notes Phase 1 (D1 / SQLite)
-- SQLite の ALTER TABLE ADD COLUMN には IF NOT EXISTS が無いため、このファイルの
-- 列追加は適用管理（wrangler の d1_migrations）による一度きりの適用が前提。
ALTER TABLE users ADD COLUMN note_rank INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN note_affirmative_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN note_max_per_day INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN note_min_public_threshold INTEGER NOT NULL DEFAULT 0;

ALTER TABLE posts ADD COLUMN recommendation_penalty REAL NOT NULL DEFAULT 0.0;

CREATE TABLE IF NOT EXISTS community_notes (
    id INTEGER PRIMARY KEY,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'limited',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_community_notes_post_id ON community_notes(post_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_user_id ON community_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_community_notes_status ON community_notes(status);

CREATE TABLE IF NOT EXISTS note_ratings (
    note_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    helpful INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id),
    FOREIGN KEY (note_id) REFERENCES community_notes(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_ratings_note_id ON note_ratings(note_id);
CREATE INDEX IF NOT EXISTS idx_note_ratings_user_id ON note_ratings(user_id);

CREATE TABLE IF NOT EXISTS note_reason_tag_defs (
    code TEXT PRIMARY KEY,
    side TEXT NOT NULL,
    label_ja TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1
);

INSERT INTO note_reason_tag_defs (code, side, label_ja, description, sort_order, enabled) VALUES
  ('false_info', 'create', '虚偽の情報', '事実と異なる内容が含まれている', 10, TRUE),
  ('one_sided', 'create', '一方的な意見', '偏った立場のみを述べている', 20, TRUE),
  ('plagiarism', 'create', '無許可でのコンテンツ複製', '他者のコンテンツを無断で転載している', 30, TRUE),
  ('outdated', 'create', '情報が古い', '現在の状況と異なる古い情報である', 40, TRUE),
  ('misleading', 'create', '誤解を招く', '誤解を招く表現が含まれている', 50, TRUE),
  ('missing_context', 'create', '文脈不足', '判断に必要な文脈が欠けている', 60, TRUE),
  ('sensational', 'create', '誇張・煽り', '誇張や煽り表現が含まれている', 70, TRUE),
  ('no_personal_opinion', 'positive', '個人的な意見や憶測が含まれない', '事実のみで構成されている', 10, TRUE),
  ('clear', 'positive', 'わかりやすい', '簡潔で理解しやすい', 20, TRUE),
  ('reliable_source', 'positive', 'ソースの信頼性が高い', '信頼できる情報源を参照している', 30, TRUE),
  ('well_explained', 'positive', '説明が十分', '十分な説明がなされている', 40, TRUE),
  ('neutral_tone', 'positive', '中立的な表現', '中立的な表現で書かれている', 50, TRUE),
  ('credible_source', 'positive', '出典が明確', '出典が明確に示されている', 60, TRUE),
  ('personal_opinion_or_speculation', 'negative', '個人的な意見か憶測が含まれる', '意見や憶測が含まれている', 10, TRUE),
  ('unreliable_source', 'negative', '信頼できないソース', '信頼性の低い情報源を参照している', 20, TRUE),
  ('missing_source', 'negative', 'ソースがない', '情報源が示されていない', 30, TRUE),
  ('unclear', 'negative', 'わかりにくい', '表現が分かりにくい', 40, TRUE),
  ('biased', 'negative', '偏っている', '特定の立場に偏っている', 50, TRUE),
  ('outdated_source', 'negative', '出典が古い', '古い情報源を参照している', 60, TRUE),
  ('off_topic', 'negative', '主題から外れている', '投稿の主題と関係がない', 70, TRUE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS note_reason_tags (
    note_id INTEGER NOT NULL,
    side TEXT NOT NULL,
    code TEXT NOT NULL,
    PRIMARY KEY (note_id, side, code),
    FOREIGN KEY (note_id) REFERENCES community_notes(id) ON DELETE CASCADE,
    FOREIGN KEY (code) REFERENCES note_reason_tag_defs(code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_reason_tags_note_id ON note_reason_tags(note_id);
