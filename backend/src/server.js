import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import crypto from 'crypto';
import express from 'express';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import path from 'path';
import { createClient } from 'redis';
import { pool, query } from './db.js';
import { createInactivityService, ensureInactivitySchema } from './inactivity.js';

export function validateRuntimeConfig(env) {
  const production = env.NODE_ENV === 'production' || String(env.COOKIE_SECURE || '').toLowerCase() === 'true';
  if (production) {
    const defaults = new Set(['development_secret', 'budgetin_internal_dev_token', 'change_me_in_production', 'change_me_internal_bot_token']);
    for (const name of ['JWT_SECRET', 'BOT_INTERNAL_TOKEN']) {
      const value = env[name] || '';
      if (Buffer.byteLength(value.trim(), 'utf8') < 32 || defaults.has(value.trim().toLowerCase()) || /^change[_-]?me/i.test(value.trim())) {
        throw new Error(`${name} must be a non-default secret of at least 32 bytes in production`);
      }
    }
    if (env.JWT_SECRET === env.BOT_INTERNAL_TOKEN) {
      throw new Error('JWT_SECRET and BOT_INTERNAL_TOKEN must be different in production');
    }
    let databasePassword;
    try {
      const databaseUrl = new URL(env.DATABASE_URL || '');
      if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('invalid protocol');
      databasePassword = decodeURIComponent(databaseUrl.password);
    } catch {
      throw new Error('DATABASE_URL must be configured for production');
    }
    if (Buffer.byteLength(databasePassword, 'utf8') < 24 || databasePassword === 'budgetin_password') {
      throw new Error('DATABASE_URL must use a non-default database password of at least 24 bytes in production');
    }
  }
  const hops = String(env.OTP_TRUST_PROXY_HOPS || '').trim();
  if (hops && (!/^[1-9]\d*$/.test(hops) || !Number.isSafeInteger(Number(hops)))) {
    throw new Error('OTP_TRUST_PROXY_HOPS must be a positive integer when configured');
  }
  for (const key of ['INACTIVITY_AUTO_ENABLED', 'INACTIVITY_AUTO_PURGE_ENABLED']) {
    const value = String(env[key] || '').trim().toLowerCase();
    if (value && !['true', 'false'].includes(value)) throw new Error(`${key} must be true or false`);
  }
  if (String(env.INACTIVITY_AUTO_PURGE_ENABLED || '').trim().toLowerCase() === 'true'
    && String(env.INACTIVITY_AUTO_ENABLED || '').trim().toLowerCase() !== 'true') {
    throw new Error('Automatic inactivity purge requires inactivity monitoring');
  }
  return { production, proxyHops: hops ? Number(hops) : 0 };
}

const runtimeConfig = validateRuntimeConfig(process.env);
const app = express();
if (runtimeConfig.proxyHops) app.set('trust proxy', runtimeConfig.proxyHops);
const port = Number(process.env.PORT || 4000);
const jwtSecret = process.env.JWT_SECRET || 'development_secret';
const botInternalToken = process.env.BOT_INTERNAL_TOKEN || 'budgetin_internal_dev_token';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const adminPhoneNumber = normalizePhone(process.env.ADMIN_PHONE_NUMBER || '081390195600');
const refreshTokenTtlDays = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 14);
const refreshCookieName = process.env.REFRESH_COOKIE_NAME || 'budgetin_refresh_token';
const refreshCookieSecure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
const inactivityEnabled = String(process.env.INACTIVITY_AUTO_ENABLED || '').trim().toLowerCase() === 'true';
const inactivityAutoPurgeEnabled = String(process.env.INACTIVITY_AUTO_PURGE_ENABLED || '').trim().toLowerCase() === 'true';
const adminPhoneDigits = adminPhoneNumber.replace(/\D/g, '');
const appTimeZone = 'Asia/Jakarta';
const jakartaDayStartSql = `(DATE_TRUNC('day', NOW() AT TIME ZONE '${appTimeZone}') AT TIME ZONE '${appTimeZone}')`;
const jakartaMonthStartSql = `(DATE_TRUNC('month', NOW() AT TIME ZONE '${appTimeZone}') AT TIME ZONE '${appTimeZone}')`;
const inactiveConditionSql = `(
  NOT u.is_admin AND NOT u.is_blocked AND NOT u.is_deleted
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT regexp_replace(COALESCE(u.phone_number, ''), '[^0-9]', '', 'g') AS digits
      UNION ALL
      SELECT regexp_replace(COALESCE(ta.phone_number, ''), '[^0-9]', '', 'g')
      FROM telegram_accounts ta WHERE ta.user_id = u.id
    ) admin_numbers
    WHERE (CASE WHEN left(digits, 1) = '0' THEN '62' || substr(digits, 2) ELSE digits END) = '${adminPhoneDigits}'
  ) AND (
    EXISTS (SELECT 1 FROM inactivity_cases ic WHERE ic.user_id = u.id)
    OR (${inactivityEnabled ? 'TRUE' : 'FALSE'} AND u.inactivity_enrolled_at IS NOT NULL
      AND GREATEST(u.inactivity_enrolled_at, u.last_transaction_activity_at) <= clock_timestamp() - INTERVAL '30 days')
  )
)`;

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
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : [];

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (error) => console.error('Redis error:', error.message));
const otpRedis = redis.duplicate({ disableOfflineQueue: true });
otpRedis.on('error', (error) => console.error('OTP rate limit Redis error:', error.message));

const otpRateLimitScript = `
  local result = {}
  for i, key in ipairs(KEYS) do
    local count = redis.call('INCR', key)
    if count == 1 or redis.call('TTL', key) < 0 then
      redis.call('EXPIRE', key, ARGV[1])
    end
    result[#result + 1] = count
    result[#result + 1] = redis.call('TTL', key)
  end
  return result
`;

export function createOtpRateLimit({ client, secret, sourceEnabled = false }) {
  const windowSeconds = 600;
  const digest = (value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
  return (action) => async (req, res, next) => {
    const phone = normalizePhone(req.body?.phone_number);
    const code = String(req.body?.code || '').trim();
    if (!/^\+[1-9]\d{7,14}$/.test(phone) || (action === 'verify' && !/^\d{6}$/.test(code))) {
      return res.status(400).json({ error: action === 'verify' ? 'phone_number and 6 digit code are required' : 'phone_number is required' });
    }

    const keys = [`otp-limit:${action}:account:${digest(phone)}`];
    const limits = [action === 'request' ? 5 : 10];
    if (sourceEnabled && req.ip) {
      keys.push(`otp-limit:${action}:source:${digest(req.ip)}`);
      limits.push(action === 'request' ? 60 : 120);
    }
    try {
      if (!client.isReady) throw new Error('Redis unavailable');
      const counts = await client.eval(otpRateLimitScript, { keys, arguments: [String(windowSeconds)] });
      if (!Array.isArray(counts) || counts.length !== keys.length * 2 || counts.some((value) => !Number.isInteger(value) || value < 0)) {
        throw new Error('Invalid Redis rate limit response');
      }
      const retryAfter = limits.reduce((max, limit, index) => counts[index * 2] > limit ? Math.max(max, counts[index * 2 + 1], 1) : max, 0);
      if (retryAfter) {
        res.setHeader('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      }
      return next();
    } catch {
      return res.status(503).json({ error: 'Layanan OTP sementara tidak tersedia. Coba lagi nanti.' });
    }
  };
}

const otpRateLimit = createOtpRateLimit({ client: otpRedis, secret: jwtSecret, sourceEnabled: Boolean(runtimeConfig.proxyHops) });

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
    { expiresIn: '1h' },
  );
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    String(cookieHeader)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) return [part, ''];
        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      }),
  );
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('hex');
}

