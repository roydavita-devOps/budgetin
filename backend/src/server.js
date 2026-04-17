import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { query } from './db.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || 'development_secret';
const botInternalToken = process.env.BOT_INTERNAL_TOKEN || 'budgetin_internal_dev_token';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const adminPhoneNumber = normalizePhone(process.env.ADMIN_PHONE_NUMBER || '081390195600');

const CATEGORY_DEFINITIONS = {
  expense: [
    { code: 'food_drink', label: 'Makan & Minum', aliases: ['food', 'drink', 'makan', 'minum', 'makan & minum', 'makan minum', 'kopi', 'snack'] },
    { code: 'transport', label: 'Transportasi', aliases: ['kendaraan', 'transport', 'transportasi', 'transpot', 'bensin', 'parkir', 'tol', 'ojek'] },
    { code: 'other_expense', label: 'Lain-Lain', aliases: ['lain', 'lain-lain', 'lain lain', 'lainnya', 'other', 'misc'] },
  ],
  income: [
    { code: 'salary', label: 'Gaji Pokok', aliases: ['gaji', 'salary', 'gaji pokok'] },
    { code: 'freelance', label: 'Freelance', aliases: ['freelance', 'project', 'sampingan'] },
  ],
};

const CATEGORY_OPTIONS = Object.values(CATEGORY_DEFINITIONS).flat();
const CATEGORY_LABELS = Object.fromEntries(CATEGORY_OPTIONS.map((category) => [category.code, category.label]));

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') || '*' }));
app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (error) => console.error('Redis error:', error.message));
redis.connect().catch((error) => console.error('Redis connect failed:', error.message));

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      phone_number: user.phone_number,
      display_name: user.display_name,
      is_admin: user.is_admin,
      is_verified: user.is_verified,
      is_blocked: user.is_blocked,
      is_deleted: user.is_deleted,
    },
    jwtSecret,
    { expiresIn: '7d' },
  );
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = {
      id: payload.sub,
      email: payload.email,
      phone_number: payload.phone_number,
      display_name: payload.display_name,
      is_admin: payload.is_admin,
      is_verified: payload.is_verified,
      is_blocked: payload.is_blocked,
      is_deleted: payload.is_deleted,
    };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function botInternalRequired(req, res, next) {
  if (req.headers['x-bot-token'] !== botInternalToken) {
    return res.status(401).json({ error: 'Invalid bot token' });
  }
  return next();
}

