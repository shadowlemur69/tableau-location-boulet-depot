// =====================================================
// Tableau de Location - Serveur partage multi-utilisateurs
// Stockage : SQLite (data.db) persistant
// Sync temps reel : Server-Sent Events (SSE)
// =====================================================
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const raw = require('node:fs').readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) {}
}
loadEnv();

// ---------- CONSTANTES DE VALIDATION ----------
const LIMITS = {
  name: 120,
  category: 80,
  code: 40,
  client: 120,
  phone: 40,
  note: 500
};
const VALID_COLORS = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'];
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2099-12-31';

// ---------- BASE DE DONNEES ----------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS equipment (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    code TEXT,
    created_at INTEGER NOT NULL,
    sort_order INTEGER DEFAULT 0,
    archived_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS rentals (
    id TEXT PRIMARY KEY,
    equipment_id TEXT NOT NULL,
    equipment_name_snapshot TEXT,
    client TEXT NOT NULL,
    phone TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    note TEXT,
    color TEXT DEFAULT 'yellow',
    returned_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_rentals_equipment ON rentals(equipment_id);
  CREATE INDEX IF NOT EXISTS idx_rentals_dates ON rentals(start_date, end_date);
`);

// Migrations légères (colonnes ajoutées après coup)
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === col)) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`); } catch (e) { /* ignore */ }
  }
}
ensureColumn('equipment', 'archived_at', 'archived_at INTEGER');
ensureColumn('rentals', 'equipment_name_snapshot', 'equipment_name_snapshot TEXT');
ensureColumn('rentals', 'updated_at', 'updated_at INTEGER NOT NULL DEFAULT 0');
ensureColumn('rentals', 'version', 'version INTEGER NOT NULL DEFAULT 1');

// ---------- HELPERS ----------
function uid() { return crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }

function cleanStr(v, maxLen) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, maxLen);
}

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: '256kb' }));

// ---------- AUTHENTIFICATION ----------
const AUTH_USER = (process.env.TABLEAU_USER || 'equipe').trim();
const AUTH_PASSWORD = (process.env.TABLEAU_PASSWORD || '').trim();
const SESSION_SECRET = (process.env.TABLEAU_SESSION_SECRET || AUTH_PASSWORD || 'tableau-dev-insecure').trim();
const AUTH_ENABLED = AUTH_PASSWORD.length > 0;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return [part.trim(), ''];
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      try { return [key, decodeURIComponent(val)]; } catch { return [key, val]; }
    })
  );
}