function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function setRefreshTokenCookie(res, token, expiresAt) {
  const parts = [
    `${refreshCookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (refreshCookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearRefreshTokenCookie(res) {
  const parts = [
    `${refreshCookieName}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (refreshCookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  await query(
    `UPDATE refresh_tokens
     SET revoked_at = COALESCE(revoked_at, NOW()), last_used_at = NOW()
     WHERE token_hash = $1`,
    [hashRefreshToken(refreshToken)],
  );
}

async function createRefreshTokenForUser(userId) {
  const refreshToken = generateRefreshToken();
  const result = await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 day'))
     RETURNING expires_at`,
    [userId, hashRefreshToken(refreshToken), refreshTokenTtlDays],
  );
  return {
    token: refreshToken,
    expiresAt: result.rows[0].expires_at,
  };
}

async function cleanupRefreshTokens() {
  await query(
    `DELETE FROM refresh_tokens
     WHERE expires_at <= NOW()
        OR revoked_at IS NOT NULL`,
  );
}

async function invalidateSummaryCache(userId) {
  const cacheKeys = await redis.keys(`summary:${userId}:*`).catch(() => []);
  if (!cacheKeys.length) return;
  await redis.del(cacheKeys).catch(() => {});
}

async function inTransaction(operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const inactivityService = createInactivityService({
  pool,
  protectedPhone: adminPhoneNumber,
  autoPurgeEnabled: inactivityAutoPurgeEnabled,
  retrySeconds: 3600,
  async sendAlert({ telegramUserId, chatId, text, reply_markup }) {
    if (!telegramBotToken || !isPrivateTelegramChat(telegramUserId, chatId)) return false;
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => null);
    return response.ok && body?.ok === true && String(body?.result?.chat?.id || '') === String(chatId);
  },
  async invalidateCache(userId) {
    const keys = await redis.keys(`summary:${userId}:*`);
    if (keys.length) await redis.del(keys);
  },
});

let inactivityWorkerRunning = false;
async function runInactivityWorker() {
  if (!inactivityEnabled || inactivityWorkerRunning) return;
  inactivityWorkerRunning = true;
  try {
    const result = await inactivityService.runOnce();
    if (result.cacheInvalidationFailures) console.error('Inactivity cleanup could not clear some cached summaries.');
    if (result.enrollmentFailures || result.alertFailures || result.purgeFailures) {
      console.error('Some inactivity operations need retry.');
    }
  } catch (error) {
    console.error('Inactivity worker failed:', error.code || 'service error');
  } finally {
    inactivityWorkerRunning = false;
  }
}

async function issueAuthSession(res, user, previousRefreshToken = '') {
  if (previousRefreshToken) {
    await revokeRefreshToken(previousRefreshToken);
  }
  const refreshSession = await createRefreshTokenForUser(user.id);
  setRefreshTokenCookie(res, refreshSession.token, refreshSession.expiresAt);
  return {
    user,
    token: signToken(user),
  };
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

function isPrivateTelegramChat(userId, chatId) {
  const user = String(userId || '').trim();
  const chat = String(chatId || '').trim();
  return /^[1-9]\d*$/.test(user) && user === chat;
}

function generateOtp() {
  return crypto.randomInt(100000, 1000000).toString();
}

async function createOtp(phoneNumber, userId, purpose = 'login') {
  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  await query(
    `INSERT INTO otp_codes (phone_number, code_hash, purpose, expires_at, user_id)
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', $4)`,
    [phoneNumber, codeHash, purpose, userId],
  );
  return code;
}

async function sendTelegramOtp(chatId, code) {
  return sendTelegramMessage(chatId, `Kode OTP Budgetin kamu: ${code}\nKode berlaku 10 menit. Jangan bagikan kode ini kepada siapa pun.`);
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
       ${inactiveConditionSql} AS is_inactive,
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

async function adminAccountsForNotification() {
  try {
    return { admins: await findAdminTelegramAccounts(), admins_available: true };
  } catch (error) {
    console.error('Admin notification lookup failed:', error.code || 'database error');
    return { admins: [], admins_available: false };
  }
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

function inactiveRequired(res) {
  return res.status(403).json({
    code: 'ACCOUNT_INACTIVE',
    error: 'Akun nonaktif karena tidak ada transaksi selama 30 hari. Periksa peringatan di bot Telegram atau hubungi admin melalui /tentang.',
  });
}

async function isInactiveUser(userId) {
  const result = await query(`SELECT ${inactiveConditionSql} AS inactive FROM users u WHERE u.id = $1`, [userId]);
  return Boolean(result.rows[0]?.inactive);
}

async function webFeatureRequired(req, res, next) {
  const result = await query(
    `SELECT u.is_verified, u.is_blocked, u.is_deleted, ${inactiveConditionSql} AS is_inactive FROM users u WHERE u.id = $1`,
    [req.user.id],
  );
  const user = result.rows[0];

  if (!user) return res.status(401).json({ error: 'User tidak ditemukan' });
  if (user.is_deleted) return deletedRequired(res);
  if (user.is_blocked) return blockRequired(res);
  if (user.is_inactive) return inactiveRequired(res);
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
  if (user.is_inactive) {
    inactiveRequired(res);
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
  await query('ALTER TABLE categories ADD COLUMN IF NOT EXISTS type TEXT');
  await query('ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_category TEXT');
  await query('ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT TRUE');
  await query('ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_user_id_name_key').catch(() => {});
  await query('ALTER TABLE transactions ADD COLUMN IF NOT EXISTS subcategory TEXT');
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_type_parent_name
    ON categories (user_id, type, parent_category, LOWER(name))
    WHERE is_custom = TRUE
  `);
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
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      phone_number TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'login',
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query('ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE');
  await query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
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

function formatExportDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}/${map.month}/${map.day} ${map.hour}:${map.minute}:${map.second}`;
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

function normalizeCustomCategoryName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function isValidCategoryType(type) {
  return type === 'income' || type === 'expense';
}

function isValidParentCategory(type, parentCategory) {
  return Boolean(isValidCategoryType(type) && CATEGORY_DEFINITIONS[type]?.some((item) => item.code === parentCategory));
}

async function findCustomSubcategory(userId, type, parentCategory, name) {
  const normalizedName = normalizeCustomCategoryName(name);
  if (!normalizedName) return null;
  const result = await query(
    `SELECT id, user_id, type, parent_category, name, created_at
     FROM categories
     WHERE user_id = $1
       AND is_custom = TRUE
       AND type = $2
       AND parent_category = $3
       AND LOWER(name) = LOWER($4)
     LIMIT 1`,
    [userId, type, parentCategory, normalizedName],
  );
  return result.rows[0] || null;
}

async function listCustomSubcategories(userId) {
  const result = await query(
    `SELECT id, type, parent_category, name, created_at
     FROM categories
     WHERE user_id = $1
       AND is_custom = TRUE
       AND type IN ('income', 'expense')
       AND parent_category IS NOT NULL
     ORDER BY type ASC, parent_category ASC, LOWER(name) ASC`,
    [userId],
  );
  return result.rows;
}

async function createCustomSubcategory(userId, body) {
  const type = body.type === 'income' ? 'income' : body.type === 'expense' ? 'expense' : '';
  const parentCategory = normalizeInput(body.parent_category).replace(/\s+/g, '_');
  const name = normalizeCustomCategoryName(body.name);

  if (!isValidCategoryType(type)) return { error: 'type must be income or expense' };
  if (!isValidParentCategory(type, parentCategory)) return { error: 'parent_category is invalid' };
  if (name.length < 2 || name.length > 40) return { error: 'name must be between 2 and 40 characters' };

  const duplicate = await findCustomSubcategory(userId, type, parentCategory, name);
  if (duplicate) return { error: 'Subkategori ini sudah ada', status: 409 };

  const limitCheck = await query(
    `SELECT COUNT(*)::int AS total
     FROM categories
     WHERE user_id = $1
       AND is_custom = TRUE
       AND type = $2
       AND parent_category = $3`,
    [userId, type, parentCategory],
  );
  if (Number(limitCheck.rows[0]?.total || 0) >= 10) {
    return { error: 'Maksimal 10 subkategori untuk kategori utama ini', status: 400 };
  }

  const result = await query(
    `INSERT INTO categories (user_id, name, type, parent_category, is_custom)
     VALUES ($1, $2, $3, $4, TRUE)
     RETURNING id, type, parent_category, name, created_at`,
    [userId, name, type, parentCategory],
  );

  return { data: result.rows[0] };
}

async function deleteCustomSubcategory(userId, categoryId) {
  const existing = await query(
    `SELECT id, type, parent_category, name
     FROM categories
     WHERE id = $1
       AND user_id = $2
       AND is_custom = TRUE
     LIMIT 1`,
    [categoryId, userId],
  );
  const row = existing.rows[0];
  if (!row) return { error: 'Subkategori tidak ditemukan', status: 404 };

  const usage = await query(
    `SELECT COUNT(*)::int AS total
     FROM transactions
     WHERE user_id = $1
       AND type = $2
       AND category = $3
       AND LOWER(COALESCE(subcategory, '')) = LOWER($4)`,
    [userId, row.type, row.parent_category, row.name],
  );
  if (Number(usage.rows[0]?.total || 0) > 0) {
    return { error: 'Subkategori masih dipakai transaksi lama', status: 409 };
  }

  await query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [categoryId, userId]);
  return { data: row };
}

function validateTransaction(body) {
  const type = body.type === 'income' ? 'income' : body.type === 'expense' ? 'expense' : null;
  const amount = Number(body.amount);
  const category = type ? normalizeCategory(type, body.category) : null;
  const note = String(body.note || '').trim();
  const subcategory = normalizeCustomCategoryName(body.subcategory || '');

  if (!type) return { error: 'type must be income or expense' };
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'amount must be greater than 0' };
  if (!category) return { error: 'category is required' };

  return { value: { type, amount, category, note, subcategory } };
}

async function createTransactionForUser(userId, body) {
  const parsed = validateTransaction(body);
  if (parsed.error) return { error: parsed.error };

  const { type, amount, category, note, subcategory } = parsed.value;
  if (subcategory) {
    const customSubcategory = await findCustomSubcategory(userId, type, category, subcategory);
    if (!customSubcategory) return { error: 'subcategory is invalid' };
  }

  const result = await inTransaction(async (client) => {
    const account = await client.query(
      `SELECT u.id, u.is_deleted, u.is_blocked, ${inactiveConditionSql} AS is_inactive
       FROM users u WHERE u.id = $1 FOR UPDATE`,
      [userId],
    );
    const user = account.rows[0];
    if (!user) return { status: 401, error: 'User tidak ditemukan' };
    if (user.is_deleted || user.is_blocked) return { status: 403, error: 'Akun tidak aktif.' };
    if (user.is_inactive) return { status: 403, code: 'ACCOUNT_INACTIVE', error: 'Akun nonaktif. Periksa peringatan di bot Telegram.' };
    const inserted = await client.query(
      `INSERT INTO transactions (user_id, type, amount, category, subcategory, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, type, amount::float AS amount, category, subcategory, note, created_at`,
      [userId, type, amount, category, subcategory || null, note],
    );
    await client.query('UPDATE users SET last_transaction_activity_at = clock_timestamp() WHERE id = $1 AND inactivity_enrolled_at IS NOT NULL', [userId]);
    return { data: withCategoryLabels(inserted.rows)[0] };
  });

  if (result.error) return result;
  await invalidateSummaryCache(userId);
  return result;
}

async function updateTransactionForUser(userId, transactionId, body) {
  const parsed = validateTransaction(body);
  if (parsed.error) return { error: parsed.error };

  const { type, amount, category, note, subcategory } = parsed.value;
  if (subcategory) {
    const customSubcategory = await findCustomSubcategory(userId, type, category, subcategory);
    if (!customSubcategory) return { error: 'subcategory is invalid' };
  }

  const result = await query(
    `UPDATE transactions
     SET type = $3,
       amount = $4,
       category = $5,
       subcategory = $6,
       note = $7
     WHERE id = $1
       AND user_id = $2
     RETURNING id, type, amount::float AS amount, category, subcategory, note, created_at`,
    [transactionId, userId, type, amount, category, subcategory || null, note],
  );

  if (!result.rows[0]) return { error: 'Transaksi tidak ditemukan', status: 404 };
  await invalidateSummaryCache(userId);
  return { data: withCategoryLabels(result.rows)[0] };
}

function buildTransactionFilters(userId, queryParams) {
  const params = [userId];
  const filters = ['user_id = $1'];
  const type = queryParams.type === 'income' || queryParams.type === 'expense' ? queryParams.type : '';
  const category = normalizeInput(queryParams.category).replace(/\s+/g, '_');
  const search = normalizeInput(queryParams.search);
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

  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    filters.push(`(
      LOWER(COALESCE(note, '')) LIKE $${params.length}
      OR LOWER(REPLACE(category, '_', ' ')) LIKE $${params.length}
      OR LOWER(COALESCE(subcategory, '')) LIKE $${params.length}
      OR LOWER(
        CASE category
          ${CATEGORY_OPTIONS.map((item, index) => `WHEN '${item.code}' THEN $${params.length + index + 1}`).join(' ')}
          ELSE category
        END
      ) LIKE $${params.length}
    )`);
    for (const item of CATEGORY_OPTIONS) {
      params.push(item.label.toLowerCase());
    }
  }

  if (/^\d{4}-\d{2}$/.test(month)) {
    params.push(`${month}-01`);
    filters.push(`created_at >= ($${params.length}::date::timestamp AT TIME ZONE '${appTimeZone}')`);
    params.push(`${month}-01`);
    filters.push(`created_at < (($${params.length}::date + INTERVAL '1 month') AT TIME ZONE '${appTimeZone}')`);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    params.push(date);
    filters.push(`created_at >= ($${params.length}::date::timestamp AT TIME ZONE '${appTimeZone}')`);
    params.push(date);
    filters.push(`created_at < (($${params.length}::date + INTERVAL '1 day') AT TIME ZONE '${appTimeZone}')`);
  } else {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
      params.push(dateFrom);
      filters.push(`created_at >= ($${params.length}::date::timestamp AT TIME ZONE '${appTimeZone}')`);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      params.push(dateTo);
      filters.push(`created_at < (($${params.length}::date + INTERVAL '1 day') AT TIME ZONE '${appTimeZone}')`);
    }
  }

  return { where: filters.join(' AND '), params };
}

function validateTransactionDates(params) {
  const month = normalizeInput(params.month);
  const dates = ['date', 'date_from', 'date_to'];
  if (month && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month.startsWith('0000-'))) {
    return 'month harus berupa bulan kalender yang valid (YYYY-MM)';
  }
  for (const key of dates) {
    const value = normalizeInput(params[key]);
    if (!value) continue;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return `${key} harus berupa tanggal kalender yang valid (YYYY-MM-DD)`;
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const monthNumber = Number(monthText);
    const day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (year < 1 || monthNumber < 1 || monthNumber > 12 || day < 1 || day > daysInMonth[monthNumber - 1]) {
      return `${key} harus berupa tanggal kalender yang valid (YYYY-MM-DD)`;
    }
  }
  const from = normalizeInput(params.date_from);
  const to = normalizeInput(params.date_to);
  if (from && to && from > to) return 'date_from tidak boleh lebih akhir daripada date_to';
  return null;
}

