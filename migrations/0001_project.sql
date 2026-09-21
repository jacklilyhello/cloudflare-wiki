CREATE TABLE project_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  database_name TEXT NOT NULL
);

INSERT INTO project_metadata (id, app_id, environment, database_name)
VALUES (1, 'jacklilyhello/cloudflare-wiki', 'test', 'cloudflare-wiki-test');
