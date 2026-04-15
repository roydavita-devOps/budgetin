import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN;
const backendUrl = process.env.BACKEND_URL || 'http://backend:4000';
const email = process.env.BOT_USER_EMAIL || 'telegram@budgetin.local';
const password = process.env.BOT_USER_PASSWORD || 'telegram_password';

let offset = 0;
let jwtToken = '';

if (!token) {
  console.log('TELEGRAM_BOT_TOKEN is empty. Bot service is running idle.');
  setInterval(() => {}, 60_000);
} else {
  poll().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function poll() {
  console.log('Budgetin Telegram bot started.');
  while (true) {
    try {
      const updates = await telegram('getUpdates', { timeout: 25, offset });
      for (const update of updates.result || []) {
        offset = update.update_id + 1;
        if (update.message?.text) await handleMessage(update.message);
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await wait(3000);
    }
  }
}

async function handleMessage(message) {
  const text = message.text.trim();
  const chatId = message.chat.id;

  if (text === '/start' || text === '/help') {
    return sendMessage(
      chatId,
      [
        'Budgetin siap.',
        'Tambah pengeluaran: /add 50000 food makan siang',
        'Tambah pemasukan: /income 250000 salary freelance',
        'Cek ringkasan: /summary',
        'Export CSV: /export atau /export transport 2026-04',
      ].join('\n'),
    );
  }

  if (text === '/summary') {
    return sendSummary(chatId);
  }

  if (text.startsWith('/export')) {
    return sendExport(chatId, text);
  }

  const parsed = parseCommand(text);
  if (!parsed) {
    return sendMessage(chatId, 'Format belum sesuai. Contoh: /add 50000 food makan siang');
  }

  try {
    await ensureAuth();
    const response = await fetch(`${backendUrl}/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify(parsed),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal menyimpan transaksi');
    return sendMessage(chatId, `Tersimpan: ${parsed.type} ${parsed.amount} ${parsed.category}`);
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendExport(chatId, text) {
  try {
    await ensureAuth();
    const params = parseExportCommand(text);
    const query = params.toString();
    const response = await fetch(`${backendUrl}/exports/transactions.csv${query ? `?${query}` : ''}`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    const csv = await response.text();
    if (!response.ok) throw new Error(csv || 'Gagal export transaksi');

    const filenameParts = ['budgetin-export'];
    if (params.get('type')) filenameParts.push(params.get('type'));
    if (params.get('category')) filenameParts.push(params.get('category'));
    if (params.get('month')) filenameParts.push(params.get('month'));

    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('caption', 'Export transaksi Budgetin');
    formData.append('document', new Blob([csv], { type: 'text/csv' }), `${filenameParts.join('-')}.csv`);

    const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
    const body = await telegramResponse.json();
    if (!telegramResponse.ok || !body.ok) throw new Error(body.description || 'Telegram gagal mengirim file');
    return body;
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendSummary(chatId) {
  try {
    await ensureAuth();
    const response = await fetch(`${backendUrl}/analytics/summary`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil summary');

    const { income, expense, balance } = body.data;
    return sendMessage(
      chatId,
      [
        'Ringkasan Budgetin',
        `Income: ${formatIdr(income)}`,
        `Expense: ${formatIdr(expense)}`,
        `Balance: ${formatIdr(balance)}`,
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

function parseCommand(text) {
  const [command, amountRaw, category, ...noteParts] = text.split(/\s+/);
  const amount = Number(amountRaw);

  if (!['/add', '/expense', '/income'].includes(command)) return null;
  if (!Number.isFinite(amount) || amount <= 0 || !category) return null;

  return {
    type: command === '/income' ? 'income' : 'expense',
    amount,
    category,
    note: noteParts.join(' '),
  };
}

function parseExportCommand(text) {
  const [, ...args] = text.trim().split(/\s+/);
  const params = new URLSearchParams();
  const filters = new Set(['income', 'expense']);
  const categories = new Set(['food_drink', 'transport', 'other_expense', 'salary', 'freelance']);
  const aliases = {
    makan: 'food_drink',
    minum: 'food_drink',
    food: 'food_drink',
    drink: 'food_drink',
    bensin: 'transport',
    kendaraan: 'transport',
    gaji: 'salary',
    salary: 'salary',
    project: 'freelance',
  };

  for (const rawArg of args) {
    const arg = rawArg.toLowerCase();
    if (/^\d{4}-\d{2}$/.test(arg)) {
      params.set('month', arg);
    } else if (filters.has(arg)) {
      params.set('type', arg);
    } else if (categories.has(arg)) {
      params.set('category', arg);
    } else if (aliases[arg]) {
      params.set('category', aliases[arg]);
    }
  }

  return params;
}

async function ensureAuth() {
  if (jwtToken) return;

  const login = await auth('login');
  if (login.ok) {
    jwtToken = login.body.token;
    return;
  }

  const register = await auth('register');
  if (!register.ok) throw new Error(register.body.error || 'Bot auth failed');
  jwtToken = register.body.token;
}

async function auth(mode) {
  const response = await fetch(`${backendUrl}/auth/${mode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { ok: response.ok, body: await response.json() };
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function sendMessage(chatId, text) {
  return telegram('sendMessage', { chat_id: chatId, text });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatIdr(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value || 0);
}