function signSession(user) {
  const payload = JSON.stringify({ user, exp: Date.now() + SESSION_MAX_AGE_MS });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!data?.user || !data?.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function setSessionCookie(res, user) {
  const token = signSession(user);
  const parts = [
    `tableau_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = ['tableau_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function isPublicPath(pathname) {
  if (pathname === '/login.html' || pathname === '/api/health') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/assets/')) return true;
  return false;
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED || isPublicPath(req.path)) return next();
  const session = verifySession(parseCookies(req).tableau_session);
  if (session) {
    req.tableauUser = session.user;
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'auth_required', message: 'Connexion requise.' });
  }
  return res.redirect('/login.html');
}

app.post('/api/auth/login', (req, res) => {
  if (!AUTH_ENABLED) {
    setSessionCookie(res, AUTH_USER);
    return res.json({ ok: true, user: AUTH_USER });
  }
  const user = cleanStr(req.body?.user, 80);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (user === AUTH_USER && password === AUTH_PASSWORD) {
    setSessionCookie(res, user);
    return res.json({ ok: true, user });
  }
  return res.status(401).json({ error: 'Identifiants incorrects.' });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/session', (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true, user: AUTH_USER, auth: false });
  const session = verifySession(parseCookies(req).tableau_session);
  if (!session) return res.status(401).json({ ok: false });
  return res.json({ ok: true, user: session.user, auth: true });
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- SSE (Server-Sent Events) pour sync temps reel ----------
const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  sseClients.add(res);

  const keepAlive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

// ---------- API : EQUIPEMENT ----------
function isValidISODate(s) {
  if (typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (s < MIN_DATE || s > MAX_DATE) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// Vérifie s'il existe déjà une location qui chevauche pour ce même équipement
// (retournées sont ignorées ; sur update, on exclut la location elle-même)
function findConflict(equipmentId, startDate, endDate, excludeRentalId = null) {
  const q = `
    SELECT * FROM rentals
    WHERE equipment_id = ?
      AND returned_at IS NULL
      AND date(start_date) <= date(?)
      AND date(end_date) >= date(?)
      ${excludeRentalId ? 'AND id != ?' : ''}
    LIMIT 1
  `;
  const params = excludeRentalId
    ? [equipmentId, endDate, startDate, excludeRentalId]
    : [equipmentId, endDate, startDate];
  return db.prepare(q).get(...params);
}

app.get('/api/equipment', (req, res) => {
  const includeArchived = req.query.include_archived === '1';
  const q = includeArchived
    ? 'SELECT * FROM equipment ORDER BY sort_order ASC, created_at ASC'
    : 'SELECT * FROM equipment WHERE archived_at IS NULL ORDER BY sort_order ASC, created_at ASC';
  res.json(db.prepare(q).all());
});

app.post('/api/equipment', (req, res) => {
  const name = cleanStr(req.body?.name, LIMITS.name);
  if (!name) return res.status(400).json({ error: 'Le nom de l\'équipement est requis.' });
  const category = cleanStr(req.body?.category, LIMITS.category);
  const code = cleanStr(req.body?.code, LIMITS.code);

  // Détection de doublon (même nom, non archivé, insensible à la casse)
  const dup = db.prepare(
    `SELECT id FROM equipment WHERE archived_at IS NULL AND LOWER(name) = LOWER(?)`
  ).get(name);
  if (dup) return res.status(409).json({ error: `Un équipement nommé "${name}" existe déjà.` });

  const row = { id: uid(), name, category, code, created_at: now(), sort_order: 0, archived_at: null };
  db.prepare(`INSERT INTO equipment (id, name, category, code, created_at, sort_order, archived_at)
              VALUES (@id, @name, @category, @code, @created_at, @sort_order, @archived_at)`).run(row);
  broadcast('equipment:changed', { action: 'created', item: row });
  res.json(row);
});

app.put('/api/equipment/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Équipement introuvable.' });

  const name = req.body?.name !== undefined ? cleanStr(req.body.name, LIMITS.name) : existing.name;
  if (!name) return res.status(400).json({ error: 'Le nom de l\'équipement est requis.' });

  // Doublon (autre équipement, non archivé)
  const dup = db.prepare(
    `SELECT id FROM equipment WHERE archived_at IS NULL AND LOWER(name) = LOWER(?) AND id != ?`
  ).get(name, id);
  if (dup) return res.status(409).json({ error: `Un équipement nommé "${name}" existe déjà.` });

  const category = req.body?.category !== undefined ? cleanStr(req.body.category, LIMITS.category) : existing.category;
  const code = req.body?.code !== undefined ? cleanStr(req.body.code, LIMITS.code) : existing.code;

  db.prepare(`UPDATE equipment SET name=?, category=?, code=? WHERE id=?`).run(name, category, code, id);
  const updated = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  broadcast('equipment:changed', { action: 'updated', item: updated });
  res.json(updated);
});

// Archivage (soft delete) : conserve l'historique intact.
// Refuse si des locations non-retournées existent (sauf si ?force=1).
app.delete('/api/equipment/:id', (req, res) => {
  const { id } = req.params;
  const force = req.query.force === '1';
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Équipement introuvable.' });

  const activeCount = db.prepare(
    `SELECT COUNT(*) as c FROM rentals WHERE equipment_id = ? AND returned_at IS NULL`
  ).get(id).c;

  if (activeCount > 0 && !force) {
    return res.status(409).json({
      error: 'active_rentals',
      message: `Impossible d'archiver : ${activeCount} location(s) en cours pour cet équipement.`,
      active_count: activeCount
    });
  }

  // Sauvegarder le nom dans les rentals existantes (snapshot) pour l'historique
  db.prepare(
    `UPDATE rentals SET equipment_name_snapshot = COALESCE(equipment_name_snapshot, ?) WHERE equipment_id = ?`
  ).run(existing.name, id);

  db.prepare('UPDATE equipment SET archived_at = ? WHERE id = ?').run(now(), id);
  const archived = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  broadcast('equipment:changed', { action: 'archived', item: archived });
  res.json({ ok: true, archived: true });
});

