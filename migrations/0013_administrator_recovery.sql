-- Only the owner-controlled Actions workflow assigns this field. There is no
-- Worker HTTP writer for it, and ordinary deployments never perform recovery.
ALTER TABLE administrators ADD COLUMN recovery_request_hash TEXT
  CHECK(recovery_request_hash IS NULL OR (length(recovery_request_hash)=64 AND recovery_request_hash NOT GLOB '*[^0-9a-f]*'));

CREATE TABLE administrator_recoveries (
  request_hash TEXT PRIMARY KEY NOT NULL CHECK(length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  administrator_id INTEGER NOT NULL CHECK(administrator_id=1) REFERENCES administrators(id),
  previous_version INTEGER NOT NULL,
  credential_version INTEGER NOT NULL CHECK(credential_version=previous_version+1),
  used_at INTEGER NOT NULL
);
CREATE TRIGGER administrator_recovery_guard BEFORE UPDATE OF recovery_request_hash ON administrators
WHEN NEW.recovery_request_hash IS NOT OLD.recovery_request_hash
BEGIN
  SELECT RAISE(ABORT,'recovery_invalid') WHERE NEW.recovery_request_hash IS NULL
    OR NEW.username IS NOT OLD.username OR NEW.password_hash IS OLD.password_hash
    OR NEW.auth_version<>OLD.auth_version+1;
END;
CREATE TRIGGER administrator_recovery_record AFTER UPDATE OF recovery_request_hash ON administrators
WHEN NEW.recovery_request_hash IS NOT OLD.recovery_request_hash
BEGIN
  INSERT INTO administrator_recoveries(request_hash,administrator_id,previous_version,credential_version,used_at)
  VALUES(NEW.recovery_request_hash,NEW.id,OLD.auth_version,NEW.auth_version,NEW.updated_at);
  DELETE FROM admin_login_limits;
END;
CREATE TRIGGER administrator_recoveries_no_update BEFORE UPDATE ON administrator_recoveries
BEGIN
  SELECT RAISE(ABORT,'recovery_immutable');
END;
CREATE TRIGGER administrator_recoveries_no_delete BEFORE DELETE ON administrator_recoveries
BEGIN
  SELECT RAISE(ABORT,'recovery_immutable');
END;