function validTransactionDateFilters(req, res, next) {
  const error = validateTransactionDates(req.query);
  if (error) return res.status(400).json({ error });
  return next();
}

function transactionOrder(sort) {
  switch (sort) {
    case 'oldest':
      return 'created_at ASC, id ASC';
    case 'amount_desc':
      return 'amount DESC, created_at DESC, id DESC';
    case 'amount_asc':
      return 'amount ASC, created_at DESC, id DESC';
    case 'newest':
    default:
      return 'created_at DESC, id DESC';
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

async function getSummaryForUser(userId, queryParams = {}) {
  const normalizedMonth = /^\d{4}-\d{2}$/.test(normalizeInput(queryParams.month))
    ? normalizeInput(queryParams.month)
    : '';
  const cacheKey = `summary:${userId}:${normalizedMonth || 'all'}`;
  const cacheable = !['type', 'category', 'search', 'date', 'date_from', 'date_to']
    .some((key) => normalizeInput(queryParams[key]));
  const cached = cacheable ? await redis.get(cacheKey).catch(() => null) : null;
  if (cached) return JSON.parse(cached).data;

  const { where, params } = buildTransactionFilters(userId, queryParams);

  const totals = await query(
     `SELECT
        COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)::float AS income,
        COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0)::float AS expense
      FROM transactions
      WHERE ${where}`,
    params,
  );

  const byCategory = await query(
    `SELECT category, type, SUM(amount)::float AS total
     FROM transactions
     WHERE ${where}
     GROUP BY category, type
     ORDER BY total DESC
     LIMIT 10`,
    params,
  );

  const summary = {
    income: totals.rows[0].income,
    expense: totals.rows[0].expense,
    balance: totals.rows[0].income - totals.rows[0].expense,
    byCategory: withCategoryLabels(byCategory.rows),
  };

  if (cacheable) await redis.set(cacheKey, JSON.stringify({ data: summary }), { EX: 30 }).catch(() => {});
  return summary;
}

async function buildTransactionsCsv(userId, queryParams) {
  const { where, params } = buildTransactionFilters(userId, queryParams);
  const result = await query(
    `SELECT created_at, type, category, subcategory, amount::float AS amount, note
     FROM transactions
     WHERE ${where}
     ORDER BY created_at ASC`,
    params,
  );

  const header = ['date', 'type', 'category', 'category_label', 'subcategory', 'amount', 'note'];
  return [
    header.join(','),
    ...result.rows.map((row) =>
      [
        formatExportDate(row.created_at),
        row.type,
        row.category,
        categoryLabel(row.category),
        row.subcategory || '',
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
      `INSERT INTO users (email, password, inactivity_enrolled_at)
       VALUES ($1, $2, CASE WHEN $3 THEN clock_timestamp() ELSE NULL END) RETURNING ${userReturnFields}`,
      [email, passwordHash, inactivityEnabled],
    );
    const user = result.rows[0];
    await seedDefaultCategories(user.id);
    return res.status(201).json(await issueAuthSession(res, user));
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
  if (await isInactiveUser(user.id)) return inactiveRequired(res);

  return res.json(
    await issueAuthSession(res, {
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
    }),
  );
});

app.post('/auth/request-otp', otpRateLimit('request'), async (req, res) => {
  const phoneNumber = normalizePhone(req.body.phone_number);
  if (!phoneNumber || phoneNumber.length < 8) {
    return res.status(400).json({ error: 'phone_number is required' });
  }

  const account = await findTelegramAccountByPhone(phoneNumber);
  if (account && isPrivateTelegramChat(account.telegram_user_id, account.telegram_chat_id)
    && !(await isInactiveUser(account.user_id))) {
    const code = await createOtp(phoneNumber, account.user_id);
    try {
      if (!(await sendTelegramOtp(account.telegram_chat_id, code))) console.error('OTP delivery failed');
    } catch {
      console.error('OTP delivery failed');
    }
  }

  return res.json({ message: 'Jika nomor sudah terhubung, periksa OTP di chat pribadi bot Budgetin. Jika belum, gunakan /mulai atau /hubungkan_ulang. Jika akun nonaktif, periksa peringatan bot atau hubungi admin melalui /tentang.', expires_in_seconds: 600 });
});

app.post('/auth/verify-otp', otpRateLimit('verify'), async (req, res) => {
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

  const consumed = await query(
    'UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id',
    [otp.id],
  );
  if (!consumed.rows.length) {
    return res.status(401).json({ error: 'OTP tidak valid atau sudah kedaluwarsa' });
  }

  const userResult = await query(
    `INSERT INTO users (phone_number, inactivity_enrolled_at)
     VALUES ($1, CASE WHEN $2 THEN clock_timestamp() ELSE NULL END)
     ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number
     RETURNING ${userReturnFields}`,
    [phoneNumber, inactivityEnabled],
  );
  const user = userResult.rows[0];
  if (await isInactiveUser(user.id)) return inactiveRequired(res);
  await seedDefaultCategories(user.id);

  return res.json(await issueAuthSession(res, user));
});

app.post('/auth/refresh', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const refreshToken = cookies[refreshCookieName];
  if (!refreshToken) {
    clearRefreshTokenCookie(res);
    return res.status(401).json({ error: 'Refresh token tidak tersedia' });
  }

  const result = await query(
    `SELECT
       rt.id AS refresh_token_id,
       rt.user_id,
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
       u.created_at
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1
       AND rt.revoked_at IS NULL
       AND rt.expires_at > NOW()
     LIMIT 1`,
    [hashRefreshToken(refreshToken)],
  );

  const user = result.rows[0];
  if (!user) {
    await revokeRefreshToken(refreshToken);
    clearRefreshTokenCookie(res);
    return res.status(401).json({ error: 'Refresh token tidak valid atau sudah kedaluwarsa' });
  }

  if (await isInactiveUser(user.id)) {
    await revokeRefreshToken(refreshToken);
    clearRefreshTokenCookie(res);
    return inactiveRequired(res);
  }

  await query('UPDATE refresh_tokens SET last_used_at = NOW() WHERE id = $1', [user.refresh_token_id]);
  return res.json(await issueAuthSession(res, user, refreshToken));
});

app.post('/auth/logout', async (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  await revokeRefreshToken(cookies[refreshCookieName]);
  clearRefreshTokenCookie(res);
  return res.json({ success: true });
});

app.get('/me', authRequired, async (req, res) => {
  const result = await query(`SELECT ${userReturnFields} FROM users WHERE id = $1`, [req.user.id]);
  if (!result.rows[0]) return res.status(401).json({ error: 'User tidak ditemukan' });
  if (await isInactiveUser(req.user.id)) return inactiveRequired(res);
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

app.post('/telegram/inactivity/response', botInternalRequired, async (req, res) => {
  const telegramUserId = String(req.body.telegram_user_id || '').trim();
  const action = String(req.body.action || '');
  const token = String(req.body.token || '');
  if (!isPrivateTelegramChat(telegramUserId, telegramUserId)
    || !['keep', 'delete'].includes(action) || !/^[A-Za-z0-9_-]{22}$/.test(token)) {
    return res.status(400).json({ error: 'Respons tidak valid.' });
  }
  if (action === 'delete' && !inactivityEnabled) {
    return res.status(409).json({ code: 'INACTIVITY_DISABLED', error: 'Penghapusan sementara tidak tersedia. Akun tidak dihapus.' });
  }
  try {
    const result = await inactivityService.handleCallback({ telegramUserId, chatId: telegramUserId, data: `inactive:${action}:${token}` });
    if (result.outcome === 'kept') return res.json({ message: 'Akun kamu aktif kembali. Hitungan 30 hari dimulai ulang.' });
    if (result.outcome === 'deleted') {
      if (result.cacheInvalidationFailed) console.error('Inactivity cleanup could not clear a cached summary.');
      return res.json({ message: 'Akun dan data yang terhubung telah dihapus permanen dari database.' });
    }
    return res.status(409).json({ error: 'Peringatan tidak berlaku lagi atau sudah diproses.' });
  } catch (error) {
    console.error('Inactivity response failed:', error.code || 'service error');
    return res.status(500).json({ error: 'Respons belum dapat diproses. Silakan coba lagi.' });
  }
});

app.post('/telegram/inactivity/poll-begin', botInternalRequired, async (req, res) => {
  if (!inactivityEnabled) return res.json({ enabled: false });
  const ownerId = String(req.body.ownerId || '');
  const requestId = String(req.body.requestId || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(ownerId) || !/^[A-Za-z0-9_-]{22}$/.test(requestId)) return res.status(400).json({ error: 'Identitas polling tidak valid.' });
  try {
    const { token } = await inactivityService.beginPoll({ ownerId, requestId });
    return res.json({ enabled: true, token });
  } catch (error) {
    console.error('Inactivity poll begin failed:', error.code || 'service error');
    return res.status(503).json({ error: 'Polling sementara tidak tersedia.' });
  }
});

app.post('/telegram/inactivity/poll-complete', botInternalRequired, async (req, res) => {
  if (!inactivityEnabled) return res.status(409).json({ error: 'Pemantauan tidak aktif.' });
  const ownerId = String(req.body.ownerId || '');
  const token = String(req.body.token || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(ownerId) || !/^[A-Za-z0-9_-]{22}$/.test(token)) {
    return res.status(400).json({ error: 'Token polling tidak valid.' });
  }
  try {
    if (!(await inactivityService.completePollBatch({ ownerId, token }))) return res.status(409).json({ error: 'Polling tidak lagi berlaku.' });
    return res.json({ success: true });
  } catch (error) {
    console.error('Inactivity poll completion failed:', error.code || 'service error');
    return res.status(503).json({ error: 'Konfirmasi polling sementara tidak tersedia.' });
  }
});

app.post('/telegram/inactivity/poll-unsafe', botInternalRequired, async (req, res) => {
  if (!inactivityEnabled) return res.status(409).json({ error: 'Pemantauan tidak aktif.' });
  const ownerId = String(req.body.ownerId || '');
  const token = String(req.body.token || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(ownerId) || !/^[A-Za-z0-9_-]{22}$/.test(token)) {
    return res.status(400).json({ error: 'Token polling tidak valid.' });
  }
  try {
    if (!(await inactivityService.markPollUnsafe({ ownerId, token }))) return res.status(409).json({ error: 'Polling tidak lagi berlaku.' });
    console.error('Inactivity automatic purge suspended: polling requires review.');
    return res.json({ success: true });
  } catch (error) {
    console.error('Inactivity poll safety update failed:', error.code || 'service error');
    return res.status(503).json({ error: 'Pemeriksaan polling sementara tidak tersedia.' });
  }
});

app.post('/telegram/inactivity/poll-drained', botInternalRequired, async (req, res) => {
  if (!inactivityEnabled) return res.status(409).json({ error: 'Pemantauan tidak aktif.' });
  const token = String(req.body.token || '');
  const ownerId = String(req.body.ownerId || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(token) || !/^[A-Za-z0-9_-]{22}$/.test(ownerId)) return res.status(400).json({ error: 'Token polling tidak valid.' });
  try {
    const outcome = await inactivityService.confirmPollDrained({ ownerId, token });
    if (!outcome) return res.status(409).json({ error: 'Polling tidak lagi berlaku.' });
    if (outcome === 'new') {
      const result = await inactivityService.purgeEligible({ limit: 5 });
      if (result.purgeFailures || result.cacheInvalidationFailures) console.error('Some inactivity cleanup operations need retry.');
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Inactivity poll confirmation failed:', error.code || 'service error');
    return res.status(503).json({ error: 'Konfirmasi polling sementara tidak tersedia.' });
  }
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
  if (!isPrivateTelegramChat(telegramUserId, telegramChatId)) {
    return res.status(400).json({ error: 'Gunakan chat pribadi bot Budgetin dan /mulai atau /hubungkan_ulang.' });
  }

  const existingTelegramAccount = await findTelegramAccountByTelegramUserId(telegramUserId);
  const existingPhoneAccount = await findTelegramAccountByPhone(phoneNumber);

  const existingUser = await query('SELECT id FROM users WHERE phone_number = $1 LIMIT 1', [phoneNumber]);
  const ownerId = existingTelegramAccount?.user_id || existingUser.rows[0]?.id;
  if (ownerId && await isInactiveUser(ownerId)) return inactiveRequired(res);

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
      `UPDATE users u
       SET phone_number = $1
       WHERE id = $2 AND NOT ${inactiveConditionSql}
       RETURNING ${userReturnFields}`,
      [phoneNumber, existingTelegramAccount.user_id],
    );
    user = userResult.rows[0];
  } else {
    const userResult = await query(
      `INSERT INTO users AS u (phone_number, inactivity_enrolled_at)
       VALUES ($1, CASE WHEN $2 THEN clock_timestamp() ELSE NULL END)
       ON CONFLICT (phone_number) DO UPDATE SET phone_number = EXCLUDED.phone_number WHERE NOT ${inactiveConditionSql}
       RETURNING ${userReturnFields}`,
      [phoneNumber, inactivityEnabled],
    );
    user = userResult.rows[0];
  }

  if (!user) return inactiveRequired(res);

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

  const code = await createOtp(phoneNumber, user.id);
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

app.get('/telegram/transactions', botInternalRequired, validTransactionDateFilters, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const limit = Math.min(Number(req.query.limit || 10), 20);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const { where, params } = buildTransactionFilters(user.id, req.query);
  params.push(limit);
  params.push(offset);
  const result = await query(
    `SELECT id, type, amount::float AS amount, category, subcategory, note, created_at
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
  if (result.error) return res.status(result.status || 400).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
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

  await invalidateSummaryCache(user.id);
  res.json({ deleted_count: result.rowCount });
});

app.delete('/telegram/transactions/:id', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const result = await query(
    `DELETE FROM transactions
     WHERE id = $1 AND user_id = $2
     RETURNING id, type, amount::float AS amount, category, subcategory, note, created_at`,
    [req.params.id, user.id],
  );

  if (!result.rows[0]) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  await invalidateSummaryCache(user.id);
  res.json({ data: withCategoryLabels(result.rows)[0] });
});

app.get('/telegram/summary', botInternalRequired, validTransactionDateFilters, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  res.json({ data: await getSummaryForUser(user.id, req.query) });
});

app.get('/telegram/exports/transactions.csv', botInternalRequired, validTransactionDateFilters, async (req, res) => {
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
       AND t.created_at >= ${jakartaMonthStartSql}`,
  );

  res.json({
    data: {
      ...result.rows[0],
      active_users_this_month: activeThisMonth.rows[0].active_users_this_month,
    },
  });
});

app.get('/telegram/admin/pending-users', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 20);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const result = await query(
    `SELECT
       u.id,
       u.phone_number,
       u.display_name,
       u.created_at,
       ta.telegram_user_id,
       ta.telegram_chat_id,
       ta.username,
       ta.first_name
     FROM users u
     JOIN telegram_accounts ta ON ta.user_id = u.id
     WHERE u.is_admin = FALSE
       AND u.is_verified = FALSE
       AND u.is_blocked = FALSE
       AND u.is_deleted = FALSE
     ORDER BY u.created_at ASC
     LIMIT $1
     OFFSET $2`,
    [limit + 1, offset],
  );

  const rows = result.rows.slice(0, limit);
  res.json({
    data: rows.map((row) => ({
      id: row.id,
      phone_number: row.phone_number,
      display_name: row.display_name,
      created_at: row.created_at,
      telegram_user_id: row.telegram_user_id,
      telegram_chat_id: row.telegram_chat_id,
      username: row.username,
      first_name: row.first_name,
    })),
    pagination: {
      limit,
      offset,
      has_next_page: result.rows.length > limit,
    },
  });
});

app.get('/telegram/admin/users', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const status = normalizeInput(req.query.status);
  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 20);
  const offset = Math.max(Number(req.query.offset || 0), 0);

  const statusConfig = {
    pending: {
      where: 'u.is_admin = FALSE AND u.is_verified = FALSE AND u.is_blocked = FALSE AND u.is_deleted = FALSE',
      extraSelect: 'u.created_at, NULL::timestamptz AS verified_at, NULL::timestamptz AS blocked_at, NULL::timestamptz AS deleted_at, NULL::timestamptz AS delete_recovery_until',
      orderBy: 'u.created_at ASC',
    },
    verified: {
      where: 'u.is_admin = FALSE AND u.is_verified = TRUE AND u.is_blocked = FALSE AND u.is_deleted = FALSE',
      extraSelect: 'u.created_at, u.verified_at, NULL::timestamptz AS blocked_at, NULL::timestamptz AS deleted_at, NULL::timestamptz AS delete_recovery_until',
      orderBy: 'u.verified_at DESC NULLS LAST, u.created_at DESC',
    },
    blocked: {
      where: 'u.is_admin = FALSE AND u.is_blocked = TRUE AND u.is_deleted = FALSE',
      extraSelect: 'u.created_at, u.verified_at, u.blocked_at, NULL::timestamptz AS deleted_at, NULL::timestamptz AS delete_recovery_until',
      orderBy: 'u.blocked_at DESC NULLS LAST, u.created_at DESC',
    },
    nonaktif: {
      where: 'u.is_admin = FALSE AND u.is_deleted = TRUE',
      extraSelect: 'u.created_at, u.verified_at, u.blocked_at, u.deleted_at, u.delete_recovery_until',
      orderBy: 'u.deleted_at DESC NULLS LAST, u.created_at DESC',
    },
  };

  const config = statusConfig[status];
  if (!config) {
    return res.status(400).json({ error: 'status must be pending, verified, blocked, or nonaktif' });
  }

  const result = await query(
    `SELECT
       u.id,
       u.phone_number,
       u.display_name,
       ${config.extraSelect},
       ta.telegram_user_id,
       ta.telegram_chat_id,
       ta.username,
       ta.first_name
     FROM users u
     JOIN telegram_accounts ta ON ta.user_id = u.id
     WHERE ${config.where}
     ORDER BY ${config.orderBy}
     LIMIT $1
     OFFSET $2`,
    [limit + 1, offset],
  );

  const rows = result.rows.slice(0, limit);
  res.json({
    data: rows.map((row) => ({
      id: row.id,
      phone_number: row.phone_number,
      display_name: row.display_name,
      created_at: row.created_at,
      verified_at: row.verified_at,
      blocked_at: row.blocked_at,
      deleted_at: row.deleted_at,
      delete_recovery_until: row.delete_recovery_until,
      telegram_user_id: row.telegram_user_id,
      telegram_chat_id: row.telegram_chat_id,
      username: row.username,
      first_name: row.first_name,
    })),
    pagination: {
      limit,
      offset,
      has_next_page: result.rows.length > limit,
    },
  });
});

