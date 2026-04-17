import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN;
const backendUrl = process.env.BACKEND_URL || 'http://backend:4000';
const botInternalToken = process.env.BOT_INTERNAL_TOKEN || 'budgetin_internal_dev_token';
const webAppUrl = process.env.WEB_APP_URL || 'http://localhost:3000';

const defaultBotCommands = [
  { command: 'mulai', description: 'Mulai dan hubungkan akun' },
  { command: 'bantuan', description: 'Lihat menu Budgetin' },
  { command: 'catat', description: 'Cara catat transaksi' },
  { command: 'lihat', description: 'Lihat riwayat dan ringkasan' },
  { command: 'export', description: 'Export data transaksi' },
  { command: 'akun', description: 'Pengaturan akun' },
];

const adminBotCommands = [
  { command: 'admin', description: 'Menu admin Budgetin' },
  { command: 'admin_user', description: 'Lihat statistik user' },
  { command: 'admin_pending', description: 'Lihat user belum verified' },
  { command: 'admin_verified', description: 'Lihat user sudah verified' },
  { command: 'admin_blocked', description: 'Lihat user diblokir' },
  { command: 'admin_ringkasan', description: 'Lihat ringkasan agregat' },
];

let offset = 0;
const lastTransactionsByChat = new Map();
const pendingDeleteTransactionsByChat = new Map();

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
  await setupBotCommands();
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

async function setupBotCommands() {
  try {
    await telegram('setMyCommands', {
      commands: defaultBotCommands,
    });
  } catch (error) {
    console.error('Failed to set Telegram commands:', error.message);
  }
}