// Restauration
app.post('/api/equipment/:id/restore', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Équipement introuvable.' });

  // Doublon éventuel
  const dup = db.prepare(
    `SELECT id FROM equipment WHERE archived_at IS NULL AND LOWER(name) = LOWER(?) AND id != ?`
  ).get(existing.name, id);
  if (dup) return res.status(409).json({ error: `Un équipement nommé "${existing.name}" existe déjà. Renommez avant de restaurer.` });

  db.prepare('UPDATE equipment SET archived_at = NULL WHERE id = ?').run(id);
  const restored = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  broadcast('equipment:changed', { action: 'restored', item: restored });
  res.json(restored);
});

// ---------- API : LOCATIONS ----------
app.get('/api/rentals', (req, res) => {
  const rows = db.prepare('SELECT * FROM rentals ORDER BY start_date ASC, created_at ASC').all();
  res.json(rows);
});

// Vérification préalable de conflit (utilisé par le frontend avant soumission)
app.get('/api/rentals/check-conflict', (req, res) => {
  const { equipment_id, start_date, end_date, exclude_id } = req.query;
  if (!equipment_id || !isValidISODate(start_date) || !isValidISODate(end_date)) {
    return res.status(400).json({ error: 'Paramètres invalides.' });
  }
  if (end_date < start_date) return res.status(400).json({ error: 'Dates invalides.' });
  const conflict = findConflict(equipment_id, start_date, end_date, exclude_id || null);
  res.json({ conflict: conflict || null });
});

function validateRentalPayload(body, { forCreate }) {
  const errors = [];
  const client = cleanStr(body?.client, LIMITS.client);
  if (!client) errors.push('Le nom du client est requis.');
  const start_date = body?.start_date;
  const end_date = body?.end_date;
  if (!isValidISODate(start_date)) errors.push('Date de début invalide.');
  if (!isValidISODate(end_date)) errors.push('Date de retour invalide.');
  if (isValidISODate(start_date) && isValidISODate(end_date) && end_date < start_date) {
    errors.push('La date de retour doit être identique ou après la date de début.');
  }
  const phone = cleanStr(body?.phone, LIMITS.phone);
  const note = cleanStr(body?.note, LIMITS.note);
  let color = body?.color || 'yellow';
  if (!VALID_COLORS.includes(color)) color = 'yellow';
  if (forCreate && !body?.equipment_id) errors.push('Équipement requis.');
  return { errors, clean: { client, phone, note, color, start_date, end_date } };
}

app.post('/api/rentals', (req, res) => {
  const { errors, clean } = validateRentalPayload(req.body, { forCreate: true });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const equipment_id = req.body.equipment_id;
  const eq = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipment_id);
  if (!eq) return res.status(404).json({ error: 'Équipement introuvable.' });
  if (eq.archived_at) return res.status(400).json({ error: 'Cet équipement est archivé. Restaurez-le d\'abord.' });

  // Conflit de réservation
  const conflict = findConflict(equipment_id, clean.start_date, clean.end_date);
  if (conflict && req.query.force !== '1') {
    return res.status(409).json({
      error: 'conflict',
      message: `Conflit : "${eq.name}" est déjà loué à ${conflict.client} du ${conflict.start_date} au ${conflict.end_date}.`,
      conflict
    });
  }

  const ts = now();
  const row = {
    id: uid(),
    equipment_id,
    equipment_name_snapshot: eq.name,
    client: clean.client,
    phone: clean.phone,
    start_date: clean.start_date,
    end_date: clean.end_date,
    note: clean.note,
    color: clean.color,
    returned_at: null,
    created_at: ts,
    updated_at: ts,
    version: 1
  };
  db.prepare(`INSERT INTO rentals
    (id, equipment_id, equipment_name_snapshot, client, phone, start_date, end_date, note, color, returned_at, created_at, updated_at, version)
    VALUES (@id, @equipment_id, @equipment_name_snapshot, @client, @phone, @start_date, @end_date, @note, @color, @returned_at, @created_at, @updated_at, @version)`
  ).run(row);
  broadcast('rentals:changed', { action: 'created', item: row });
  res.json(row);
});