function normalizePhone(phoneNumber) {
  const raw = String(phoneNumber || '').trim();
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('0')) return `+62${cleaned.slice(1)}`;
  if (cleaned.startsWith('62')) return `+${cleaned}`;
  return cleaned ? `+${cleaned}` : '';
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function createOtp(phoneNumber, purpose = 'login') {
  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  await query(
    `INSERT INTO otp_codes (phone_number, code_hash, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
    [phoneNumber, codeHash, purpose],
  );
  return code;
}

async function sendTelegramOtp(chatId, code) {
  return sendTelegramMessage(chatId, `Kode OTP Budgetin kamu: ${code}\nKode berlaku 10 menit.`);
}

async function sendTelegramMessage(chatId, text) {
  if (!telegramBotToken || !chatId) return false;

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });

  return response.ok;
}

async function findTelegramAccountByPhone(phoneNumber) {
  const result = await query(
    `SELECT id, user_id, telegram_user_id, telegram_chat_id, phone_number
     FROM telegram_accounts
     WHERE phone_number = $1
     ORDER BY linked_at DESC
     LIMIT 1`,
    [phoneNumber],
  );
  return result.rows[0];
}

async function findTelegramAccountByTelegramUserId(telegramUserId) {
  const result = await query(
    `SELECT id, user_id, telegram_user_id, telegram_chat_id, phone_number
     FROM telegram_accounts
     WHERE telegram_user_id = $1
     LIMIT 1`,
    [String(telegramUserId || '').trim()],
  );
  return result.rows[0];
}

async function findLinkedTelegramUser(telegramUserId) {
  const result = await query(
    `SELECT
       u.id,
       u.email,
       u.phone_number,
       u.display_name,
       u.is_admin,
       u.is_verified,
       u.is_blocked,
       u.is_deleted,
       u.verified_at,
       u.blocked_at,
       u.deleted_at,
       u.delete_recovery_until,
       u.created_at,
       ta.telegram_user_id,
       ta.telegram_chat_id,
       ta.username,
       ta.first_name
     FROM telegram_accounts ta
     JOIN users u ON u.id = ta.user_id
     WHERE ta.telegram_user_id = $1
     LIMIT 1`,
    [String(telegramUserId || '').trim()],
  );
  return result.rows[0];
}

async function requireAdminTelegramUser(req, res) {
  const telegramUserId = String(req.body.admin_telegram_user_id || req.query.admin_telegram_user_id || '').trim();
  if (!telegramUserId) {
    res.status(400).json({ error: 'admin_telegram_user_id is required' });
    return null;
  }

  const user = await findLinkedTelegramUser(telegramUserId);
  if (!user || !user.is_admin) {
    res.status(403).json({ error: 'Command ini hanya bisa dipakai admin.' });
    return null;
  }
  if (user.is_deleted || user.is_blocked) {
    res.status(403).json({ error: 'Akun admin tidak aktif.' });
    return null;
  }

  return user;
}

async function findAdminTelegramAccounts() {
  const result = await query(
    `SELECT u.id, u.phone_number, u.display_name, ta.telegram_user_id, ta.telegram_chat_id, ta.first_name
     FROM users u
     JOIN telegram_accounts ta ON ta.user_id = u.id
     WHERE u.is_admin = TRUE
       AND u.is_deleted = FALSE
     ORDER BY ta.linked_at DESC`,
  );
  return result.rows;
}

const userReturnFields = 'id, email, phone_number, display_name, is_admin, is_verified, is_blocked, is_deleted, verified_at, blocked_at, deleted_at, delete_recovery_until, created_at';

function verificationRequired(res) {
  return res.status(403).json({
    code: 'ACCOUNT_NOT_VERIFIED',
    error: 'Akun kamu sedang menunggu verifikasi admin.',
  });
}

function blockRequired(res) {
  return res.status(403).json({
    code: 'ACCOUNT_BLOCKED',
    error: 'Akun kamu diblokir. Hubungi admin Budgetin.',
  });
}

function deletedRequired(res) {
  return res.status(403).json({
    code: 'ACCOUNT_DELETED',
    error: 'Akun kamu sudah dinonaktifkan. Hubungi admin Budgetin jika ingin recovery.',
  });
}

async function webFeatureRequired(req, res, next) {
  const result = await query(
    'SELECT is_verified, is_blocked, is_deleted FROM users WHERE id = $1',
    [req.user.id],
  );
  const user = result.rows[0];

  if (!user) return res.status(401).json({ error: 'User tidak ditemukan' });
  if (user.is_deleted) return deletedRequired(res);
  if (user.is_blocked) return blockRequired(res);
  if (!user.is_verified) return verificationRequired(res);

  return next();
}

async function requireLinkedTelegramUser(req, res) {
  const telegramUserId = String(req.body.telegram_user_id || req.query.telegram_user_id || '').trim();
  if (!telegramUserId) {
    res.status(400).json({ error: 'telegram_user_id is required' });
    return null;
  }

  const user = await findLinkedTelegramUser(telegramUserId);
  if (!user) {
    res.status(403).json({ error: 'Akun belum terhubung. Tekan /start lalu Share Phone Number dulu.' });
    return null;
  }
  if (user.is_deleted) {
    deletedRequired(res);
    return null;
  }
  if (user.is_blocked) {
    blockRequired(res);
    return null;
  }

  return user;
}

async function ensureDatabaseSchema() {
  await query('ALTER TABLE users ALTER COLUMN email DROP NOT NULL').catch(() => {});
  await query('ALTER TABLE users ALTER COLUMN password DROP NOT NULL').catch(() => {});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT FALSE');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN NOT NULL DEFAULT FALSE');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS delete_recovery_until TIMESTAMPTZ');
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_by UUID REFERENCES users(id) ON DELETE SET NULL');
  await query(`
    CREATE TABLE IF NOT EXISTS telegram_accounts (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL UNIQUE,
      telegram_chat_id TEXT NOT NULL,
      phone_number TEXT NOT NULL,
      username TEXT,
      first_name TEXT,
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      phone_number TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'login',
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS deletion_requests (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      request_code TEXT NOT NULL UNIQUE,
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      request_type TEXT NOT NULL CHECK (request_type IN ('account', 'all_transactions')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      requester_telegram_user_id TEXT NOT NULL,
      requester_chat_id TEXT NOT NULL,
      user_phone_number TEXT,
      user_display_name TEXT,
      admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      scheduled_deletion_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query('ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ');
  await query('ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ');
  await query(
    `UPDATE users
     SET is_admin = TRUE,
       is_verified = TRUE,
       is_blocked = FALSE,
       is_deleted = FALSE,
       verified_at = COALESCE(verified_at, NOW())
     WHERE phone_number = $1`,
    [adminPhoneNumber],
  );
}

function normalizeInput(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function categoryLabel(code) {
  return CATEGORY_LABELS[code] || code;
}

function normalizeCategory(type, category) {
  const normalized = normalizeInput(category).replace(/_/g, ' ');
  const available = CATEGORY_DEFINITIONS[type] || [];
  const exact = available.find((item) => item.code === normalized.replace(/\s+/g, '_'));
  if (exact) return exact.code;

  const matched = available.find((item) => item.aliases.includes(normalized));
  if (matched) return matched.code;

  return type === 'expense' ? 'other_expense' : null;
}

function validateTransaction(body) {
  const type = body.type === 'income' ? 'income' : body.type === 'expense' ? 'expense' : null;
  const amount = Number(body.amount);
  const category = type ? normalizeCategory(type, body.category) : null;
  const note = String(body.note || '').trim();

  if (!type) return { error: 'type must be income or expense' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount must be greater than 0' };
  if (!category) return { error: 'category is required' };

  return { value: { type, amount, category, note } };
}

async function createTransactionForUser(userId, body) {
  const parsed = validateTransaction(body);
  if (parsed.error) return { error: parsed.error };

  const { type, amount, category, note } = parsed.value;
  await query(
    `INSERT INTO categories (user_id, name)
     VALUES ($1, $2)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [userId, category],
  );

  const result = await query(
    `INSERT INTO transactions (user_id, type, amount, category, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, type, amount::float AS amount, category, note, created_at`,
    [userId, type, amount, category, note],
  );

  await redis.del(`summary:${userId}`).catch(() => {});
  return { data: withCategoryLabels(result.rows)[0] };
}

function buildTransactionFilters(userId, queryParams) {
  const params = [userId];
  const filters = ['user_id = $1'];
  const type = queryParams.type === 'income' || queryParams.type === 'expense' ? queryParams.type : '';
  const category = normalizeInput(queryParams.category).replace(/\s+/g, '_');
  const month = normalizeInput(queryParams.month);
  const date = normalizeInput(queryParams.date);
  const dateFrom = normalizeInput(queryParams.date_from);
  const dateTo = normalizeInput(queryParams.date_to);

  if (type) {
    params.push(type);
    filters.push(`type = $${params.length}`);
  }

  if (category && CATEGORY_LABELS[category]) {
    params.push(category);
    filters.push(`category = $${params.length}`);
  }

  if (/^\d{4}-\d{2}$/.test(month)) {
    params.push(`${month}-01`);
    filters.push(`created_at >= $${params.length}::date`);
    params.push(`${month}-01`);
    filters.push(`created_at < ($${params.length}::date + INTERVAL '1 month')`);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params.push(date);
    filters.push(`created_at >= $${params.length}::date`);
    params.push(date);
    filters.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
  } else {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      params.push(dateFrom);
      filters.push(`created_at >= $${params.length}::date`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      params.push(dateTo);
      filters.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }
  }

  return { where: filters.join(' AND '), params };
}

function transactionOrder(sort) {
  switch (sort) {
    case 'oldest':
      return 'created_at ASC';
    case 'amount_desc':
      return 'amount DESC, created_at DESC';
    case 'amount_asc':
      return 'amount ASC, created_at DESC';
    case 'newest':
    default:
      return 'created_at DESC';
  }
}

function withCategoryLabels(rows) {
  return rows.map((row) => ({
    ...row,
    category_label: categoryLabel(row.category),
  }));
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function getSummaryForUser(userId) {
  const cacheKey = `summary:${userId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return JSON.parse(cached).data;

  const totals = await query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)::float AS income,
       COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::float AS expense
     FROM transactions
     WHERE user_id = $1`,
    [userId],
  );

  const byCategory = await query(
    `SELECT category, type, SUM(amount)::float AS total
     FROM transactions
     WHERE user_id = $1
     GROUP BY category, type
     ORDER BY total DESC
     LIMIT 10`,
    [userId],
  );

  const summary = {
    income: totals.rows[0].income,
    expense: totals.rows[0].expense,
    balance: totals.rows[0].income - totals.rows[0].expense,
    byCategory: withCategoryLabels(byCategory.rows),
  };

  await redis.set(cacheKey, JSON.stringify({ data: summary }), { EX: 30 }).catch(() => {});
  return summary;
}

async function buildTransactionsCsv(userId, queryParams) {
  const { where, params } = buildTransactionFilters(userId, queryParams);
  const result = await query(
    `SELECT created_at, type, category, amount::float AS amount, note
     FROM transactions
     WHERE ${where}
     ORDER BY created_at ASC`,
    params,
  );

  const header = ['date', 'type', 'category', 'category_label', 'amount', 'note'];
  return [
    header.join(','),
    ...result.rows.map((row) =>
      [
        row.created_at.toISOString(),
        row.type,
        row.category,
        categoryLabel(row.category),
        row.amount,
        row.note || '',
      ]
        .map(csvEscape)
        .join(','),
    ),
  ].join('\n');
}

function deletionTypeLabel(type) {
  return type === 'account' ? 'hapus akun' : 'hapus semua transaksi';
}

function generateRequestCode() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function deletionRequestPublicFields(row) {
  if (!row) return row;
  return {
    id: row.id,
    request_code: row.request_code,
    request_type: row.request_type,
    status: row.status,
    user_phone_number: row.user_phone_number,
    user_display_name: row.user_display_name,
    scheduled_deletion_at: row.scheduled_deletion_at,
    processed_at: row.processed_at,
    decided_at: row.decided_at,
    created_at: row.created_at,
  };
}

function exportFilename(queryParams) {
  const filenameParts = ['budgetin-transactions'];
  const filenameType = sanitizeFilenamePart(queryParams.type);
  const filenameCategory = sanitizeFilenamePart(queryParams.category);
  const filenameMonth = sanitizeFilenamePart(queryParams.month);
  const filenameDate = sanitizeFilenamePart(queryParams.date);
  const filenameDateFrom = sanitizeFilenamePart(queryParams.date_from);
  const filenameDateTo = sanitizeFilenamePart(queryParams.date_to);
  if (filenameType) filenameParts.push(filenameType);
  if (filenameCategory) filenameParts.push(filenameCategory);
  if (filenameMonth) filenameParts.push(filenameMonth);
  if (filenameDate) filenameParts.push(filenameDate);
  if (filenameDateFrom || filenameDateTo) filenameParts.push(`${filenameDateFrom || 'awal'}-to-${filenameDateTo || 'akhir'}`);
  return `${filenameParts.join('-')}.csv`;
}

app.get('/health', async (_req, res) => {
  const db = await query('SELECT NOW() AS now');
  res.json({ status: 'ok', databaseTime: db.rows[0].now });
});

app.post('/auth/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || password.length < 6) {
    return res.status(400).json({ error: 'email and password with minimum 6 characters are required' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = await query(
      `INSERT INTO users (email, password) VALUES ($1, $2) RETURNING ${userReturnFields}`,
      [email, passwordHash],
    );
    const user = result.rows[0];
    await seedDefaultCategories(user.id);
    return res.status(201).json({ user, token: signToken(user) });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'email already registered' });
    throw error;
  }
});

app.post('/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const result = await query(`SELECT id, email, password, phone_number, display_name, is_admin, is_verified, is_blocked, is_deleted, verified_at, blocked_at, deleted_at, delete_recovery_until, created_at FROM users WHERE email = $1`, [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      phone_number: user.phone_number,
      display_name: user.display_name,
      is_admin: user.is_admin,
      is_verified: user.is_verified,
      is_blocked: user.is_blocked,
      is_deleted: user.is_deleted,
      verified_at: user.verified_at,
      blocked_at: user.blocked_at,
      deleted_at: user.deleted_at,
      delete_recovery_until: user.delete_recovery_until,
      created_at: user.created_at,
    },
    token: signToken(user),
  });
});

app.post('/auth/request-otp', async (req, res) => {
  const phoneNumber = normalizePhone(req.body.phone_number);
  if (!phoneNumber || phoneNumber.length < 8) {
    return res.status(400).json({ error: 'phone_number is required' });
  }

  const account = await findTelegramAccountByPhone(phoneNumber);
  if (!account) {
    return res.status(404).json({
      error: 'Nomor belum terhubung dengan Telegram. Buka bot Budgetin, tekan /start, lalu share phone number.',
    });
  }

  const code = await createOtp(phoneNumber);
  const sent = await sendTelegramOtp(account.telegram_chat_id, code);
  if (!sent) return res.status(502).json({ error: 'Gagal mengirim OTP ke Telegram' });

  return res.json({ message: 'OTP dikirim ke Telegram', expires_in_seconds: 600 });
});

app.post('/auth/verify-otp', async (req, res) => {
  const phoneNumber = normalizePhone(req.body.phone_number);
  const code = String(req.body.code || '').trim();

  if (!phoneNumber || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'phone_number and 6 digit code are required' });
  }

  const otpResult = await query(
    `SELECT id, code_hash
     FROM otp_codes
     WHERE phone_number = $1
       AND purpose = 'login'
       AND consumed_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [phoneNumber],
  );
  const otp = otpResult.rows[0];
  if (!otp || !(await bcrypt.compare(code, otp.code_hash))) {
    return res.status(401).json({ error: 'OTP tidak valid atau sudah kedaluwarsa' });
  }

  await query('UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1', [otp.id]);

  const userResult = await query(
    `INSERT INTO users (phone_number)
     VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING ${userReturnFields}`,
    [phoneNumber],
  );
  const user = userResult.rows[0];
  await seedDefaultCategories(user.id);

  return res.json({ user, token: signToken(user) });
});

app.get('/me', authRequired, async (req, res) => {
  const result = await query(`SELECT ${userReturnFields} FROM users WHERE id = $1`, [req.user.id]);
  res.json({ user: result.rows[0] });
});

app.get('/telegram/account', botInternalRequired, async (req, res) => {
  const telegramUserId = String(req.query.telegram_user_id || '').trim();
  if (!telegramUserId) {
    return res.status(400).json({ error: 'telegram_user_id is required' });
  }

  const user = await findLinkedTelegramUser(telegramUserId);
  if (!user) {
    return res.status(404).json({ error: 'Akun Telegram belum terhubung' });
  }

  return res.json({ user });
});

app.post('/telegram/contact', botInternalRequired, async (req, res) => {
  const phoneNumber = normalizePhone(req.body.phone_number);
  const telegramUserId = String(req.body.telegram_user_id || '').trim();
  const telegramChatId = String(req.body.telegram_chat_id || '').trim();
  const username = String(req.body.username || '').trim();
  const firstName = String(req.body.first_name || '').trim();

  if (!phoneNumber || !telegramUserId || !telegramChatId) {
    return res.status(400).json({ error: 'phone_number, telegram_user_id, and telegram_chat_id are required' });
  }

  const existingTelegramAccount = await findTelegramAccountByTelegramUserId(telegramUserId);
  const existingPhoneAccount = await findTelegramAccountByPhone(phoneNumber);

  if (existingPhoneAccount && existingPhoneAccount.telegram_user_id !== telegramUserId) {
    return res.status(409).json({
      error: 'Nomor ini sudah terhubung ke akun Telegram lain. Untuk keamanan, data tidak dipindahkan otomatis.',
    });
  }

  let user;
  if (existingTelegramAccount) {
    const phoneOwner = await query('SELECT id FROM users WHERE phone_number = $1 LIMIT 1', [phoneNumber]);
    if (phoneOwner.rows[0] && phoneOwner.rows[0].id !== existingTelegramAccount.user_id) {
      return res.status(409).json({
        error: 'Nomor ini sudah dipakai akun Budgetin lain. Untuk keamanan, data tidak dipindahkan otomatis.',
      });
    }

    const userResult = await query(
      `UPDATE users
       SET phone_number = $1
       WHERE id = $2
       RETURNING ${userReturnFields}`,
      [phoneNumber, existingTelegramAccount.user_id],
    );
    user = userResult.rows[0];
  } else {
    const userResult = await query(
      `INSERT INTO users (phone_number)
       VALUES ($1)
       ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
       RETURNING ${userReturnFields}`,
      [phoneNumber],
    );
    user = userResult.rows[0];
  }

  await seedDefaultCategories(user.id);

  await query(
    `INSERT INTO telegram_accounts (user_id, telegram_user_id, telegram_chat_id, phone_number, username, first_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (telegram_user_id)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       telegram_chat_id = EXCLUDED.telegram_chat_id,
       phone_number = EXCLUDED.phone_number,
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       linked_at = NOW()`,
    [user.id, telegramUserId, telegramChatId, phoneNumber, username, firstName],
  );

  const code = await createOtp(phoneNumber);
  res.status(existingTelegramAccount ? 200 : 201).json({
    user,
    otp: code,
    expires_in_seconds: 600,
    is_new_registration: !existingTelegramAccount && !user.is_admin,
    admins: await findAdminTelegramAccounts(),
  });
});

app.patch('/telegram/profile', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const displayName = String(req.body.display_name || '').trim().replace(/\s+/g, ' ');
  if (displayName.length < 2 || displayName.length > 40) {
    return res.status(400).json({ error: 'Nama dashboard harus 2-40 karakter' });
  }

  const result = await query(
    `UPDATE users
     SET display_name = $1
     WHERE id = $2
     RETURNING ${userReturnFields}`,
    [displayName, user.id],
  );

  res.json({ user: result.rows[0] });
});

app.get('/telegram/transactions', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const limit = Math.min(Number(req.query.limit || 10), 20);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const { where, params } = buildTransactionFilters(user.id, req.query);
  params.push(limit);
  params.push(offset);
  const result = await query(
    `SELECT id, type, amount::float AS amount, category, note, created_at
     FROM transactions
     WHERE ${where}
     ORDER BY ${transactionOrder(req.query.sort)}
     LIMIT $${params.length - 1}
     OFFSET $${params.length}`,
    params,
  );

  res.json({ data: withCategoryLabels(result.rows) });
});

app.post('/telegram/transactions', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const result = await createTransactionForUser(user.id, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

app.delete('/telegram/transactions', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const result = await query(
    `DELETE FROM transactions
     WHERE user_id = $1
     RETURNING id`,
    [user.id],
  );

  await redis.del(`summary:${user.id}`).catch(() => {});
  res.json({ deleted_count: result.rowCount });
});

app.delete('/telegram/transactions/:id', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const result = await query(
    `DELETE FROM transactions
     WHERE id = $1 AND user_id = $2
     RETURNING id, type, amount::float AS amount, category, note, created_at`,
    [req.params.id, user.id],
  );

  if (!result.rows[0]) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  await redis.del(`summary:${user.id}`).catch(() => {});
  res.json({ data: withCategoryLabels(result.rows)[0] });
});

app.get('/telegram/summary', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  res.json({ data: await getSummaryForUser(user.id) });
});

app.get('/telegram/exports/transactions.csv', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;
  if (user.is_blocked) return blockRequired(res);
  if (!user.is_verified) return verificationRequired(res);

  const csv = await buildTransactionsCsv(user.id, req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(req.query)}"`);
  res.send(csv);
});

app.get('/telegram/admin/user-stats', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const result = await query(
    `SELECT
       COUNT(*)::int AS total_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE)::int AS regular_users,
       COUNT(*) FILTER (WHERE is_admin = TRUE)::int AS admin_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_verified = TRUE AND is_blocked = FALSE AND is_deleted = FALSE)::int AS verified_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_verified = FALSE AND is_blocked = FALSE AND is_deleted = FALSE)::int AS pending_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_blocked = TRUE AND is_deleted = FALSE)::int AS blocked_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_deleted = TRUE)::int AS deleted_users
     FROM users`,
  );

  const activeThisMonth = await query(
    `SELECT COUNT(DISTINCT t.user_id)::int AS active_users_this_month
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE u.is_admin = FALSE
       AND u.is_deleted = FALSE
       AND t.created_at >= DATE_TRUNC('month', NOW())`,
  );

  res.json({
    data: {
      ...result.rows[0],
      active_users_this_month: activeThisMonth.rows[0].active_users_this_month,
    },
  });
});

app.get('/telegram/admin/platform-summary', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const threshold = 5;
  const counts = await query(
    `SELECT
       COUNT(*)::int AS total_transactions,
       COUNT(*) FILTER (WHERE t.created_at >= DATE_TRUNC('month', NOW()))::int AS transactions_this_month,
       COUNT(DISTINCT t.user_id) FILTER (WHERE t.created_at >= DATE_TRUNC('month', NOW()))::int AS active_users_this_month
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE u.is_admin = FALSE
       AND u.is_deleted = FALSE`,
  );

  const base = counts.rows[0];
  const canShowMoney = Number(base.active_users_this_month) >= threshold;
  if (!canShowMoney) {
    return res.json({
      data: {
        ...base,
        privacy_threshold: threshold,
        can_show_money: false,
        income_this_month: null,
        expense_this_month: null,
        top_expense_category_this_month: null,
      },
    });
  }

  const totals = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0)::float AS income_this_month,
       COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0)::float AS expense_this_month
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE u.is_admin = FALSE
       AND u.is_deleted = FALSE
       AND t.created_at >= DATE_TRUNC('month', NOW())`,
  );

  const topExpenseCategory = await query(
    `SELECT t.category, COALESCE(SUM(t.amount), 0)::float AS total
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE u.is_admin = FALSE
       AND u.is_deleted = FALSE
       AND t.type = 'expense'
       AND t.created_at >= DATE_TRUNC('month', NOW())
     GROUP BY t.category
     ORDER BY total DESC
     LIMIT 1`,
  );

  res.json({
    data: {
      ...base,
      privacy_threshold: threshold,
      can_show_money: true,
      income_this_month: totals.rows[0].income_this_month,
      expense_this_month: totals.rows[0].expense_this_month,
      top_expense_category_this_month: topExpenseCategory.rows[0]
        ? {
            category: topExpenseCategory.rows[0].category,
            category_label: categoryLabel(topExpenseCategory.rows[0].category),
            total: topExpenseCategory.rows[0].total,
          }
        : null,
    },
  });
});

app.patch('/telegram/admin/users/:telegramUserId', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const action = ['verify', 'block', 'restore'].includes(req.body.action) ? req.body.action : null;
  if (!action) return res.status(400).json({ error: 'action must be verify, block, or restore' });

  const targetTelegramUserId = String(req.params.telegramUserId || '').trim();
  const target = await findLinkedTelegramUser(targetTelegramUserId);
  if (!target) return res.status(404).json({ error: 'User Telegram tidak ditemukan' });
  if (target.is_admin && action === 'block') {
    return res.status(400).json({ error: 'Admin tidak bisa diblokir lewat bot.' });
  }
  if (action === 'restore' && !target.is_deleted) {
    return res.status(409).json({ error: 'Akun ini tidak sedang dinonaktifkan.' });
  }
  if (action === 'restore' && target.delete_recovery_until && new Date(target.delete_recovery_until) < new Date()) {
    return res.status(409).json({ error: 'Masa recovery 2 hari sudah lewat.' });
  }

  let result;
  if (action === 'verify') {
    result = await query(
        `UPDATE users
         SET is_verified = TRUE,
           is_blocked = FALSE,
           is_deleted = FALSE,
           verified_at = NOW(),
           verified_by = $1,
           blocked_at = NULL,
           deleted_at = NULL,
           delete_recovery_until = NULL
         WHERE id = $2
         RETURNING ${userReturnFields}`,
        [admin.id, target.id],
      );
  } else if (action === 'restore') {
    result = await query(
      `UPDATE users
       SET is_deleted = FALSE,
         is_blocked = FALSE,
         deleted_at = NULL,
         delete_recovery_until = NULL,
         blocked_at = NULL
       WHERE id = $1
       RETURNING ${userReturnFields}`,
      [target.id],
    );
  } else {
    result = await query(
        `UPDATE users
         SET is_blocked = TRUE,
           is_verified = FALSE,
           blocked_at = NOW()
         WHERE id = $1
         RETURNING ${userReturnFields}`,
        [target.id],
      );
  }

  res.json({
    user: result.rows[0],
    telegram: {
      telegram_user_id: target.telegram_user_id,
      telegram_chat_id: target.telegram_chat_id,
      username: target.username,
      first_name: target.first_name,
    },
  });
});

app.post('/telegram/deletion-requests', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const requestType = req.body.request_type === 'account' ? 'account' : req.body.request_type === 'all_transactions' ? 'all_transactions' : null;
  if (!requestType) {
    return res.status(400).json({ error: 'request_type must be account or all_transactions' });
  }
  if (requestType === 'account' && user.is_admin) {
    return res.status(400).json({ error: 'Akun admin tidak bisa dihapus lewat bot.' });
  }

  const existing = await query(
    `SELECT id, request_code, request_type, status, scheduled_deletion_at, processed_at, decided_at, created_at
     FROM deletion_requests
     WHERE user_id = $1
       AND request_type = $2
       AND (
         status = 'pending'
         OR (status = 'approved' AND processed_at IS NULL)
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.id, requestType],
  );

  if (existing.rows[0]) {
    const pendingMessage = `Permintaan ${deletionTypeLabel(requestType)} masih menunggu konfirmasi.`;
    return res.status(409).json({
      error: pendingMessage,
      request: deletionRequestPublicFields(existing.rows[0]),
      admins: await findAdminTelegramAccounts(),
    });
  }

  const requestCode = generateRequestCode();
  const result = await query(
    `INSERT INTO deletion_requests (
       request_code,
       user_id,
       request_type,
       requester_telegram_user_id,
       requester_chat_id,
       user_phone_number,
       user_display_name
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, request_code, request_type, status, user_phone_number, user_display_name, scheduled_deletion_at, processed_at, decided_at, created_at`,
    [
      requestCode,
      user.id,
      requestType,
      user.telegram_user_id,
      user.telegram_chat_id,
      user.phone_number,
      user.display_name || user.first_name || '',
    ],
  );

  res.status(201).json({
    request: deletionRequestPublicFields(result.rows[0]),
    admins: await findAdminTelegramAccounts(),
  });
});

