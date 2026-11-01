CREATE TABLE IF NOT EXISTS group_dm_send_requests (
  dm_id TEXT NOT NULL REFERENCES group_dms(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_message TEXT NOT NULL,
  attempt_token TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (dm_id, sender_id, request_id)
);