async function setupAdminBotCommands(chatId) {
  try {
    await telegram('setMyCommands', {
      scope: { type: 'chat', chat_id: String(chatId) },
      commands: [...defaultBotCommands, ...adminBotCommands],
    });
  } catch (error) {
    console.error('Failed to set admin Telegram commands:', error.message);
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
    const account = await fetchTelegramAccount(message.from.id).catch(() => null);
    if (account?.is_admin) await setupAdminBotCommands(chatId);
    return sendHelpMessage(chatId, account);
  }

  const account = await ensureRegistered(message);
  if (!account) return null;

  if (command === '/catat') {
    return sendRecordHelp(chatId);
  }

  if (command === '/lihat') {
    return sendViewHelp(chatId);
  }

  if (command === '/akun') {
    return sendAccountHelp(chatId);
  }

  if (command === '/admin') {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    await setupAdminBotCommands(chatId);
    return sendAdminHelp(chatId);
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

  if (['/export', '/export_semua', '/export_bulan', '/export_tanggal', '/export_range'].includes(command)) {
    if (!account.is_verified) {
      return sendMessage(
        chatId,
        [
          'Export belum aktif.',
          '',
          'Akun kamu sedang menunggu verifikasi admin.',
          'Kamu tetap bisa mencatat transaksi lewat Telegram.',
        ].join('\n'),
      );
    }
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

  if (['/konfirmasi_hapus', '/confirm_delete'].includes(command)) {
    return confirmDeleteTransactions(message, text);
  }

  if (['/hapus_akun', '/delete_account'].includes(command)) {
    return requestDeletion(message, 'account');
  }

  if (['/konfirmasi_hapus_akun', '/confirm_delete_account'].includes(command)) {
    return confirmAccountDeletion(message, text);
  }

  if (['/hapus_semua', '/delete_all'].includes(command)) {
    return requestDeletion(message, 'all_transactions');
  }

  if (['/konfirmasi_hapus_semua', '/confirm_delete_all'].includes(command)) {
    return sendMessage(chatId, 'Sekarang hapus semua transaksi harus lewat persetujuan admin. Ketik /hapus_semua untuk membuat permintaan.');
  }

  if (['/admin_setujui_hapus', '/admin_approve_delete'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return decideDeletionRequest(message, text, 'approve');
  }

  if (['/admin_tolak_hapus', '/admin_reject_delete'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return decideDeletionRequest(message, text, 'reject');
  }

  if (['/admin_user', '/admin_users'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return sendAdminUserStats(message);
  }

  if (['/admin_pending', '/admin_pending_user'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return sendAdminPendingUsers(message, text);
  }

  if (['/admin_verified', '/admin_verified_user'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return sendAdminVerifiedUsers(message, text);
  }

  if (['/admin_blocked', '/admin_blocked_user'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return sendAdminBlockedUsers(message, text);
  }

  if (['/admin_ringkasan', '/admin_summary'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return sendAdminPlatformSummary(message);
  }

  if (['/admin_verifikasi_user', '/admin_verify_user'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return decideUserVerification(message, text, 'verify');
  }

  if (['/admin_blokir_user', '/admin_block_user'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return decideUserVerification(message, text, 'block');
  }

  if (['/admin_pulihkan_user', '/admin_restore_user'].includes(command)) {
    if (!account.is_admin) return sendMessage(chatId, 'Command ini khusus admin Budgetin.');
    return decideUserVerification(message, text, 'restore');
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

async function ensureRegistered(message) {
  try {
    const account = await fetchTelegramAccount(message.from.id);
    if (account?.is_deleted) {
      await sendDeletedAccountMessage(message.chat.id, account);
      return null;
    }
    if (account?.is_blocked) {
      await sendMessage(
        message.chat.id,
        [
          'Akun kamu diblokir.',
          '',
          'Hubungi admin Budgetin jika menurutmu ini keliru.',
        ].join('\n'),
      );
      return null;
    }
    if (account) return account;

    await sendUnregisteredMessage(message.chat.id);
    return null;
  } catch (error) {
    await sendMessage(message.chat.id, `Gagal cek akun: ${error.message}`);
    return null;
  }
}

function sendUnregisteredMessage(chatId) {
  return sendMessage(
    chatId,
    [
      'User belum terdaftar.',
      '',
      'Ketik /mulai lalu tekan Share Phone Number untuk menghubungkan Telegram kamu ke Budgetin.',
    ].join('\n'),
  );
}

async function sendStartMessage(message) {
  const chatId = message.chat.id;

  try {
    const account = await fetchTelegramAccount(message.from.id);
    if (account) {
      if (account.is_admin) await setupAdminBotCommands(chatId);
      if (account.is_deleted) {
        return sendDeletedAccountMessage(chatId, account, { reply_markup: { remove_keyboard: true } });
      }
      if (account.is_blocked) {
        return sendMessage(
          chatId,
          [
            'Akun kamu diblokir.',
            '',
            'Hubungi admin Budgetin jika menurutmu ini keliru.',
          ].join('\n'),
          { reply_markup: { remove_keyboard: true } },
        );
      }

      const name = account.display_name || account.first_name || message.from.first_name || 'teman Budgetin';
      return sendMessage(
        chatId,
        [
          `Halo ${name}, Telegram kamu sudah terhubung ke Budgetin.`,
          '',
          'Catat uang harian lewat Telegram, lalu lihat laporan lengkap di web.',
          '',
          'Catat cepat:',
          '/makan nasi padang 18000',
          '/gaji april 7000000',
          '',
          'Lihat menu:',
          '/bantuan',
          '',
        'Dashboard web:',
        webAppUrl,
        '',
        account.is_verified
          ? 'Dashboard lengkap sudah aktif.'
          : 'Dashboard lengkap akan aktif setelah admin memverifikasi akun kamu.',
        '',
        'Kalau kamu ganti nomor Telegram, ketik /hubungkan_ulang.',
      ].join('\n'),
        { reply_markup: { remove_keyboard: true } },
      );
    }
  } catch (error) {
    return sendMessage(chatId, `Gagal cek akun: ${error.message}`);
  }

  return requestPhoneNumber(chatId, [
    'Selamat datang di Budgetin.',
    '',
    'Budgetin membantu kamu mencatat pemasukan dan pengeluaran harian lewat Telegram.',
    '',
    'Setelah akun terhubung, kamu bisa langsung catat transaksi seperti ini:',
    '',
    '/makan nasi padang 18000',
    '/gaji april 7000000',
    '',
    'Nominal selalu ditulis di belakang tanpa titik, koma, atau Rp.',
    '',
    'Untuk melihat dashboard, filter, export, dan laporan lengkap, buka web Budgetin:',
    webAppUrl,
    '',
    'Langkah pertama:',
    'Tekan tombol Share Phone Number di bawah ini untuk menghubungkan Telegram kamu.',
    '',
    'Setelah terhubung, ketik /bantuan untuk melihat menu yang tersedia.',
  ]);
}

function sendDeletedAccountMessage(chatId, account, extra = {}) {
  const recoveryText = account?.delete_recovery_until
    ? `Admin masih bisa recovery sampai ${formatDateTime(account.delete_recovery_until)}.`
    : 'Hubungi admin Budgetin jika ingin recovery.';

  return sendMessage(
    chatId,
    [
      'Akun Budgetin kamu sedang dinonaktifkan.',
      '',
      recoveryText,
      'Selama status ini aktif, Telegram dan dashboard web tidak bisa dipakai.',
    ].join('\n'),
    extra,
  );
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

function sendHelpMessage(chatId, account = null) {
  const adminLines = account?.is_admin
    ? [
        '',
        'Menu admin:',
        '',
        '/admin',
        'Lihat command khusus admin.',
        '',
        '/admin_user',
        'Lihat jumlah user terdaftar dan statusnya.',
        '',
        '/admin_pending',
        'Lihat user yang belum diverifikasi.',
        '',
        '/admin_verified',
        'Lihat user yang sudah aktif.',
        '',
        '/admin_blocked',
        'Lihat user yang diblokir.',
        '',
        '/admin_ringkasan',
        'Lihat ringkasan agregat tanpa detail transaksi user.',
      ]
    : [];

  return sendMessage(
    chatId,
    [
      'Budgetin siap.',
      '',
      'Pilih yang kamu butuhkan:',
      '',
      '/catat',
      'Untuk catat pengeluaran atau pemasukan.',
      '',
      '/lihat',
      'Untuk lihat ringkasan dan riwayat transaksi.',
      '',
      '/export',
      'Untuk download data transaksi.',
      '',
      '/akun',
      'Untuk ubah nama, hubungkan nomor, atau hapus akun.',
      ...adminLines,
      '',
      'Catatan penting:',
      'Nominal selalu ditulis di belakang tanpa titik, koma, atau Rp.',
      'Contoh benar: /makan nasi padang 18000',
      '',
      'Jika belum terdaftar, ketik /mulai lalu tekan Share Phone Number.',
    ].join('\n'),
    { reply_markup: { remove_keyboard: true } },
  );
}

function sendAdminHelp(chatId) {
  return sendMessage(
    chatId,
    [
      'Menu admin Budgetin:',
      '',
      '/admin_user',
      'Lihat jumlah user terdaftar, verified, pending, blocked, deleted, dan aktif bulan ini.',
      '',
      '/admin_pending',
      'Lihat user yang belum diverifikasi. Pakai /admin_pending 2 untuk halaman berikutnya.',
      '',
      '/admin_verified',
      'Lihat user yang sudah aktif. Command blokir muncul di daftar ini.',
      '',
      '/admin_blocked',
      'Lihat user yang sedang diblokir. Command verifikasi ulang muncul di daftar ini.',
      '',
      '/admin_ringkasan',
      'Lihat jumlah transaksi dan ringkasan agregat. Nominal disembunyikan jika user aktif bulan ini kurang dari 5.',
      '',
      'Catatan privacy:',
      'Admin tidak melihat riwayat transaksi detail milik user.',
      '',
      'Command verifikasi, blokir, dan pulihkan hanya muncul di konteks daftar user yang sesuai.',
    ].join('\n'),
    { reply_markup: { remove_keyboard: true } },
  );
}

function sendRecordHelp(chatId) {
  return sendMessage(
    chatId,
    [
      'Mau catat apa?',
      '',
      'Pengeluaran:',
      '/makan nasi padang 18000',
      '/minum kopi 15000',
      '/bensin isi bensin motor 50000',
      '/transport gojek ke kantor 22000',
      '/lain beli kabel charger 25000',
      '',
      'Pemasukan:',
      '/gaji april 7000000',
      '/freelance desain logo 250000',
      '',
      'Catatan:',
      'Nominal selalu ditulis di belakang tanpa titik, koma, atau Rp.',
      'Benar: 50000',
      'Salah: Rp50.000',
    ].join('\n'),
    { reply_markup: { remove_keyboard: true } },
  );
}

function sendViewHelp(chatId) {
  return sendMessage(
    chatId,
    [
      'Mau lihat apa?',
      '',
      '/ringkasan',
      'Lihat total pemasukan, pengeluaran, dan saldo.',
      '',
      '/riwayat',
      'Lihat riwayat transaksi per 10 data. Bot akan memberi pilihan halaman.',
      '',
      '/hapus 1',
      'Hapus transaksi nomor 1 dari daftar /riwayat.',
      '',
      '/hapus 1,2,3',
      'Pilih beberapa transaksi dari daftar /riwayat untuk dihapus.',
    ].join('\n'),
    { reply_markup: { remove_keyboard: true } },
  );
}

function sendAccountHelp(chatId) {
  return sendMessage(
    chatId,
    [
      'Pengaturan akun:',
      '',
      '/nama Roy',
      'Ubah nama dashboard menjadi "Dashboard milik Roy".',
      '',
      '/hubungkan_ulang',
      'Kirim ulang nomor Telegram jika nomor kamu berubah.',
      '',
      '/hapus_semua',
      'Ajukan permintaan hapus semua transaksi ke admin.',
      '',
      '/hapus_akun',
      'Nonaktifkan akun sekarang. Admin masih bisa recovery maksimal 2 hari.',
      '',
      'Catatan:',
      'Kode hapus akun akan diberikan setelah kamu mengetik /hapus_akun.',
    ].join('\n'),
    { reply_markup: { remove_keyboard: true } },
  );
}

function sendLegacyHelpMessage(chatId) {
  return sendMessage(
    chatId,
    [
      'Command cepat yang tetap bisa dipakai:',
      '',
      '/makan, /minum, /bensin, /transport, /lain',
      '/gaji, /freelance',
      '/ringkasan, /riwayat',
      '/export, /nama, /hapus, /hapus_akun',
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

    if (body.is_new_registration) {
      await notifyAdminsAboutNewUser(body.user, body.admins || [], {
        telegram_user_id: String(message.from.id),
        username: message.from.username || '',
        first_name: message.from.first_name || '',
      });
    }
    if (body.user?.is_admin) await setupAdminBotCommands(chatId);

    return sendMessage(
      chatId,
      [
        'Nomor Telegram sudah terhubung.',
        `Kode OTP Budgetin kamu: ${body.otp}`,
        'Kode berlaku 10 menit. Masukkan kode ini di halaman login web.',
        '',
        'Kamu bisa mulai catat transaksi dari Telegram:',
        '/makan nasi padang 18000',
        '/gaji april 7000000',
        '',
        'Ketik /bantuan untuk melihat menu lengkap.',
        '',
        'Dashboard web:',
        webAppUrl,
        '',
        body.user.is_verified
          ? 'Dashboard lengkap sudah aktif.'
          : 'Dashboard lengkap akan aktif setelah admin memverifikasi akun kamu.',
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
    const parsed = parseExportCommand(text);
    if (parsed.error) return sendMessage(chatId, parsed.error);
    if (parsed.help) return sendMessage(chatId, parsed.help);

    const params = parsed.params;
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
    if (params.get('date')) filenameParts.push(params.get('date'));
    if (params.get('date_from') || params.get('date_to')) filenameParts.push(`${params.get('date_from') || 'awal'}-to-${params.get('date_to') || 'akhir'}`);

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

    const transactions = addDisplayNumbers(body.data, 0);
    lastTransactionsByChat.set(String(chatId), transactions);
    if (!transactions.length) return sendMessage(chatId, 'Belum ada transaksi.');

    return sendMessage(
      chatId,
      [
        '10 transaksi terbaru:',
        'Nomor di daftar ini bisa dipakai untuk /hapus.',
        '',
        formatTransactions(transactions, 0),
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
      limit: String(limit + 1),
      offset: String(offset),
      sort: 'newest',
    });
    const response = await fetch(`${backendUrl}/telegram/transactions?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil riwayat transaksi');

    const pageData = body.data.slice(0, limit);
    const hasNextPage = body.data.length > limit;
    const transactions = addDisplayNumbers(pageData, 0);

    if (!transactions.length) {
      return sendMessage(chatId, page === 1 ? 'Belum ada transaksi.' : `Tidak ada transaksi di halaman ${page}.`);
    }

    lastTransactionsByChat.set(String(chatId), transactions);

    return sendMessage(
      chatId,
      [
        `Riwayat transaksi halaman ${page}`,
        `Menampilkan data ${offset + 1}-${offset + transactions.length}.`,
        '',
        formatTransactions(transactions, offset),
        '',
        'Nomor di daftar ini bisa dipakai untuk /hapus.',
        'Contoh: /hapus 1 atau /hapus 1,2,3',
        '',
        historyPageChoices(page, hasNextPage),
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function deleteTransaction(message, text) {
  const chatId = message.chat.id;
  const [, numbersRaw] = text.trim().split(/\s+/);
  const selectedNumbers = parseTransactionNumbers(numbersRaw);
  const cached = lastTransactionsByChat.get(String(chatId)) || [];
  const selectedTransactions = getTransactionsByDisplayNumbers(cached, selectedNumbers);

  if (!selectedNumbers.length) {
    return sendMessage(chatId, 'Pilih nomor dari /riwayat. Contoh: /hapus 1 atau /hapus 1,2,3');
  }

  if (selectedTransactions.length !== selectedNumbers.length) {
    return sendMessage(chatId, 'Ada nomor yang tidak ada di riwayat terakhir. Buka /riwayat lagi, lalu pilih nomor yang ingin dihapus.');
  }

  if (selectedTransactions.length > 1) {
    pendingDeleteTransactionsByChat.set(String(chatId), {
      numbersRaw: selectedNumbers.join(','),
      transactionIds: selectedTransactions.map((item) => item.id),
      expiresAt: Date.now() + 2 * 60 * 1000,
    });

    return sendMessage(
      chatId,
      [
        `Kamu akan menghapus ${selectedTransactions.length} transaksi:`,
        '',
        formatTransactions(selectedTransactions, 0),
        '',
        'Kalau yakin, copy command ini dalam 2 menit:',
        `/konfirmasi_hapus ${selectedNumbers.join(',')}`,
      ].join('\n'),
    );
  }

  const transaction = selectedTransactions[0];

  try {
    const deleted = await deleteTransactionsByIds(message.from.id, [transaction.id]);
    const body = deleted[0];

    lastTransactionsByChat.set(
      String(chatId),
      cached.filter((item) => item.id !== transaction.id),
    );
    return sendMessage(
      chatId,
      [
        `Dihapus: ${labelType(body.type)} ${formatIdr(body.amount)} ${body.category_label}`,
        '',
        'Ketik /riwayat untuk melihat daftar terbaru.',
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function confirmDeleteTransactions(message, text) {
  const chatId = message.chat.id;
  const [, numbersRaw] = text.trim().split(/\s+/);
  const selectedNumbers = parseTransactionNumbers(numbersRaw);
  const pending = pendingDeleteTransactionsByChat.get(String(chatId));

  if (!selectedNumbers.length) {
    return sendMessage(chatId, 'Tulis nomor yang ingin dikonfirmasi. Contoh: /konfirmasi_hapus 1,2,3');
  }

  if (!pending || pending.numbersRaw !== selectedNumbers.join(',')) {
    return sendMessage(chatId, 'Tidak ada permintaan hapus yang cocok. Ketik /hapus 1,2,3 dulu.');
  }

  if (Date.now() > pending.expiresAt) {
    pendingDeleteTransactionsByChat.delete(String(chatId));
    return sendMessage(chatId, 'Konfirmasi hapus sudah kedaluwarsa. Ketik /hapus 1,2,3 lagi jika masih ingin menghapus.');
  }

  try {
    const deleted = await deleteTransactionsByIds(message.from.id, pending.transactionIds);
    const deletedIds = new Set(deleted.map((item) => item.id));
    const cached = lastTransactionsByChat.get(String(chatId)) || [];

    lastTransactionsByChat.set(
      String(chatId),
      cached.filter((item) => !deletedIds.has(item.id)),
    );
    pendingDeleteTransactionsByChat.delete(String(chatId));

    return sendMessage(
      chatId,
      [
        `Selesai. ${deleted.length} transaksi sudah dihapus.`,
        '',
        'Ketik /riwayat untuk melihat daftar terbaru.',
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function deleteTransactionsByIds(telegramUserId, transactionIds) {
  const deleted = [];

  for (const transactionId of transactionIds) {
    const params = new URLSearchParams({ telegram_user_id: String(telegramUserId) });
    const response = await fetch(`${backendUrl}/telegram/transactions/${transactionId}?${params.toString()}`, {
      method: 'DELETE',
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal menghapus transaksi');
    deleted.push(body.data);
  }

  return deleted;
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

  return sendMessage(
    chatId,
    [
      title,
      '',
      'Kode konfirmasi:',
      code,
      '',
      'Data kamu belum dihapus.',
      '',
      'Kalau command di bawah ini dikirim, akun langsung dinonaktifkan.',
      'Telegram dan dashboard web tidak bisa dipakai setelah itu.',
      '',
      'Admin akan mendapat notifikasi dan masih bisa recovery maksimal 2 hari.',
      'Lanjutkan hanya jika kamu sadar dan yakin.',
      '',
      'Copy command ini untuk konfirmasi:',
      `/konfirmasi_hapus_akun ${code}`,
    ].join('\n'),
  );
}

async function confirmAccountDeletion(message, text) {
  return updateAccountDeletionRequest(message, text, 'confirm');
}

async function updateAccountDeletionRequest(message, text, action) {
  const chatId = message.chat.id;
  const [, codeRaw] = text.trim().split(/\s+/);
  const code = String(codeRaw || '').trim().toUpperCase();

  if (!code) {
    const examples = {
      confirm: '/konfirmasi_hapus_akun A1B2C3D4',
    };
    const example = examples[action] || examples.confirm;
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

    await notifyAdminsAboutAccountDeleted(body.user, body.request, body.admins || [], body.telegram || {
      telegram_user_id: String(message.from.id),
      telegram_chat_id: String(chatId),
      username: message.from.username || '',
      first_name: message.from.first_name || '',
    });

    return sendMessage(
      chatId,
      [
        'Akun Budgetin kamu sudah dinonaktifkan sekarang.',
        '',
        'Kode request:',
        body.request.request_code,
        '',
        `Admin masih bisa recovery sampai ${formatDateTime(body.user.delete_recovery_until)}.`,
        'Jika ini tidak sengaja, segera hubungi admin Budgetin.',
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
    request.request_code,
    `Jenis: ${deletionTypeLabel(request.request_type)}`,
    `User: ${request.user_display_name || '-'}`,
    `Nomor: ${request.user_phone_number || '-'}`,
    '',
    'Setujui:',
    `/admin_setujui_hapus ${request.request_code}`,
    '',
    'Tolak:',
    `/admin_tolak_hapus ${request.request_code}`,
  ].join('\n');

  await Promise.all([...uniqueChatIds].map((adminChatId) => sendMessage(adminChatId, text).catch(() => null)));
}

async function notifyAdminsAboutAccountDeleted(user, request, admins, telegramProfile) {
  const uniqueChatIds = new Set(admins.map((admin) => admin.telegram_chat_id).filter(Boolean));
  if (!uniqueChatIds.size) return;

  const telegramUserId = telegramProfile?.telegram_user_id || '-';
  const username = telegramProfile?.username ? `@${telegramProfile.username}` : '-';
  const firstName = telegramProfile?.first_name || '-';
  const recoveryUntil = user?.delete_recovery_until ? formatDateTime(user.delete_recovery_until) : '-';
  const text = [
    'User menonaktifkan akun Budgetin.',
    '',
    `Nama: ${user?.display_name || firstName || '-'}`,
    `Username: ${username}`,
    `Nomor: ${user?.phone_number || '-'}`,
    `Telegram ID: ${telegramUserId}`,
    `Kode request: ${request?.request_code || '-'}`,
    '',
    `Recovery sampai: ${recoveryUntil}`,
    '',
    'Pulihkan akun:',
    `/admin_pulihkan_user ${telegramUserId}`,
  ].join('\n');

  await Promise.all([...uniqueChatIds].map((adminChatId) => sendMessage(adminChatId, text).catch(() => null)));
}

async function notifyAdminsAboutNewUser(user, admins, telegramProfile) {
  const uniqueChatIds = new Set(admins.map((admin) => admin.telegram_chat_id).filter(Boolean));
  if (!uniqueChatIds.size) return;

  const telegramUserId = telegramProfile.telegram_user_id;
  const username = telegramProfile.username ? `@${telegramProfile.username}` : '-';
  const firstName = telegramProfile.first_name || '-';
  const text = [
    'User baru terdaftar.',
    '',
    `Nama: ${user.display_name || firstName}`,
    `Username: ${username}`,
    `Nomor: ${user.phone_number || '-'}`,
    `Telegram ID: ${telegramUserId}`,
    '',
    'Status: belum diverifikasi',
    '',
    'Verifikasi:',
    `/admin_verifikasi_user ${telegramUserId}`,
    '',
    'Blokir:',
    `/admin_blokir_user ${telegramUserId}`,
  ].join('\n');

  await Promise.all([...uniqueChatIds].map((adminChatId) => sendMessage(adminChatId, text).catch(() => null)));
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

async function decideUserVerification(message, text, action) {
  const chatId = message.chat.id;
  const [, telegramUserIdRaw] = text.trim().split(/\s+/);
  const telegramUserId = String(telegramUserIdRaw || '').trim();

  if (!telegramUserId) {
    const examples = {
      verify: '/admin_verifikasi_user 123456789',
      block: '/admin_blokir_user 123456789',
      restore: '/admin_pulihkan_user 123456789',
    };
    const example = examples[action] || examples.verify;
    return sendMessage(chatId, `Tulis Telegram ID user. Contoh: ${example}`);
  }

  try {
    const response = await fetch(`${backendUrl}/telegram/admin/users/${encodeURIComponent(telegramUserId)}`, {
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
    if (!response.ok) throw new Error(body.error || 'Gagal memproses user');

    if (action === 'verify') {
      if (body.telegram.telegram_chat_id) {
        await sendMessage(
          body.telegram.telegram_chat_id,
          [
            'Akun Budgetin kamu sudah diverifikasi admin.',
            '',
            'Dashboard web lengkap sekarang aktif:',
            webAppUrl,
          ].join('\n'),
        ).catch(() => null);
      }

      return sendMessage(chatId, `User ${body.user.phone_number || telegramUserId} sudah diverifikasi.`);
    }

    if (action === 'restore') {
      if (body.telegram.telegram_chat_id) {
        await sendMessage(
          body.telegram.telegram_chat_id,
          [
            'Akun Budgetin kamu sudah dipulihkan admin.',
            '',
            'Kamu bisa memakai Telegram dan dashboard web lagi.',
            webAppUrl,
          ].join('\n'),
        ).catch(() => null);
      }

      return sendMessage(chatId, `User ${body.user.phone_number || telegramUserId} sudah dipulihkan.`);
    }

    if (body.telegram.telegram_chat_id) {
      await sendMessage(
        body.telegram.telegram_chat_id,
        [
          'Akun Budgetin kamu diblokir admin.',
          '',
          'Hubungi admin Budgetin jika menurutmu ini keliru.',
        ].join('\n'),
      ).catch(() => null);
    }

    return sendMessage(chatId, `User ${body.user.phone_number || telegramUserId} sudah diblokir.`);
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendAdminUserStats(message) {
  const chatId = message.chat.id;

  try {
    const params = new URLSearchParams({ admin_telegram_user_id: String(message.from.id) });
    const response = await fetch(`${backendUrl}/telegram/admin/user-stats?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil statistik user');

    const data = body.data;
    return sendMessage(
      chatId,
      [
        'Statistik user Budgetin',
        '',
        `Total akun: ${formatNumber(data.total_users)}`,
        `User biasa: ${formatNumber(data.regular_users)}`,
        `Admin: ${formatNumber(data.admin_users)}`,
        '',
        `Verified: ${formatNumber(data.verified_users)}`,
        `Menunggu verifikasi: ${formatNumber(data.pending_users)}`,
        `Diblokir: ${formatNumber(data.blocked_users)}`,
        `Dinonaktifkan: ${formatNumber(data.deleted_users)}`,
        '',
        `User aktif bulan ini: ${formatNumber(data.active_users_this_month)}`,
      ].join('\n'),
    );
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendAdminPendingUsers(message, text) {
  const chatId = message.chat.id;
  const page = parsePageNumber(text);
  const limit = 10;
  const offset = (page - 1) * limit;

  try {
    const params = new URLSearchParams({
      admin_telegram_user_id: String(message.from.id),
      limit: String(limit),
      offset: String(offset),
    });
    const response = await fetch(`${backendUrl}/telegram/admin/pending-users?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil user pending');

    if (!body.data.length) {
      return sendMessage(chatId, page === 1 ? 'Tidak ada user yang menunggu verifikasi.' : `Tidak ada user pending di halaman ${page}.`);
    }

    const lines = [
      `User belum verified - halaman ${page}`,
      `Menampilkan data ${offset + 1}-${offset + body.data.length}.`,
      '',
      ...body.data.flatMap((user, index) => {
        const number = offset + index + 1;
        const name = user.display_name || user.first_name || '-';
        const username = user.username ? `@${user.username}` : '-';
        const joinedAt = user.created_at ? formatDateTime(user.created_at) : '-';
        return [
          `${number}. ${name}`,
          `Nomor: ${user.phone_number || '-'}`,
          `Username: ${username}`,
          `Telegram ID: ${user.telegram_user_id}`,
          `Daftar: ${joinedAt}`,
          'Verifikasi:',
          `/admin_verifikasi_user ${user.telegram_user_id}`,
          'Blokir:',
          `/admin_blokir_user ${user.telegram_user_id}`,
          '',
        ];
      }),
      body.pagination?.has_next_page
        ? `Halaman berikutnya: /admin_pending ${page + 1}`
        : 'Tidak ada halaman berikutnya.',
    ];

    return sendMessage(chatId, lines.join('\n'));
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendAdminVerifiedUsers(message, text) {
  const chatId = message.chat.id;
  const page = parsePageNumber(text);
  const limit = 10;
  const offset = (page - 1) * limit;

  try {
    const params = new URLSearchParams({
      admin_telegram_user_id: String(message.from.id),
      limit: String(limit),
      offset: String(offset),
    });
    const response = await fetch(`${backendUrl}/telegram/admin/verified-users?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil user verified');

    if (!body.data.length) {
      return sendMessage(chatId, page === 1 ? 'Belum ada user yang sudah verified.' : `Tidak ada user verified di halaman ${page}.`);
    }

    const lines = [
      `User verified - halaman ${page}`,
      `Menampilkan data ${offset + 1}-${offset + body.data.length}.`,
      '',
      ...body.data.flatMap((user, index) => {
        const number = offset + index + 1;
        const name = user.display_name || user.first_name || '-';
        const username = user.username ? `@${user.username}` : '-';
        const verifiedAt = user.verified_at ? formatDateTime(user.verified_at) : '-';
        return [
          `${number}. ${name}`,
          `Nomor: ${user.phone_number || '-'}`,
          `Username: ${username}`,
          `Telegram ID: ${user.telegram_user_id}`,
          `Verified: ${verifiedAt}`,
          'Blokir:',
          `/admin_blokir_user ${user.telegram_user_id}`,
          '',
        ];
      }),
      body.pagination?.has_next_page
        ? `Halaman berikutnya: /admin_verified ${page + 1}`
        : 'Tidak ada halaman berikutnya.',
    ];

    return sendMessage(chatId, lines.join('\n'));
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendAdminBlockedUsers(message, text) {
  const chatId = message.chat.id;
  const page = parsePageNumber(text);
  const limit = 10;
  const offset = (page - 1) * limit;

  try {
    const params = new URLSearchParams({
      admin_telegram_user_id: String(message.from.id),
      limit: String(limit),
      offset: String(offset),
    });
    const response = await fetch(`${backendUrl}/telegram/admin/blocked-users?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil user blocked');

    if (!body.data.length) {
      return sendMessage(chatId, page === 1 ? 'Tidak ada user yang sedang diblokir.' : `Tidak ada user blocked di halaman ${page}.`);
    }

    const lines = [
      `User diblokir - halaman ${page}`,
      `Menampilkan data ${offset + 1}-${offset + body.data.length}.`,
      '',
      ...body.data.flatMap((user, index) => {
        const number = offset + index + 1;
        const name = user.display_name || user.first_name || '-';
        const username = user.username ? `@${user.username}` : '-';
        const blockedAt = user.blocked_at ? formatDateTime(user.blocked_at) : '-';
        return [
          `${number}. ${name}`,
          `Nomor: ${user.phone_number || '-'}`,
          `Username: ${username}`,
          `Telegram ID: ${user.telegram_user_id}`,
          `Diblokir: ${blockedAt}`,
          'Verifikasi ulang:',
          `/admin_verifikasi_user ${user.telegram_user_id}`,
          '',
        ];
      }),
      body.pagination?.has_next_page
        ? `Halaman berikutnya: /admin_blocked ${page + 1}`
        : 'Tidak ada halaman berikutnya.',
    ];

    return sendMessage(chatId, lines.join('\n'));
  } catch (error) {
    return sendMessage(chatId, `Gagal: ${error.message}`);
  }
}

async function sendAdminPlatformSummary(message) {
  const chatId = message.chat.id;

  try {
    const params = new URLSearchParams({ admin_telegram_user_id: String(message.from.id) });
    const response = await fetch(`${backendUrl}/telegram/admin/platform-summary?${params.toString()}`, {
      headers: { 'x-bot-token': botInternalToken },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Gagal mengambil ringkasan admin');

    const data = body.data;
    const lines = [
      'Ringkasan agregat Budgetin',
      '',
      `Total transaksi: ${formatNumber(data.total_transactions)}`,
      `Transaksi bulan ini: ${formatNumber(data.transactions_this_month)}`,
      `User aktif bulan ini: ${formatNumber(data.active_users_this_month)}`,
    ];

    if (!data.can_show_money) {
      lines.push(
        '',
        `Nominal agregat disembunyikan karena user aktif bulan ini kurang dari ${data.privacy_threshold}.`,
        'Ini untuk menjaga privacy user saat jumlah user masih sedikit.',
      );
      return sendMessage(chatId, lines.join('\n'));
    }

    lines.push(
      '',
      `Total pemasukan bulan ini: ${formatIdr(data.income_this_month)}`,
      `Total pengeluaran bulan ini: ${formatIdr(data.expense_this_month)}`,
      `Kategori pengeluaran terbesar: ${data.top_expense_category_this_month?.category_label || '-'}`,
      '',
      'Catatan: ini agregat semua user, bukan detail transaksi user.',
    );

    return sendMessage(chatId, lines.join('\n'));
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
      'Ketik:',
      '/catat untuk mencatat transaksi',
      '/lihat untuk melihat data',
      '/akun untuk pengaturan akun',
      '',
      'Atau ketik /bantuan untuk menu utama.',
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

function addDisplayNumbers(transactions, offset = 0) {
  return transactions.map((item, index) => ({
    ...item,
    display_number: offset + index + 1,
  }));
}

function formatTransactions(transactions, offset = 0) {
  return transactions
    .map((item, index) => `${item.display_number || offset + index + 1}. ${labelType(item.type)} ${formatIdr(item.amount)} ${item.category_label} - ${item.note || '-'}`)
    .join('\n');
}

function historyPageChoices(page, hasNextPage) {
  const choices = ['Pilih halaman:'];
  if (page > 1) choices.push(`/riwayat ${page - 1}`);
  choices.push(`/riwayat ${page}`);
  if (hasNextPage) choices.push(`/riwayat ${page + 1}`);
  return choices.join('\n');
}

function parseTransactionNumbers(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((number) => Number.isInteger(number) && number > 0))];
}

function getTransactionsByDisplayNumbers(transactions, selectedNumbers) {
  return selectedNumbers
    .map((number) => transactions.find((item) => item.display_number === number))
    .filter(Boolean);
}

function parseExportCommand(text) {
  const [rawCommand, ...args] = text.trim().split(/\s+/);
  const command = rawCommand.toLowerCase();
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

  if (command === '/export') {
    if (!args.length) return { help: exportMenuMessage() };
    setExportParamsFromArgs(params, args, { filters, categories, aliases });
    return { params };
  }

  if (command === '/export_semua') {
    setExportParamsFromArgs(params, args, { filters, categories, aliases });
    return { params };
  }

  if (command === '/export_bulan') {
    if (!args.length) return { help: exportMonthMenuMessage() };
    const [month, ...rest] = args;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return { error: 'Format bulan belum sesuai. Contoh: /export_bulan 2026-04 atau /export_bulan 2026-04 makan' };
    }
    params.set('month', month);
    setExportParamsFromArgs(params, rest, { filters, categories, aliases });
    return { params };
  }

  if (command === '/export_tanggal') {
    const [date, ...rest] = args;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      return { error: 'Format tanggal belum sesuai. Contoh: /export_tanggal 2026-04-16 atau /export_tanggal 2026-04-16 transport' };
    }
    params.set('date', date);
    setExportParamsFromArgs(params, rest, { filters, categories, aliases });
    return { params };
  }

  if (command === '/export_range') {
    const [dateFrom, dateTo, ...rest] = args;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom || '') || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo || '')) {
      return { error: 'Format range belum sesuai. Contoh: /export_range 2026-04-01 2026-04-16 atau /export_range 2026-04-01 2026-04-16 freelance' };
    }
    params.set('date_from', dateFrom);
    params.set('date_to', dateTo);
    setExportParamsFromArgs(params, rest, { filters, categories, aliases });
    return { params };
  }

  return { help: exportMenuMessage() };
}

function setExportParamsFromArgs(params, args, options) {
  const { filters, categories, aliases } = options;

  for (const rawArg of args) {
    const arg = rawArg.toLowerCase();
    if (/^\d{4}-\d{2}$/.test(arg)) {
      params.set('month', arg);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      if (!params.get('date')) params.set('date', arg);
    } else if (filters.has(arg)) {
      params.set('type', arg);
    } else if (categories.has(arg)) {
      params.set('category', arg);
    } else if (aliases[arg]) {
      params.set('category', aliases[arg]);
    }
  }
}

function exportMenuMessage() {
  const today = currentDateString();
  return [
    'Export data transaksi',
    '',
    'Pilih salah satu:',
    '',
    '/export_semua',
    'Download semua transaksi.',
    '',
    '/export_bulan',
    'Pilih bulan tahun ini.',
    '',
    `/export_tanggal ${today}`,
    'Download transaksi di 1 tanggal.',
    '',
    `/export_range ${today.slice(0, 8)}01 ${today}`,
    'Download transaksi dari tanggal awal sampai tanggal akhir.',
    '',
    'Filter kategori opsional:',
    'Tambahkan kategori di belakang command.',
    '',
    'Kategori:',
    'makan, transport, lain, gaji, freelance',
    '',
    'Contoh:',
    `/export_bulan ${today.slice(0, 7)} makan`,
    `/export_tanggal ${today} transport`,
    `/export_range ${today.slice(0, 8)}01 ${today} freelance`,
  ].join('\n');
}

function exportMonthMenuMessage() {
  const year = new Intl.DateTimeFormat('en-CA', { year: 'numeric', timeZone: 'Asia/Jakarta' }).format(new Date());
  const months = Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, '0');
    return `/export_bulan ${year}-${month}`;
  });

  return [
    'Pilih bulan:',
    '',
    ...months,
    '',
    'Bisa tambah kategori di belakang.',
    '',
    'Contoh:',
    `/export_bulan ${year}-04 makan`,
    `/export_bulan ${year}-04 gaji`,
  ].join('\n');
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

function formatNumber(value) {
  return new Intl.NumberFormat('id-ID', {
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

function currentDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
