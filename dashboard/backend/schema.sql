-- RS · Mis turnos — esquema SQLite
-- Los passwords se guardan como hash bcrypt (columna password_hash).
-- Las notas/zona de turnos se guardan cifradas con Fernet (columna zona_enc).

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,            -- hash bcrypt, jamás texto plano
  role          TEXT NOT NULL DEFAULT 'driver' CHECK (role IN ('admin','driver')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,       -- sha256 del token (el token viaja en cookie)
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fecha         TEXT NOT NULL,            -- YYYY-MM-DD
  plataforma    TEXT NOT NULL CHECK (plataforma IN ('uber','lyft','ambas')),
  inicio        TEXT NOT NULL,            -- HH:MM
  fin           TEXT NOT NULL,            -- HH:MM
  bruto         REAL NOT NULL,
  millas_pax    REAL NOT NULL,
  millas_muertas REAL NOT NULL,
  bono          REAL NOT NULL DEFAULT 0,
  gas_price     REAL NOT NULL,            -- USD/galón usado en ese turno
  maintenance   REAL NOT NULL DEFAULT 0.10, -- USD/milla usado en ese turno
  zona_enc      TEXT NOT NULL DEFAULT '', -- notas/zona CIFRADAS con Fernet
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shifts_user_fecha ON shifts(user_id, fecha);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
