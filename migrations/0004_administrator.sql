CREATE TABLE administrators (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 32),
  password_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL DEFAULT 1 CHECK (auth_version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Only an explicitly authorized Actions bootstrap provisions this hash.
-- Deployments must never reopen a consumed bootstrap or overwrite an administrator.
CREATE TABLE admin_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  admin_id INTEGER NOT NULL DEFAULT 1 CHECK (admin_id = 1) REFERENCES administrators(id),
  auth_version INTEGER NOT NULL CHECK (auth_version >= 1),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  CHECK (expires_at > created_at AND last_seen_at >= created_at)
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TABLE admin_login_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1)
);
CREATE INDEX admin_login_limits_window ON admin_login_limits(window_started_at);

CREATE TRIGGER administrator_credentials_version
BEFORE UPDATE OF username, password_hash ON administrators
WHEN NEW.auth_version != OLD.auth_version + 1
BEGIN
  SELECT RAISE(ABORT, 'administrator_version_required');
END;

CREATE TRIGGER administrator_revoke_sessions
AFTER UPDATE OF auth_version ON administrators
BEGIN
  DELETE FROM admin_sessions WHERE admin_id = NEW.id;
END;