app.get('/telegram/admin/verified-users', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 20);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const result = await query(
    `SELECT
       u.id,
       u.phone_number,
       u.display_name,
       u.verified_at,
       u.created_at,
       ta.telegram_user_id,
       ta.telegram_chat_id,
       ta.username,
       ta.first_name
     FROM users u
     JOIN telegram_accounts ta ON ta.user_id = u.id
     WHERE u.is_admin = FALSE
       AND u.is_verified = TRUE
       AND u.is_blocked = FALSE
       AND u.is_deleted = FALSE
     ORDER BY u.verified_at DESC NULLS LAST, u.created_at DESC
     LIMIT $1
     OFFSET $2`,
    [limit + 1, offset],
  );

  const rows = result.rows.slice(0, limit);
  res.json({
    data: rows.map((row) => ({
      id: row.id,
      phone_number: row.phone_number,
      display_name: row.display_name,
      verified_at: row.verified_at,
      created_at: row.created_at,
      telegram_user_id: row.telegram_user_id,
      telegram_chat_id: row.telegram_chat_id,
      username: row.username,
      first_name: row.first_name,
    })),
    pagination: {
      limit,
      offset,
      has_next_page: result.rows.length > limit,
    },
  });
});

app.get('/telegram/admin/blocked-users', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 20);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const result = await query(
    `SELECT
       u.id,
       u.phone_number,
       u.display_name,
       u.blocked_at,
       u.created_at,
       ta.telegram_user_id,
       ta.telegram_chat_id,
       ta.username,
       ta.first_name
     FROM users u
     JOIN telegram_accounts ta ON ta.user_id = u.id
     WHERE u.is_admin = FALSE
       AND u.is_blocked = TRUE
       AND u.is_deleted = FALSE
     ORDER BY u.blocked_at DESC NULLS LAST, u.created_at DESC
     LIMIT $1
     OFFSET $2`,
    [limit + 1, offset],
  );

  const rows = result.rows.slice(0, limit);
  res.json({
    data: rows.map((row) => ({
      id: row.id,
      phone_number: row.phone_number,
      display_name: row.display_name,
      blocked_at: row.blocked_at,
      created_at: row.created_at,
      telegram_user_id: row.telegram_user_id,
      telegram_chat_id: row.telegram_chat_id,
      username: row.username,
      first_name: row.first_name,
    })),
    pagination: {
      limit,
      offset,
      has_next_page: result.rows.length > limit,
    },
  });
});

