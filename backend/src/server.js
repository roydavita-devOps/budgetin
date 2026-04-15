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
  return jwt.sign({ sub: user.id, email: user.email, phone_number: user.phone_number }, jwtSecret, { expiresIn: '7d' });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = { id: payload.sub, email: payload.email, phone_number: payload.phone_number };
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
  if (!telegramBotToken || !chatId) return false;

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Kode OTP Budgetin kamu: ${code}\nKode berlaku 10 menit.`,
    }),
  });

  return response.ok;
}

async function findTelegramAccountByPhone(phoneNumber) {
  const result = await query(
    `SELECT telegram_chat_id
     FROM telegram_accounts
     WHERE phone_number = $1
     ORDER BY linked_at DESC
     LIMIT 1`,
    [phoneNumber],
  );
  return result.rows[0];
}

async function findLinkedTelegramUser(telegramUserId) {
  const result = await query(
    `SELECT u.id, u.email, u.phone_number, u.created_at
     FROM telegram_accounts ta
     JOIN users u ON u.id = ta.user_id
     WHERE ta.telegram_user_id = $1
     LIMIT 1`,
    [String(telegramUserId || '').trim()],
  );
  return result.rows[0];
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

  return user;
}

async function ensureDatabaseSchema() {
  await query('ALTER TABLE users ALTER COLUMN email DROP NOT NULL').catch(() => {});
  await query('ALTER TABLE users ALTER COLUMN password DROP NOT NULL').catch(() => {});
  await query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT UNIQUE');
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

function exportFilename(queryParams) {
  const filenameParts = ['budgetin-transactions'];
  const filenameType = sanitizeFilenamePart(queryParams.type);
  const filenameCategory = sanitizeFilenamePart(queryParams.category);
  const filenameMonth = sanitizeFilenamePart(queryParams.month);
  if (filenameType) filenameParts.push(filenameType);
  if (filenameCategory) filenameParts.push(filenameCategory);
  if (filenameMonth) filenameParts.push(filenameMonth);
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
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email, created_at',
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
  const result = await query('SELECT id, email, password, created_at FROM users WHERE email = $1', [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  return res.json({
    user: { id: user.id, email: user.email, created_at: user.created_at },
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
     RETURNING id, email, phone_number, created_at`,
    [phoneNumber],
  );
  const user = userResult.rows[0];
  await seedDefaultCategories(user.id);

  return res.json({ user, token: signToken(user) });
});

app.get('/me', authRequired, async (req, res) => {
  const result = await query('SELECT id, email, phone_number, created_at FROM users WHERE id = $1', [req.user.id]);
  res.json({ user: result.rows[0] });
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

  const userResult = await query(
    `INSERT INTO users (phone_number)
     VALUES ($1)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING id, email, phone_number, created_at`,
    [phoneNumber],
  );
  const user = userResult.rows[0];
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
  res.status(201).json({ user, otp: code, expires_in_seconds: 600 });
});

app.get('/telegram/transactions', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const limit = Math.min(Number(req.query.limit || 10), 20);
  const { where, params } = buildTransactionFilters(user.id, req.query);
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

app.post('/telegram/transactions', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const result = await createTransactionForUser(user.id, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
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

  const csv = await buildTransactionsCsv(user.id, req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(req.query)}"`);
  res.send(csv);
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

app.get('/transactions', authRequired, async (req, res) => {
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

app.post('/transactions', authRequired, async (req, res) => {
  const result = await createTransactionForUser(req.user.id, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

app.delete('/transactions/:id', authRequired, async (req, res) => {
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

app.get('/analytics/summary', authRequired, async (req, res) => {
  res.json({ data: await getSummaryForUser(req.user.id) });
});

app.get('/exports/transactions.csv', authRequired, async (req, res) => {
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

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'internal server error' });
});

ensureDatabaseSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`Budgetin API listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to prepare database schema:', error);
    process.exit(1);
  });
