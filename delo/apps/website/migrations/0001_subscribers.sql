-- Sign-ups for Delorun release news. Tokens are stored as SHA-256 hashes, never as sent.
CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT,
  consent_at TEXT NOT NULL,
  consent_page TEXT NOT NULL,
  consent_text_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unsubscribed')),
  confirm_token_hash TEXT NOT NULL,
  unsubscribe_token_hash TEXT NOT NULL,
  confirmed_at TEXT,
  confirmation_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX subscribers_confirm_token ON subscribers (confirm_token_hash);
CREATE UNIQUE INDEX subscribers_unsubscribe_token ON subscribers (unsubscribe_token_hash);
CREATE INDEX subscribers_status_consent ON subscribers (status, consent_at);
