CREATE TABLE IF NOT EXISTS upload_sessions (
  session_id TEXT PRIMARY KEY,
  upload_id TEXT,
  object_key TEXT NOT NULL UNIQUE,
  uid TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  term_id TEXT NOT NULL,
  title_ar TEXT NOT NULL DEFAULT '',
  title_en TEXT NOT NULL DEFAULT '',
  file_name TEXT NOT NULL,
  extension TEXT NOT NULL,
  type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  part_size_bytes INTEGER NOT NULL,
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 10000),
  status TEXT NOT NULL CHECK(status IN ('uploading', 'complete', 'aborted', 'rejected', 'deleting', 'deleted')),
  linked INTEGER NOT NULL DEFAULT 0 CHECK(linked IN (0, 1)),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK(is_published IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS upload_sessions_uid_status_idx ON upload_sessions(uid, status, linked, created_at);
CREATE INDEX IF NOT EXISTS upload_sessions_lesson_idx ON upload_sessions(lesson_id, status, is_published);

CREATE TABLE IF NOT EXISTS api_rate_limits (
  uid TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK(request_count > 0)
);