app.get('/telegram/admin/platform-summary', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const threshold = 5;
  const userStats = await query(
    `SELECT
       COUNT(*)::int AS total_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE)::int AS regular_users,
       COUNT(*) FILTER (WHERE is_admin = TRUE)::int AS admin_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_verified = TRUE AND is_blocked = FALSE AND is_deleted = FALSE)::int AS verified_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_verified = FALSE AND is_blocked = FALSE AND is_deleted = FALSE)::int AS pending_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_blocked = TRUE AND is_deleted = FALSE)::int AS blocked_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND is_deleted = TRUE)::int AS deleted_users,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND created_at >= ${jakartaDayStartSql})::int AS new_users_today,
       COUNT(*) FILTER (WHERE is_admin = FALSE AND created_at >= NOW() - INTERVAL '7 days')::int AS new_users_this_week
     FROM users`,
  );
  const counts = await query(
    `SELECT
       COUNT(*) FILTER (WHERE t.created_at >= ${jakartaDayStartSql})::int AS transactions_today,
       COUNT(*) FILTER (WHERE t.created_at >= NOW() - INTERVAL '7 days')::int AS transactions_this_week,
       COUNT(*)::int AS total_transactions,
       COUNT(*) FILTER (WHERE t.created_at >= ${jakartaMonthStartSql})::int AS transactions_this_month,
       COUNT(DISTINCT t.user_id) FILTER (WHERE t.created_at >= ${jakartaDayStartSql})::int AS active_users_today,
       COUNT(DISTINCT t.user_id) FILTER (WHERE t.created_at >= NOW() - INTERVAL '7 days')::int AS active_users_this_week,
       COUNT(DISTINCT t.user_id) FILTER (WHERE t.created_at >= ${jakartaMonthStartSql})::int AS active_users_this_month
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE u.is_admin = FALSE
       AND u.is_deleted = FALSE`,
  );

  const attention = await query(
    `SELECT
       COUNT(*) FILTER (
         WHERE u.is_admin = FALSE
           AND u.is_verified = TRUE
           AND u.is_blocked = FALSE
           AND u.is_deleted = FALSE
           AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = u.id)
       )::int AS verified_without_transactions,
       COUNT(*) FILTER (
         WHERE u.is_admin = FALSE
           AND u.is_deleted = TRUE
           AND u.delete_recovery_until IS NOT NULL
           AND u.delete_recovery_until > NOW()
       )::int AS recovering_users
     FROM users u`,
  );

  const base = {
    ...userStats.rows[0],
    ...counts.rows[0],
    ...attention.rows[0],
  };
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
       AND t.created_at >= ${jakartaMonthStartSql}`,
  );

  const topExpenseCategory = await query(
    `SELECT t.category, COALESCE(SUM(t.amount), 0)::float AS total
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     WHERE u.is_admin = FALSE
       AND u.is_deleted = FALSE
       AND t.type = 'expense'
       AND t.created_at >= ${jakartaMonthStartSql}
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

app.post('/telegram/admin/broadcast', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  const result = await query(
    `SELECT DISTINCT ON (u.id)
       ta.telegram_chat_id
     FROM users u
     JOIN telegram_accounts ta ON ta.user_id = u.id
     WHERE u.is_admin = FALSE
       AND u.is_blocked = FALSE
       AND u.is_deleted = FALSE
       AND ta.telegram_chat_id IS NOT NULL
       AND ta.telegram_chat_id <> ''
     ORDER BY u.id, ta.linked_at DESC`,
  );

  res.json({
    data: {
      telegram_chat_ids: result.rows.map((row) => row.telegram_chat_id),
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
  if (action === 'verify' && target.is_deleted) {
    return res.status(409).json({ error: 'Akun dinonaktifkan. Gunakan proses pemulihan akun.' });
  }
  if (action === 'block' && target.is_deleted) {
    return res.status(409).json({ error: 'Akun sudah dinonaktifkan.' });
  }
  if (action === 'restore' && !target.is_deleted) {
    return res.status(409).json({ error: 'Akun ini tidak sedang dinonaktifkan.' });
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
         WHERE id = $2 AND is_deleted = FALSE
         RETURNING ${userReturnFields}`,
        [admin.id, target.id],
      );
  } else if (action === 'restore') {
    try {
      result = await inTransaction(async (client) => {
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [target.id]);
        return client.query(
          `UPDATE users
           SET is_deleted = FALSE, is_blocked = FALSE, deleted_at = NULL,
             delete_recovery_until = NULL, blocked_at = NULL
           WHERE id = $1 AND is_deleted = TRUE
             AND delete_recovery_until IS NOT NULL AND delete_recovery_until > clock_timestamp()
           RETURNING ${userReturnFields}`,
          [target.id],
        );
      });
    } catch (error) {
      console.error('Account recovery failed:', error.code || 'database error');
      return res.status(500).json({ error: 'Akun belum dapat dipulihkan. Silakan coba lagi.' });
    }
  } else {
    result = await query(
        `UPDATE users
         SET is_blocked = TRUE,
           is_verified = FALSE,
           blocked_at = NOW()
         WHERE id = $1 AND is_deleted = FALSE
         RETURNING ${userReturnFields}`,
        [target.id],
      );
  }

  if (!result.rows[0]) return res.status(409).json({ error: 'Status akun berubah atau masa pemulihan sudah lewat.' });
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

  let outcome;
  try {
    outcome = await inTransaction(async (client) => {
      const lockedUser = await client.query('SELECT is_admin, is_deleted, is_blocked FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      const current = lockedUser.rows[0];
      if (!current || current.is_deleted || current.is_blocked) return { status: 409, error: 'Akun tidak aktif.' };
      if (requestType === 'account' && current.is_admin) return { status: 400, error: 'Akun admin tidak bisa dihapus lewat bot.' };
      const existing = await client.query(
        `SELECT id, request_code, request_type, status, scheduled_deletion_at, processed_at, decided_at, created_at
         FROM deletion_requests
         WHERE user_id = $1 AND request_type = $2
           AND (status = 'pending' OR (status = 'approved' AND processed_at IS NULL))
         ORDER BY created_at DESC LIMIT 1`,
        [user.id, requestType],
      );
      if (existing.rows[0]) {
        return { status: 409, error: `Permintaan ${deletionTypeLabel(requestType)} masih menunggu konfirmasi.`, request: deletionRequestPublicFields(existing.rows[0]) };
      }
      const result = await client.query(
        `INSERT INTO deletion_requests (
           request_code, user_id, request_type, requester_telegram_user_id, requester_chat_id, user_phone_number, user_display_name
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, request_code, request_type, status, user_phone_number, user_display_name, scheduled_deletion_at, processed_at, decided_at, created_at`,
        [generateRequestCode(), user.id, requestType, user.telegram_user_id, user.telegram_chat_id, user.phone_number, user.display_name || user.first_name || ''],
      );
      return { status: 201, request: deletionRequestPublicFields(result.rows[0]) };
    });
  } catch (error) {
    console.error('Deletion request creation failed:', error.code || 'database error');
    return res.status(500).json({ error: 'Permintaan belum dapat dibuat. Silakan coba lagi.' });
  }
  res.status(outcome.status).json({
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.request ? { request: outcome.request } : {}),
    ...await adminAccountsForNotification(),
  });
});

app.patch('/telegram/deletion-requests/:code', botInternalRequired, async (req, res) => {
  const user = await requireLinkedTelegramUser(req, res);
  if (!user) return;

  const action = req.body.action === 'confirm' ? 'confirm' : null;
  if (!action) {
    return res.status(400).json({ error: 'action must be confirm' });
  }

  let outcome;
  try {
    outcome = await inTransaction(async (client) => {
      const requestResult = await client.query(
        `SELECT * FROM deletion_requests
         WHERE request_code = $1 AND requester_telegram_user_id = $2
         LIMIT 1 FOR UPDATE`,
        [String(req.params.code || '').trim().toUpperCase(), user.telegram_user_id],
      );
      const deletionRequest = requestResult.rows[0];
      if (!deletionRequest) return { status: 404, error: 'Permintaan hapus tidak ditemukan' };
      if (deletionRequest.request_type !== 'account') return { status: 400, error: 'Konfirmasi otomatis hanya untuk hapus akun.' };
      if (deletionRequest.user_id !== user.id) return { status: 403, error: 'Request ini bukan milik akun kamu.' };
      if (deletionRequest.status !== 'pending' || deletionRequest.processed_at) {
        return { status: 409, error: 'Permintaan ini sudah selesai diproses.', request: deletionRequestPublicFields(deletionRequest) };
      }
      const deletedUser = await client.query(
        `UPDATE users
         SET is_deleted = TRUE, is_blocked = TRUE, deleted_at = NOW(),
           delete_recovery_until = NOW() + INTERVAL '2 days', blocked_at = NOW()
         WHERE id = $1 AND is_admin = FALSE AND is_deleted = FALSE AND is_blocked = FALSE
         RETURNING ${userReturnFields}`,
        [user.id],
      );
      if (!deletedUser.rows[0]) return { status: 409, error: 'Akun tidak dapat dinonaktifkan. Hubungi admin Budgetin.' };
      const processed = await client.query(
        `UPDATE deletion_requests
         SET status = 'approved', scheduled_deletion_at = NOW(), processed_at = NOW(), decided_at = NOW()
         WHERE id = $1 RETURNING *`,
        [deletionRequest.id],
      );
      return { request: deletionRequestPublicFields(processed.rows[0]), user: deletedUser.rows[0] };
    });
  } catch (error) {
    console.error('Account deletion confirmation failed:', error.code || 'database error');
    return res.status(500).json({ error: 'Permintaan belum dapat diproses. Silakan coba lagi.' });
  }
  if (outcome.error) return res.status(outcome.status).json(outcome);
  await invalidateSummaryCache(user.id);

  res.json({
    request: outcome.request,
    user: outcome.user,
    telegram: {
      telegram_user_id: user.telegram_user_id,
      telegram_chat_id: user.telegram_chat_id,
      username: user.username,
      first_name: user.first_name,
    },
    ...await adminAccountsForNotification(),
  });
});

app.patch('/telegram/admin/deletion-requests/:code', botInternalRequired, async (req, res) => {
  const admin = await requireAdminTelegramUser(req, res);
  if (!admin) return;

  const action = req.body.action === 'approve' ? 'approve' : req.body.action === 'reject' ? 'reject' : null;
  if (!action) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  let outcome;
  try {
    outcome = await inTransaction(async (client) => {
      const requestResult = await client.query(
        'SELECT * FROM deletion_requests WHERE request_code = $1 LIMIT 1 FOR UPDATE',
        [String(req.params.code || '').trim().toUpperCase()],
      );
      const deletionRequest = requestResult.rows[0];
      if (!deletionRequest) return { status: 404, error: 'Permintaan hapus tidak ditemukan' };
      if (deletionRequest.status !== 'pending') {
        return { status: 409, error: `Permintaan ini sudah ${deletionRequest.status}.`, request: deletionRequest };
      }

      let deletedCount = 0;
      if (action === 'approve') {
        if (!deletionRequest.user_id) return { status: 409, error: 'Akun pemilik permintaan tidak ditemukan.' };
        if (deletionRequest.request_type === 'account') {
          const deleteResult = await client.query(
            `UPDATE users
             SET is_deleted = TRUE, is_blocked = TRUE, deleted_at = NOW(),
               delete_recovery_until = NOW() + INTERVAL '2 days', blocked_at = NOW()
             WHERE id = $1 AND is_admin = FALSE AND is_deleted = FALSE
             RETURNING id`,
            [deletionRequest.user_id],
          );
          if (!deleteResult.rowCount) return { status: 409, error: 'Akun tidak dapat dinonaktifkan.' };
          deletedCount = deleteResult.rowCount;
        } else if (deletionRequest.request_type === 'all_transactions') {
          const owner = await client.query('SELECT is_deleted, is_blocked FROM users WHERE id = $1 FOR UPDATE', [deletionRequest.user_id]);
          if (!owner.rows[0] || owner.rows[0].is_deleted || owner.rows[0].is_blocked) {
            return { status: 409, error: 'Akun tidak aktif; transaksi tidak dihapus.' };
          }
          const deleteResult = await client.query('DELETE FROM transactions WHERE user_id = $1 RETURNING id', [deletionRequest.user_id]);
          deletedCount = deleteResult.rowCount;
        } else {
          return { status: 400, error: 'Jenis permintaan tidak didukung.' };
        }
      }

      const status = action === 'approve' ? 'approved' : 'rejected';
      const updated = await client.query(
        `UPDATE deletion_requests
         SET status = $1, admin_user_id = $2, decided_at = NOW()
         WHERE id = $3 RETURNING *`,
        [status, admin.id, deletionRequest.id],
      );
      return { request: updated.rows[0], deleted_count: deletedCount, userId: action === 'approve' ? deletionRequest.user_id : null };
    });
  } catch (error) {
    console.error('Admin deletion decision failed:', error.code || 'database error');
    return res.status(500).json({ error: 'Permintaan belum dapat diproses. Silakan coba lagi.' });
  }
  if (outcome.error) return res.status(outcome.status).json(outcome);
  if (outcome.userId) await invalidateSummaryCache(outcome.userId);

  res.json({
    request: outcome.request,
    deleted_count: outcome.deleted_count,
  });
});

app.get('/categories', authRequired, webFeatureRequired, async (req, res) => {
  res.json({ data: CATEGORY_DEFINITIONS, custom: await listCustomSubcategories(req.user.id) });
});

app.post('/categories', authRequired, webFeatureRequired, async (req, res) => {
  const result = await createCustomSubcategory(req.user.id, req.body);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(201).json(result);
});

app.delete('/categories/:id', authRequired, webFeatureRequired, async (req, res) => {
  const result = await deleteCustomSubcategory(req.user.id, req.params.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result);
});

app.get('/transactions', authRequired, webFeatureRequired, validTransactionDateFilters, async (req, res) => {
  const requestedLimit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
    return res.status(400).json({ error: 'limit dan offset harus berupa bilangan bulat yang valid' });
  }
  const limit = Math.min(requestedLimit, 500);
  const { where, params } = buildTransactionFilters(req.user.id, req.query);
  params.push(limit);
  const limitIndex = params.length;
  params.push(offset);
  const result = await query(
    `SELECT id, type, amount::float AS amount, category, subcategory, note, created_at
     FROM transactions
     WHERE ${where}
     ORDER BY ${transactionOrder(req.query.sort)}
     LIMIT $${limitIndex} OFFSET $${params.length}`,
    params,
  );
  res.json({ data: withCategoryLabels(result.rows) });
});

app.post('/transactions', authRequired, webFeatureRequired, async (req, res) => {
  const result = await createTransactionForUser(req.user.id, req.body);
  if (result.error) return res.status(result.status || 400).json({ error: result.error, ...(result.code ? { code: result.code } : {}) });
  res.status(201).json(result);
});

app.patch('/transactions/:id', authRequired, webFeatureRequired, async (req, res) => {
  const result = await updateTransactionForUser(req.user.id, req.params.id, req.body);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result);
});

app.delete('/transactions/:id', authRequired, webFeatureRequired, async (req, res) => {
  const result = await query(
    `DELETE FROM transactions
     WHERE id = $1 AND user_id = $2
     RETURNING id, type, amount::float AS amount, category, subcategory, note, created_at`,
    [req.params.id, req.user.id],
  );

  if (!result.rows[0]) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  await invalidateSummaryCache(req.user.id);
  res.json({ data: withCategoryLabels(result.rows)[0] });
});

app.get('/analytics/summary', authRequired, webFeatureRequired, async (req, res) => {
  res.json({ data: await getSummaryForUser(req.user.id) });
});

app.get('/exports/transactions.csv', authRequired, webFeatureRequired, validTransactionDateFilters, async (req, res) => {
  const csv = await buildTransactionsCsv(req.user.id, req.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(req.query)}"`);
  res.send(csv);
});

async function seedDefaultCategories(userId) {
  void userId;
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  redis.connect().catch((error) => console.error('Redis connect failed:', error.message));
  otpRedis.connect().catch((error) => console.error('OTP rate limit Redis connect failed:', error.message));
  if (!runtimeConfig.production) {
    console.warn('Production secret validation is inactive; set NODE_ENV=production or COOKIE_SECURE=true for production.');
  }
  ensureDatabaseSchema()
  .then(() => ensureInactivitySchema(pool))
  .then(() => inactivityEnabled ? inactivityService.resetPollingHealth() : undefined)
  .then(() => {
    app.listen(port, () => {
      console.log(`Budgetin API listening on ${port}`);
    });
    processDueAccountDeletionRequests().catch((error) => console.error('Deletion worker failed:', error.message));
    runInactivityWorker();
    cleanupRefreshTokens().catch((error) => console.error('Refresh token cleanup failed:', error.message));
    setInterval(() => {
      processDueAccountDeletionRequests().catch((error) => console.error('Deletion worker failed:', error.message));
    }, 60_000);
    setInterval(runInactivityWorker, 60_000);
    setInterval(() => {
      cleanupRefreshTokens().catch((error) => console.error('Refresh token cleanup failed:', error.message));
    }, 60 * 60 * 1000);
  })
  .catch((error) => {
    console.error('Failed to prepare database schema:', error);
    process.exit(1);
  });
}
