import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN;
const backendUrl = process.env.BACKEND_URL || 'http://backend:4000';
const botInternalToken = process.env.BOT_INTERNAL_TOKEN || 'budgetin_internal_dev_token';

let offset = 0;
const lastTransactionsByChat = new Map();

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
        if (update.message?.contact) await handleContact(update.message);
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
        'Untuk register/login web, share nomor Telegram kamu dulu.',
        'Tambah pengeluaran: /add 50000 food makan siang',
        'Tambah pemasukan: /income 250000 salary freelance',
        'Cek ringkasan: /summary',
        'Transaksi terakhir: /last',
        'Hapus transaksi: /delete 1',
        'Nama dashboard: /nama Roy',
        'Export CSV: /export atau /export transport 2026-04',
      ].join('\n'),
      {
        reply_markup: {
          keyboard: [[{ text: 'Share Phone Number', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      },
    );
  }

  if (text === '/summary') {
    return sendSummary(message);
  }

  if (text.startsWith('/export')) {
    return sendExport(message, text);
  }

  if (text === '/last') {
    return sendLastTransactions(message);
  }

  if (text.startsWith('/delete')) {
    return deleteTransaction(message, text);
  }

  if (text.startsWith('/nama') || text.startsWith('/setname')) {
    return updateDisplayName(message, text);
  }

  const parsed = parseCommand(text);
  if (!parsed) {
    return sendMessage(chatId, 'Format belum sesuai. Contoh: /add 50000 food makan siang');
  }

  try {
    const response = await fetch(`${backendUrl}/telegram/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': botInternalToken,
      },
      body: JSON.stringify({ ...parsed, telegram_user_id: String(message.from.id) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal menyimpan transaksi');
    return sendMessage(chatId, `Tersimpan: ${body.data.type} ${formatIdr(body.data.amount)} ${body.data.category_label}`);
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function updateDisplayName(message, text) {
  const chatId = message.chat.id;
  const [, ...nameParts] = text.trim().split(/\s+/);
  const displayName = nameParts.join(' ').trim();

  if (!displayName) {
    return sendMessage(chatId, 'Tulis nama dashboard. Contoh: /nama Roy');
  }

  try {
    const response = await fetch(`${backendUrl}/telegram/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': botInternalToken,
      },
      body: JSON.stringify({
        telegram_user_id: String(message.from.id),
        display_name: displayName,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengubah nama dashboard');

    return sendMessage(chatId, `Nama dashboard diubah menjadi ${body.user.display_name}.`);
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function handleContact(message) {
  const contact = message.contact;
  const chatId = message.chat.id;

  if (contact.user_id && contact.user_id !== message.from.id) {
    return sendMessage(chatId, 'Kirim nomor Telegram milik kamu sendiri untuk menghubungkan akun.');
  }

  try {
    const response = await fetch(`${backendUrl}/telegram/contact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': botInternalToken,
      },
      body: JSON.stringify({
        phone_number: contact.phone_number,
        telegram_user_id: String(message.from.id),
        telegram_chat_id: String(chatId),
        username: message.from.username || '',
        first_name: message.from.first_name || '',
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal menghubungkan akun');

    return sendMessage(
      chatId,
      [
        'Nomor Telegram sudah terhubung.',
        `Kode OTP Budgetin kamu: ${body.otp}`,
        'Kode berlaku 10 menit. Masukkan kode ini di halaman login web.',
      ].join('\n'),
      { reply_markup: { remove_keyboard: true } },
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendExport(message, text) {
  const chatId = message.chat.id;
  try {
    const params = parseExportCommand(text);
    params.set('telegram_user_id', String(message.from.id));
    const query = params.toString();
    const response = await fetch(`${backendUrl}/telegram/exports/transactions.csv?${query}`, {
      headers: { 'x-bot-token': botInternalToken },
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

async function sendLastTransactions(message) {
  const chatId = message.chat.id;
  try {
    const params = new URLSearchParams({
      telegram_user_id: String(message.from.id),
      limit: '10',
      sort: 'newest',
    });
    const response = await fetch(`${backendUrl}/telegram/transactions?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil transaksi');

    lastTransactionsByChat.set(String(chatId), body.data);
    if (!body.data.length) return sendMessage(chatId, 'Belum ada transaksi.');

    return sendMessage(
      chatId,
      body.data
        .map((item, index) => `${index + 1}. ${item.type} ${formatIdr(item.amount)} ${item.category_label} - ${item.note || '-'}`)
        .join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function deleteTransaction(message, text) {
  const chatId = message.chat.id;
  const [, numberRaw] = text.trim().split(/\s+/);
  const index = Number(numberRaw) - 1;
  const cached = lastTransactionsByChat.get(String(chatId)) || [];
  const transaction = cached[index];

  if (!transaction) {
    return sendMessage(chatId, 'Pilih nomor dari /last. Contoh: /delete 1');
  }

  try {
    const params = new URLSearchParams({ telegram_user_id: String(message.from.id) });
    const response = await fetch(`${backendUrl}/telegram/transactions/${transaction.id}?${params.toString()}`, {
      method: 'DELETE',
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal menghapus transaksi');

    lastTransactionsByChat.set(
      String(chatId),
      cached.filter((item) => item.id !== transaction.id),
    );
    return sendMessage(chatId, `Dihapus: ${body.data.type} ${formatIdr(body.data.amount)} ${body.data.category_label}`);
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendSummary(message) {
  const chatId = message.chat.id;
  try {
    const params = new URLSearchParams({ telegram_user_id: String(message.from.id) });
    const response = await fetch(`${backendUrl}/telegram/summary?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
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

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return telegram('sendMessage', { chat_id: chatId, text, ...extra });
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