app.patch('/telegram/deletion-requests/:code', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const action = req.body.action === 'confirm' ? 'confirm' : null;
  if (!action) {
    return res.status(400).json({ error: 'action must be confirm' });
  }

  const requestResult = await query(
    `SELECT *
     FROM deletion_requests
     WHERE request_code = $1
       AND requester_telegram_user_id = $2
     LIMIT 1`,
    [String(req.params.code || '').trim().toUpperCase(), user.telegram_user_id],
  );
  const deletionRequest = requestResult.rows[0];
  if (!deletionRequest) return res.status(404).json({ error: 'Permintaan hapus tidak ditemukan' });
  if (deletionRequest.request_type !== 'account') {
    return res.status(400).json({ error: 'Konfirmasi otomatis hanya untuk hapus akun.' });
  }
  if (deletionRequest.user_id !== user.id) {
    return res.status(403).json({ error: 'Request ini bukan milik akun kamu.' });
  }
  if (deletionRequest.processed_at) {
    return res.status(409).json({ error: 'Permintaan ini sudah selesai diproses.', request: deletionRequestPublicFields(deletionRequest) });
  }

  if (deletionRequest.status === 'approved') {
    return res.status(409).json({
      error: 'Permintaan hapus akun sudah diproses.',
      request: deletionRequestPublicFields(deletionRequest),
    });
  }
  if (deletionRequest.status !== 'pending') {
    return res.status(409).json({ error: `Permintaan ini sudah ${deletionRequest.status}.`, request: deletionRequestPublicFields(deletionRequest) });
  }
  if (user.is_admin) {
    return res.status(400).json({ error: 'Akun admin tidak bisa dihapus lewat bot.' });
  }

  const processed = await query(
    `UPDATE deletion_requests
     SET status = 'approved',
       scheduled_deletion_at = NOW(),
       processed_at = NOW(),
       decided_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [deletionRequest.id],
  );

  const deletedUser = await query(
    `UPDATE users
     SET is_deleted = TRUE,
       is_blocked = TRUE,
       deleted_at = NOW(),
       delete_recovery_until = NOW() + INTERVAL '2 days',
       blocked_at = NOW()
     WHERE id = $1
     RETURNING ${userReturnFields}`,
    [user.id],
  );
  await redis.del(`summary:${user.id}`).catch(() => {});

  res.json({
    request: deletionRequestPublicFields(processed.rows[0]),
    user: deletedUser.rows[0],
    telegram: {
      telegram_user_id: user.telegram_user_id,
      telegram_chat_id: user.telegram_chat_id,
      username: user.username,
      first_name: user.first_name,
    },
    admins: await findAdminTelegramAccounts(),
  });
});

app.patch('/telegram/admin/deletion-requests/:code', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const action = req.body.action === 'approve' ? 'approve' : req.body.action === 'reject' ? 'reject' : null;
  if (!action) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  const requestResult = await query(
    `SELECT *
     FROM deletion_requests
     WHERE request_code = $1
     LIMIT 1`,
    [String(req.params.code || '').trim().toUpperCase()],
  );
  const deletionRequest = requestResult.rows[0];
  if (!deletionRequest) return res.status(404).json({ error: 'Permintaan hapus tidak ditemukan' });
  if (deletionRequest.status !== 'pending') {
    return res.status(409).json({ error: `Permintaan ini sudah ${deletionRequest.status}.`, request: deletionRequest });
  }

  let deletedCount = 0;
  if (action === 'approve' && deletionRequest.user_id) {
    if (deletionRequest.request_type === 'account') {
      const deleteResult = await query(
        `UPDATE users
         SET is_deleted = TRUE,
           is_blocked = TRUE,
           deleted_at = NOW(),
           delete_recovery_until = NOW() + INTERVAL '2 days',
           blocked_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [deletionRequest.user_id],
      );
      deletedCount = deleteResult.rowCount;
      await redis.del(`summary:${deletionRequest.user_id}`).catch(() => {});
    } else {
      const deleteResult = await query('DELETE FROM transactions WHERE user_id = $1 RETURNING id', [deletionRequest.user_id]);
      deletedCount = deleteResult.rowCount;
      await redis.del(`summary:${deletionRequest.user_id}`).catch(() => {});
    }
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  const updated = await query(
    `UPDATE deletion_requests
     SET status = $1, admin_user_id = $2, decided_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [status, admin.id, deletionRequest.id],
  );

  res.json({
    request: updated.rows[0],
    deleted_count: deletedCount,
  });
});

app.get('/categories', authRequired, async (req, res) => {
  res.json({ data: CATEGORY_DEFINITIONS });
});

app.post('/categories', authRequired, async (req, res) => {
  const type = req.body.type === 'income' ? 'income' : req.body.type === 'expense' ? 'expense' : null;
  const name = type ? normalizeCategory(type, req.body.name) : '';
  if (!name) return res.status(400).json({ error: 'name is required' });

  const result = await query(
    `INSERT INTO categories (user_id, name)
     VALUES ($1, $2)
     ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, created_at`,
    [req.user.id, name],
  );
  res.status(201).json({ data: result.rows[0] });
});

app.get('/transactions', authRequired, webFeatureRequired, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const { where, params } = buildTransactionFilters(req.user.id, req.query);
  params.push(limit);
  const result = await query(
    `SELECT id, type, amount::float AS amount, category, note, created_at
     FROM transactions
     WHERE ${where}
     ORDER BY ${transactionOrder(req.query.sort)}
     LIMIT $${params.length}`,
    params,
  );
  res.json({ data: withCategoryLabels(result.rows) });
});

app.post('/transactions', authRequired, webFeatureRequired, async (req, res) => {
  const result = await createTransactionForUser(req.user.id, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

app.delete('/transactions/:id', authRequired, webFeatureRequired, async (req, res) => {
  const result = await query(
    `DELETE FROM transactions
     WHERE id = $1 AND user_id = $2
     RETURNING id, type, amount::float AS amount, category, note, created_at`,
    [req.params.id, req.user.id],
  );

  if (!result.rows[0]) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  await redis.del(`summary:${req.user.id}`).catch(() => {});
  res.json({ data: withCategoryLabels(result.rows)[0] });
});

app.get('/analytics/summary', authRequired, webFeatureRequired, async (req, res) => {
  res.json({ data: await getSummaryForUser(req.user.id) });
});

app.get('/exports/transactions.csv', authRequired, webFeatureRequired, async (req, res) => {
  const csv = await buildTransactionsCsv(req.user.id, req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(req.query)}"`);
  res.send(csv);
});

async function seedDefaultCategories(userId) {
  const categories = CATEGORY_OPTIONS.map((category) => category.code);
  await Promise.all(
    categories.map((name) =>
      query('INSERT INTO categories (user_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, name]),
    ),
  );
}

async function processDueAccountDeletionRequests() {
  await query(
    `UPDATE deletion_requests
     SET processed_at = NOW()
     WHERE request_type = 'account'
       AND status = 'approved'
       AND processed_at IS NULL
       AND scheduled_deletion_at IS NOT NULL
       AND scheduled_deletion_at <= NOW()`,
  );
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal server error' });
});

ensureDatabaseSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`Budgetin API listening on ${port}`);
    });
    processDueAccountDeletionRequests().catch((error) => console.error('Deletion worker failed:', error.message));
    setInterval(() => {
      processDueAccountDeletionRequests().catch((error) => console.error('Deletion worker failed:', error.message));
    }, 60_000);
  })
  .catch((error) => {
    console.error('Failed to prepare database schema:', error);
    process.exit(1);
  });
