-- HAJAS Perfumes - orders database (Cloudflare D1 / SQLite)
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT UNIQUE,                         -- HJ-00001 ...
  client_ref   TEXT UNIQUE,                         -- stops double submits (customer taps twice / retries)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),   -- UTC
  status       TEXT NOT NULL DEFAULT 'new',         -- new | confirmed | shipped | delivered | cancelled
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,                       -- normalised 07XXXXXXXXX
  city         TEXT NOT NULL,                       -- province / governorate
  landmark     TEXT NOT NULL,                       -- nearest landmark
  address      TEXT NOT NULL,                       -- street, house, apartment
  notes        TEXT,
  items_json   TEXT NOT NULL,                       -- [{id,name,brand,size,price,qty}]
  total        INTEGER NOT NULL,                    -- recomputed on the server (IQD)
  lang         TEXT,
  ip_hash      TEXT,                                -- salted hash, only used for rate limiting
  notified     INTEGER NOT NULL DEFAULT 0,          -- 1 once the Telegram message went out
  notify_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_ip      ON orders (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_notify  ON orders (notified, created_at);
