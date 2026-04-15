import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { query } from './db.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || 'development_secret';

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
  return jwt.sign({ sub: user.id, email: user.email }, jwtSecret, { expiresIn: '7d' });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
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
  const parsed = validateTransaction(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const { type, amount, category, note } = parsed.value;
  await query(
    `INSERT INTO categories (user_id, name)
     VALUES ($1, $2)
     ON CONFLICT (user_id, name) DO NOTHING`,
    [req.user.id, category],
  );

  const result = await query(
    `INSERT INTO transactions (user_id, type, amount, category, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, type, amount::float AS amount, category, note, created_at`,
    [req.user.id, type, amount, category, note],
  );

  await redis.del(`summary:${req.user.id}`).catch(() => {});
  res.status(201).json({ data: withCategoryLabels(result.rows)[0] });
});

app.get('/analytics/summary', authRequired, async (req, res) => {
  const cacheKey = `summary:${req.user.id}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) return res.json(JSON.parse(cached));

  const totals = await query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)::float AS income,
       COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::float AS expense
     FROM transactions
     WHERE user_id = $1`,
    [req.user.id],
  );

  const byCategory = await query(
    `SELECT category, type, SUM(amount)::float AS total
     FROM transactions
     WHERE user_id = $1
     GROUP BY category, type
     ORDER BY total DESC
     LIMIT 10`,
    [req.user.id],
  );

  const summary = {
    data: {
      income: totals.rows[0].income,
      expense: totals.rows[0].expense,
      balance: totals.rows[0].income - totals.rows[0].expense,
      byCategory: withCategoryLabels(byCategory.rows),
    },
  };

  await redis.set(cacheKey, JSON.stringify(summary), { EX: 30 }).catch(() => {});
  res.json(summary);
});

app.get('/exports/transactions.csv', authRequired, async (req, res) => {
  const { where, params } = buildTransactionFilters(req.user.id, req.query);
  const result = await query(
    `SELECT created_at, type, category, amount::float AS amount, note
     FROM transactions
     WHERE ${where}
     ORDER BY created_at ASC`,
    params,
  );

  const header = ['date', 'type', 'category', 'category_label', 'amount', 'note'];
  const lines = [
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
  ];

  const filenameParts = ['budgetin-transactions'];
  const filenameType = sanitizeFilenamePart(req.query.type);
  const filenameCategory = sanitizeFilenamePart(req.query.category);
  const filenameMonth = sanitizeFilenamePart(req.query.month);
  if (filenameType) filenameParts.push(filenameType);
  if (filenameCategory) filenameParts.push(filenameCategory);
  if (filenameMonth) filenameParts.push(filenameMonth);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filenameParts.join('-')}.csv"`);
  res.send(lines.join('\n'));
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

app.listen(port, () => {
  console.log(`Budgetin API listening on ${port}`);
});
