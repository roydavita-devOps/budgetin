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

  const command = firstCommand(text);

  if (['/start', '/mulai'].includes(command)) {
    return sendStartMessage(message);
  }

  if (['/help', '/bantuan'].includes(command)) {
    return sendHelpMessage(chatId);
  }

  if (['/hubungkan_ulang', '/relink'].includes(command)) {
    return requestPhoneNumber(chatId, [
      'Kirim ulang nomor Telegram kamu.',
      '',
      'Ini hanya untuk mengganti nomor pada akun Telegram yang sama.',
      'Data tidak akan dipindahkan ke akun Telegram berbeda.',
    ]);
  }

  if (['/summary', '/ringkasan'].includes(command)) {
    return sendSummary(message);
  }

  if (command === '/export') {
    return sendExport(message, text);
  }

  if (['/last', '/terakhir'].includes(command)) {
    return sendLastTransactions(message);
  }

  if (['/riwayat', '/history'].includes(command)) {
    return sendTransactionHistory(message, text);
  }

  if (['/delete', '/hapus'].includes(command)) {
    return deleteTransaction(message, text);
  }

  if (['/hapus_akun', '/delete_account'].includes(command)) {
    return requestDeletion(message, 'account');
  }

  if (['/konfirmasi_hapus_akun', '/confirm_delete_account'].includes(command)) {
    return confirmAccountDeletion(message, text);
  }

  if (['/batal_hapus_akun', '/cancel_delete_account'].includes(command)) {
    return cancelAccountDeletion(message, text);
  }

  if (['/hapus_semua', '/delete_all'].includes(command)) {
    return requestDeletion(message, 'all_transactions');
  }

  if (['/konfirmasi_hapus_semua', '/confirm_delete_all'].includes(command)) {
    return sendMessage(chatId, 'Sekarang hapus semua transaksi harus lewat persetujuan admin. Ketik /hapus_semua untuk membuat permintaan.');
  }

  if (['/admin_setujui_hapus', '/admin_approve_delete'].includes(command)) {
    return decideDeletionRequest(message, text, 'approve');
  }

  if (['/admin_tolak_hapus', '/admin_reject_delete'].includes(command)) {
    return decideDeletionRequest(message, text, 'reject');
  }

  if (['/nama', '/setname'].includes(command)) {
    return updateDisplayName(message, text);
  }

  const parsed = parseCommand(text);
  if (parsed.error) {
    return sendMessage(chatId, commandErrorMessage(parsed.error));
  }

  try {
    const response = await fetch(`${backendUrl}/telegram/transactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': botInternalToken,
      },
      body: JSON.stringify({ ...parsed.value, telegram_user_id: String(message.from.id) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal menyimpan transaksi');
    return sendMessage(chatId, `Tersimpan: ${body.data.type} ${formatIdr(body.data.amount)} ${body.data.category_label}`);
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendStartMessage(message) {
  const chatId = message.chat.id;

  try {
    const account = await fetchTelegramAccount(message.from.id);
    if (account) {
      const name = account.display_name || account.first_name || message.from.first_name || 'teman Budgetin';
      return sendMessage(
        chatId,
        [
          `Halo ${name}, Telegram kamu sudah terhubung ke Budgetin.`,
          '',
          'Kamu sudah bisa langsung mencatat transaksi.',
          '',
          'Contoh:',
          '/makan nasi padang 18000',
          '/gaji april 7000000',
          '',
          'Ketik /bantuan untuk melihat semua command.',
          'Kalau kamu ganti nomor Telegram, ketik /hubungkan_ulang.',
        ].join('\n'),
        { reply_markup: { remove_keyboard: true } },
      );
    }
  } catch (error) {
    return sendMessage(chatId, `Gagal cek akun: ${error.message}`);
  }

  return requestPhoneNumber(chatId, [
    'Budgetin siap membantu.',
    '',
    'Sebelum mulai:',
    'Tekan tombol Share Phone Number supaya Telegram kamu terhubung ke dashboard web.',
    '',
    'Setelah terhubung, kamu tidak perlu share nomor lagi saat mengetik /mulai.',
  ]);
}

async function fetchTelegramAccount(telegramUserId) {
  const params = new URLSearchParams({ telegram_user_id: String(telegramUserId) });
  const response = await fetch(`${backendUrl}/telegram/account?${params.toString()}`, {
    headers: { 'x-bot-token': botInternalToken },
  });

  if (response.status === 404) return null;

  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Gagal cek akun Telegram');
  return body.user;
}

function sendHelpMessage(chatId) {
  return sendMessage(
    chatId,
    [
      'Command Budgetin:',
      '',
      'Catatan nominal:',
      'Tulis nominal di bagian paling belakang.',
      'Jangan pakai titik, koma, atau Rp.',
      'Benar: 50000',
      'Salah: Rp50.000',
      '',
      'Catat pengeluaran:',
      '',
      '/makan nasi padang 18000',
      'Catat pengeluaran makan/minum sebesar Rp18.000.',
      '',
      '/minum kopi 15000',
      'Catat pengeluaran minuman sebesar Rp15.000.',
      '',
      '/bensin isi bensin motor 50000',
      'Catat pengeluaran transportasi sebesar Rp50.000.',
      '',
      '/transport gojek ke kantor 22000',
      'Catat pengeluaran transportasi sebesar Rp22.000.',
      '',
      '/lain beli kabel charger 25000',
      'Catat pengeluaran lain-lain sebesar Rp25.000.',
      '',
      'Catat pemasukan:',
      '',
      '/gaji april 7000000',
      'Catat pemasukan gaji pokok sebesar Rp7.000.000.',
      '',
      '/freelance desain logo 250000',
      'Catat pemasukan freelance sebesar Rp250.000.',
      '',
      '/ringkasan',
      'Lihat total pemasukan, pengeluaran, dan saldo.',
      '',
      '/terakhir',
      'Lihat 10 transaksi terbaru. Nomor dari daftar ini bisa dipakai untuk hapus transaksi.',
      '',
      '/riwayat',
      'Lihat riwayat transaksi per 10 data. Ketik /riwayat 2 untuk halaman berikutnya.',
      '',
      '/hapus 1',
      'Hapus transaksi nomor 1 dari daftar /terakhir.',
      '',
      '/hapus_semua',
      'Ajukan permintaan hapus semua transaksi ke admin.',
      '',
      '/hapus_akun',
      'Ajukan hapus akun otomatis. Akun dihapus 24 jam setelah konfirmasi.',
      '',
      '/batal_hapus_akun KODE',
      'Batalkan hapus akun sebelum 24 jam.',
      '',
      '/nama Roy',
      'Ubah nama dashboard menjadi "Dashboard milik Roy".',
      '',
      '/export',
      'Download semua transaksi ke file CSV.',
      '',
      '/export makan 2026-04',
      'Download transaksi makan untuk April 2026.',
      '',
      '/hubungkan_ulang',
      'Kirim ulang nomor Telegram jika nomor kamu berubah.',
    ].join('\n'),
    { reply_markup: { remove_keyboard: true } },
  );
}

function requestPhoneNumber(chatId, lines) {
  return sendMessage(chatId, lines.join('\n'), {
    reply_markup: {
      keyboard: [[{ text: 'Share Phone Number', request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
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
    formData.append('caption', 'File export transaksi Budgetin');
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
      [
        '10 transaksi terbaru:',
        'Nomor di daftar ini bisa dipakai untuk /hapus.',
        '',
        formatTransactions(body.data, 0),
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendTransactionHistory(message, text) {
  const chatId = message.chat.id;
  const page = parsePageNumber(text);
  const limit = 10;
  const offset = (page - 1) * limit;

  try {
    const params = new URLSearchParams({
      telegram_user_id: String(message.from.id),
      limit: String(limit),
      offset: String(offset),
      sort: 'newest',
    });
    const response = await fetch(`${backendUrl}/telegram/transactions?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil riwayat transaksi');

    if (!body.data.length) {
      return sendMessage(chatId, page === 1 ? 'Belum ada transaksi.' : `Tidak ada transaksi di halaman ${page}.`);
    }

    const nextHint = body.data.length === limit ? `\n\nKetik /riwayat ${page + 1} untuk halaman berikutnya.` : '';
    return sendMessage(
      chatId,
      [
        `Riwayat transaksi halaman ${page}`,
        `Menampilkan data ${offset + 1}-${offset + body.data.length}.`,
        '',
        formatTransactions(body.data, offset),
      ].join('\n') + nextHint,
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
    return sendMessage(chatId, 'Pilih nomor dari /terakhir. Contoh: /hapus 1');
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
    return sendMessage(chatId, `Dihapus: ${labelType(body.data.type)} ${formatIdr(body.data.amount)} ${body.data.category_label}`);
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function requestDeletion(message, requestType) {
  const chatId = message.chat.id;

  try {
    const response = await fetch(`${backendUrl}/telegram/deletion-requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': botInternalToken,
      },
      body: JSON.stringify({
        telegram_user_id: String(message.from.id),
        request_type: requestType,
      }),
    });
    const body = await response.json();
    if (!response.ok && response.status !== 409) throw new Error(body.error || 'Gagal membuat permintaan hapus');

    if (requestType === 'account') {
      return sendAccountDeletionRequestMessage(chatId, body.request, response.status === 409 ? body.error : '');
    }

    if (response.ok) {
      await notifyAdminsAboutDeletionRequest(body.request, body.admins || []);
    }

    const pendingText = response.status === 409 ? body.error : `Permintaan ${deletionTypeLabel(requestType)} sudah dikirim ke admin.`;
    const adminText = body.admins?.length ? 'Admin akan memproses setelah verifikasi.' : 'Belum ada admin Telegram aktif. Pastikan admin sudah /mulai dan share nomor.';
    return sendMessage(
      chatId,
      [
        pendingText,
        `Kode request: ${body.request.request_code}`,
        '',
        'Data kamu belum dihapus.',
        adminText,
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

function sendAccountDeletionRequestMessage(chatId, request, existingMessage = '') {
  const code = request.request_code;
  const title = existingMessage || 'Permintaan hapus akun dibuat.';
  const scheduledText = request.scheduled_deletion_at
    ? `Akun sudah dijadwalkan terhapus otomatis pada ${formatDateTime(request.scheduled_deletion_at)}.`
    : 'Akun belum dijadwalkan terhapus.';

  return sendHtmlMessage(
    chatId,
    [
      escapeHtml(title),
      '',
      'Kode konfirmasi:',
      `<code>${escapeHtml(code)}</code>`,
      '',
      escapeHtml(scheduledText),
      'Data kamu belum dihapus.',
      '',
      'Untuk melanjutkan, copy command ini:',
      `<code>/konfirmasi_hapus_akun ${escapeHtml(code)}</code>`,
      '',
      'Setelah dikonfirmasi, akun akan dihapus otomatis dalam 24 jam.',
      '',
      'Kalau berubah pikiran, copy command ini sebelum 24 jam:',
      `<code>/batal_hapus_akun ${escapeHtml(code)}</code>`,
    ].join('\n'),
  );
}

async function confirmAccountDeletion(message, text) {
  return updateAccountDeletionRequest(message, text, 'confirm');
}

async function cancelAccountDeletion(message, text) {
  return updateAccountDeletionRequest(message, text, 'cancel');
}

async function updateAccountDeletionRequest(message, text, action) {
  const chatId = message.chat.id;
  const [, codeRaw] = text.trim().split(/\s+/);
  const code = String(codeRaw || '').trim().toUpperCase();

  if (!code) {
    const example = action === 'confirm' ? '/konfirmasi_hapus_akun A1B2C3D4' : '/batal_hapus_akun A1B2C3D4';
    return sendMessage(chatId, `Tulis kode request. Contoh: ${example}`);
  }

  try {
    const response = await fetch(`${backendUrl}/telegram/deletion-requests/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': botInternalToken,
      },
      body: JSON.stringify({
        telegram_user_id: String(message.from.id),
        action,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal memproses hapus akun');

    if (action === 'cancel') {
      return sendMessage(chatId, `Hapus akun dibatalkan. Kode request: ${body.request.request_code}`);
    }

    return sendHtmlMessage(
      chatId,
      [
        'Hapus akun sudah dikonfirmasi.',
        '',
        'Kode request:',
        `<code>${escapeHtml(body.request.request_code)}</code>`,
        '',
        `Akun akan dihapus otomatis pada ${escapeHtml(formatDateTime(body.request.scheduled_deletion_at))}.`,
        '',
        'Kalau berubah pikiran, copy command ini sebelum waktunya:',
        `<code>/batal_hapus_akun ${escapeHtml(body.request.request_code)}</code>`,
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function notifyAdminsAboutDeletionRequest(request, admins) {
  const uniqueChatIds = new Set(admins.map((admin) => admin.telegram_chat_id).filter(Boolean));
  const text = [
    'Permintaan hapus data baru.',
    '',
    'Kode:',
    `<code>${escapeHtml(request.request_code)}</code>`,
    `Jenis: ${escapeHtml(deletionTypeLabel(request.request_type))}`,
    `User: ${escapeHtml(request.user_display_name || '-')}`,
    `Nomor: ${escapeHtml(request.user_phone_number || '-')}`,
    '',
    'Setujui:',
    `<code>/admin_setujui_hapus ${escapeHtml(request.request_code)}</code>`,
    '',
    'Tolak:',
    `<code>/admin_tolak_hapus ${escapeHtml(request.request_code)}</code>`,
  ].join('\n');

  await Promise.all([...uniqueChatIds].map((adminChatId) => sendHtmlMessage(adminChatId, text).catch(() => null)));
}

async function decideDeletionRequest(message, text, action) {
  const chatId = message.chat.id;
  const [, codeRaw] = text.trim().split(/\s+/);
  const code = String(codeRaw || '').trim().toUpperCase();

  if (!code) {
    return sendMessage(chatId, 'Tulis kode request. Contoh: /admin_setujui_hapus A1B2C3D4');
  }

  try {
    const response = await fetch(`${backendUrl}/telegram/admin/deletion-requests/${encodeURIComponent(code)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': botInternalToken,
      },
      body: JSON.stringify({
        admin_telegram_user_id: String(message.from.id),
        action,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal memproses permintaan hapus');

    const approved = action === 'approve';
    const adminText = approved
      ? `Disetujui. ${deletionTypeLabel(body.request.request_type)} selesai diproses.`
      : `Ditolak. Permintaan ${deletionTypeLabel(body.request.request_type)} tidak diproses.`;
    const userText = approved
      ? `Permintaan ${deletionTypeLabel(body.request.request_type)} kamu sudah disetujui admin dan selesai diproses.`
      : `Permintaan ${deletionTypeLabel(body.request.request_type)} kamu ditolak admin. Data kamu tidak dihapus.`;

    if (body.request.requester_chat_id && body.request.requester_chat_id !== String(chatId)) {
      await sendMessage(body.request.requester_chat_id, userText).catch(() => null);
    }

    return sendMessage(
      chatId,
      [
        adminText,
        `Kode request: ${body.request.request_code}`,
        `User: ${body.request.user_display_name || '-'}`,
        `Nomor: ${body.request.user_phone_number || '-'}`,
        `Data terhapus: ${body.deleted_count || 0}`,
      ].join('\n'),
    );
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
        `Pemasukan: ${formatIdr(income)}`,
        `Pengeluaran: ${formatIdr(expense)}`,
        `Saldo: ${formatIdr(balance)}`,
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

function parseCommand(text) {
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const directCommand = directCategoryCommand(command);
  if (directCommand) {
    const parsed = parseDirectCategoryCommand(directCommand, args);
    if (parsed) return { value: parsed };
    return { error: hasInvalidAmount(args) ? 'invalid_amount' : 'invalid_format' };
  }

  const typeByCommand = {
    '/keluar': 'expense',
    '/expense': 'expense',
    '/add': 'expense',
    '/masuk': 'income',
    '/income': 'income',
  };
  const type = typeByCommand[command];

  if (!type) {
    return rawCommand.startsWith('/') ? { error: 'unknown_command' } : { error: 'invalid_format' };
  }

  const parsed = parseTrailingAmountCommand(type, args) || parseLegacyAmountCommand(type, args);
  if (parsed) return { value: parsed };

  return { error: hasInvalidAmount(args) ? 'invalid_amount' : 'invalid_format' };
}

function directCategoryCommand(command) {
  const commands = {
    '/makan': { type: 'expense', category: 'makan' },
    '/minum': { type: 'expense', category: 'minum' },
    '/bensin': { type: 'expense', category: 'bensin' },
    '/transport': { type: 'expense', category: 'transport' },
    '/transportasi': { type: 'expense', category: 'transport' },
    '/lain': { type: 'expense', category: 'lain' },
    '/lainnya': { type: 'expense', category: 'lain' },
    '/gaji': { type: 'income', category: 'gaji' },
    '/freelance': { type: 'income', category: 'freelance' },
  };
  return commands[command] || null;
}

function parseDirectCategoryCommand(commandConfig, args) {
  if (args.length < 2) return null;

  const amountRaw = args.at(-1);
  if (!isPlainAmount(amountRaw)) return null;

  const note = args.slice(0, -1).join(' ').trim();
  const amount = Number(amountRaw);
  if (!note || !Number.isFinite(amount) || amount <= 0) return null;

  return {
    type: commandConfig.type,
    amount,
    category: commandConfig.category,
    note,
  };
}

function parseTrailingAmountCommand(type, args) {
  if (args.length < 2) return null;

  const amountRaw = args.at(-1);
  if (!isPlainAmount(amountRaw)) return null;

  const category = args[0];
  const note = args.slice(1, -1).join(' ').trim();
  const amount = Number(amountRaw);

  if (!category || !note || !Number.isFinite(amount) || amount <= 0) return null;

  return { type, amount, category, note };
}

function parseLegacyAmountCommand(type, args) {
  if (args.length < 2) return null;

  const [amountRaw, category, ...noteParts] = args;
  if (!isPlainAmount(amountRaw)) return null;

  const amount = Number(amountRaw);
  if (!category || !Number.isFinite(amount) || amount <= 0) return null;

  return {
    type,
    amount,
    category,
    note: noteParts.join(' '),
  };
}

function isPlainAmount(value) {
  return /^[1-9]\d*$/.test(String(value || ''));
}

function hasInvalidAmount(args) {
  return args.some((arg) => /^(rp)?\d[\d.,]*$/i.test(arg) && !isPlainAmount(arg));
}

function commandErrorMessage(error) {
  if (error === 'unknown_command') {
    return [
      'Command tidak tersedia.',
      '',
      'Ketik /bantuan untuk melihat daftar command.',
    ].join('\n');
  }

  if (error === 'invalid_amount') {
    return [
      'Nominal belum sesuai.',
      '',
      'Tulis nominal di bagian paling belakang tanpa titik, koma, atau Rp.',
      'Benar: 18000',
      'Salah: Rp18.000',
    ].join('\n');
  }

  return [
    'Format belum sesuai.',
    '',
    'Contoh:',
    '/makan nasi padang 18000',
    '/gaji april 7000000',
    '',
    'Catatan:',
    'Nominal ditulis paling belakang tanpa titik, koma, atau Rp.',
    '',
    'Ketik /bantuan untuk melihat panduan.',
  ].join('\n');
}

function firstCommand(text) {
  return text.trim().split(/\s+/)[0].toLowerCase();
}

function parsePageNumber(text) {
  const [, pageRaw] = text.trim().split(/\s+/);
  const page = Number(pageRaw || 1);
  if (!Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, 100);
}

function formatTransactions(transactions, offset = 0) {
  return transactions
    .map((item, index) => `${offset + index + 1}. ${labelType(item.type)} ${formatIdr(item.amount)} ${item.category_label} - ${item.note || '-'}`)
    .join('\n');
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
    transportasi: 'transport',
    transport: 'transport',
    kendaraan: 'transport',
    lain: 'other_expense',
    lainnya: 'other_expense',
    gaji: 'salary',
    salary: 'salary',
    project: 'freelance',
    freelance: 'freelance',
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

async function sendHtmlMessage(chatId, text, extra = {}) {
  return sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
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

function labelType(type) {
  return type === 'income' ? 'Pemasukan' : 'Pengeluaran';
}

function deletionTypeLabel(type) {
  return type === 'account' ? 'hapus akun' : 'hapus semua transaksi';
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(value));
}