app.put('/api/rentals/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Location introuvable.' });

  // Concurrence : le client envoie la version qu'il a vu
  const clientVersion = req.body?.version;
  if (clientVersion !== undefined && clientVersion !== existing.version) {
    return res.status(409).json({
      error: 'version_mismatch',
      message: 'Un autre utilisateur a modifié cette location entre-temps. Actualisez pour voir les changements.',
      current: existing
    });
  }

  const { errors, clean } = validateRentalPayload(
    { ...existing, ...req.body },
    { forCreate: false }
  );
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  // Vérif conflit (exclut la location elle-même)
  const conflict = findConflict(existing.equipment_id, clean.start_date, clean.end_date, id);
  if (conflict && req.query.force !== '1') {
    return res.status(409).json({
      error: 'conflict',
      message: `Conflit avec la location de ${conflict.client} (${conflict.start_date} → ${conflict.end_date}).`,
      conflict
    });
  }

  const returned_at = req.body?.returned_at !== undefined ? req.body.returned_at : existing.returned_at;
  const ts = now();
  db.prepare(`UPDATE rentals SET client=?, phone=?, start_date=?, end_date=?, note=?, color=?, returned_at=?, updated_at=?, version=version+1 WHERE id=?`)
    .run(clean.client, clean.phone, clean.start_date, clean.end_date, clean.note, clean.color, returned_at, ts, id);
  const updated = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  broadcast('rentals:changed', { action: 'updated', item: updated });
  res.json(updated);
});

app.post('/api/rentals/:id/return', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Location introuvable.' });
  if (existing.returned_at) return res.json(existing); // idempotent
  const ts = now();
  db.prepare('UPDATE rentals SET returned_at = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(ts, ts, id);
  const updated = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  broadcast('rentals:changed', { action: 'updated', item: updated });
  res.json(updated);
});

// Ré-ouvrir une location retournée (annuler un retour marqué par erreur)
app.post('/api/rentals/:id/unreturn', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Location introuvable.' });
  const ts = now();
  db.prepare('UPDATE rentals SET returned_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?').run(ts, id);
  const updated = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  broadcast('rentals:changed', { action: 'updated', item: updated });
  res.json(updated);
});

app.delete('/api/rentals/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Location introuvable.' });
  db.prepare('DELETE FROM rentals WHERE id = ?').run(id);
  broadcast('rentals:changed', { action: 'deleted', id });
  res.json({ ok: true });
});

// ---------- HEALTH ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// ---------- ERREURS ----------
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Requête trop volumineuse.' });
  }
  res.status(500).json({ error: 'Erreur serveur.' });
});

// ---------- LANCEMENT ----------
function localLanUrl() {
  try {
    const nets = require('node:os').networkInterfaces();
    for (const entries of Object.values(nets)) {
      for (const net of entries || []) {
        if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${PORT}`;
      }
    }
  } catch (_) {}
  return null;
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tableau de Location prêt sur le port ${PORT}`);
  console.log(`  Local    → http://localhost:${PORT}`);
  const lan = localLanUrl();
  if (lan) console.log(`  Réseau   → ${lan}  (collègues sur le même Wi-Fi)`);
  if (AUTH_ENABLED) {
    console.log(`  Connexion — utilisateur : ${AUTH_USER}`);
  } else {
    console.log('  ⚠ TABLEAU_PASSWORD non défini — accès ouvert (définir dans .env)');
  }
});
