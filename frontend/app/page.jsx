'use client';

import { useEffect, useMemo, useState } from 'react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const storageKey = 'budgetin_session';

const categories = {
  expense: [
    { code: 'food_drink', label: 'Makan & Minum', color: '#21745b' },
    { code: 'transport', label: 'Transportasi', color: '#d08a25' },
    { code: 'other_expense', label: 'Lain-Lain', color: '#7b5ea7' },
  ],
  income: [
    { code: 'salary', label: 'Gaji Pokok', color: '#2f7fb8' },
    { code: 'freelance', label: 'Freelance', color: '#b84a62' },
  ],
};

const allCategories = [...categories.expense, ...categories.income];
const categoryMeta = Object.fromEntries(allCategories.map((category) => [category.code, category]));

function currentMonthValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function formatCurrency(value) {
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

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function weekKey(date) {
  const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
  const week = Math.ceil((date.getDate() + firstDay.getDay()) / 7);
  return `Minggu ${week}`;
}

function monthLabel(value) {
  const [year, month] = String(value || '').split('-');
  if (!year || !month) return 'Bulan ini';
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('id-ID', {
    month: 'long',
    year: 'numeric',
  });
}

function periodLabel(period) {
  if (period === 'daily') return 'Harian';
  if (period === 'weekly') return 'Mingguan';
  return 'Bulanan';
}

function summarizeTransactions(transactions) {
  return transactions.reduce(
    (totals, item) => {
      const amount = Number(item.amount || 0);
      if (item.type === 'income') totals.income += amount;
      if (item.type === 'expense') totals.expense += amount;
      totals.count += 1;
      return totals;
    },
    { income: 0, expense: 0, count: 0 },
  );
}

function groupByCategory(transactions, type) {
  const grouped = new Map();
  transactions
    .filter((item) => item.type === type)
    .forEach((item) => {
      const current = grouped.get(item.category) || {
        category: item.category,
        category_label: item.category_label || categoryMeta[item.category]?.label || item.category,
        color: categoryMeta[item.category]?.color || '#63736b',
        total: 0,
      };
      current.total += Number(item.amount || 0);
      grouped.set(item.category, current);
    });

  return [...grouped.values()].sort((a, b) => b.total - a.total);
}

function buildTrend(transactions, period) {
  const grouped = new Map();

  transactions.forEach((item) => {
    const date = parseDate(item.created_at);
    if (!date) return;

    const key = period === 'daily'
      ? dateKey(date)
      : period === 'weekly'
        ? weekKey(date)
        : date.toLocaleDateString('id-ID', { month: 'short', year: 'numeric' });

    const current = grouped.get(key) || { label: key, income: 0, expense: 0 };
    current[item.type] += Number(item.amount || 0);
    grouped.set(key, current);
  });

  return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label, 'id-ID'));
}

function categoryInsight(expenses) {
  if (!expenses.length) return 'Belum ada pengeluaran pada periode ini.';
  const top = expenses[0];
  return `Pengeluaran terbesar: ${top.category_label} (${formatCurrency(top.total)}).`;
}

function busyDayInsight(transactions) {
  const grouped = new Map();
  transactions
    .filter((item) => item.type === 'expense')
    .forEach((item) => {
      const date = parseDate(item.created_at);
      if (!date) return;
      const label = date.toLocaleDateString('id-ID', { weekday: 'long' });
      grouped.set(label, (grouped.get(label) || 0) + Number(item.amount || 0));
    });

  const top = [...grouped.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? `Hari paling boros: ${top[0]} (${formatCurrency(top[1])}).` : 'Belum ada pola harian yang bisa dibaca.';
}

export default function Home() {
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [authMessage, setAuthMessage] = useState('');
  const [user, setUser] = useState(null);
  const [token, setToken] = useState('');
  const [transactions, setTransactions] = useState([]);
  const [period, setPeriod] = useState('daily');
  const [selectedMonth, setSelectedMonth] = useState(currentMonthValue());
  const [filters, setFilters] = useState({ type: '', category: '', sort: 'newest' });
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const dashboardOwner = user?.display_name || user?.phone_number || 'Budgetin';
  const isDeleted = Boolean(token && user?.is_deleted);
  const isPendingVerification = Boolean(token && user && !user.is_verified && !user.is_blocked && !user.is_deleted);
  const isBlocked = Boolean(token && user?.is_blocked && !user.is_deleted);

  const filteredTransactions = useMemo(() => {
    return transactions.filter((item) => {
      if (filters.type && item.type !== filters.type) return false;
      if (filters.category && item.category !== filters.category) return false;
      return true;
    });
  }, [transactions, filters.type, filters.category]);

  const periodTotals = useMemo(() => summarizeTransactions(transactions), [transactions]);
  const filteredTotals = useMemo(() => summarizeTransactions(filteredTransactions), [filteredTransactions]);
  const expenseSummary = useMemo(() => groupByCategory(transactions, 'expense'), [transactions]);
  const incomeSummary = useMemo(() => groupByCategory(transactions, 'income'), [transactions]);
  const trend = useMemo(() => buildTrend(transactions, period), [transactions, period]);
  const balance = periodTotals.income - periodTotals.expense;

  async function request(path, options = {}) {
    const response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error || 'Request failed');
      error.code = body.code;
      throw error;
    }
    return body;
  }

  async function requestOtp() {
    try {
      setAuthMessage('');
      const body = await request('/auth/request-otp', {
        method: 'POST',
        body: JSON.stringify({ phone_number: phoneNumber }),
      });
      setAuthMessage(body.message || 'OTP dikirim ke Telegram.');
    } catch (error) {
      setAuthMessage(error.message);
    }
  }

  async function verifyOtp() {
    try {
      setAuthMessage('');
      const body = await request('/auth/verify-otp', {
        method: 'POST',
        body: JSON.stringify({ phone_number: phoneNumber, code: otpCode }),
      });
      setUser(body.user);
      setToken(body.token);
      localStorage.setItem(storageKey, JSON.stringify({ token: body.token, user: body.user }));
      setAuthMessage('Login berhasil.');
    } catch (error) {
      setAuthMessage(error.message);
    }
  }

  async function loadData() {
    if (!token) return;
    if (!user?.is_verified || user?.is_blocked || user?.is_deleted) {
      setTransactions([]);
      return;
    }

    const params = new URLSearchParams({
      limit: '500',
      sort: filters.sort,
      month: selectedMonth,
    });

    const transactionBody = await request(`/transactions?${params.toString()}`, { headers });
    setTransactions(transactionBody.data);
  }

  async function exportCsv() {
    if (!token) return;
    const params = new URLSearchParams({ month: selectedMonth });
    if (filters.type) params.set('type', filters.type);
    if (filters.category) params.set('category', filters.category);

    const response = await fetch(`${apiUrl}/exports/transactions.csv?${params.toString()}`, {
      headers,
    });
    if (!response.ok) throw new Error('Export gagal');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `budgetin-export-${selectedMonth}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }

  function logout() {
    localStorage.removeItem(storageKey);
    setToken('');
    setUser(null);
    setTransactions([]);
    setOtpCode('');
    setAuthMessage('Kamu sudah logout.');
  }

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return;

    try {
      const session = JSON.parse(saved);
      if (!session.token) return;
      setToken(session.token);
      setUser(session.user || null);
      setAuthMessage('Session dipulihkan.');
    } catch {
      localStorage.removeItem(storageKey);
    }
  }, []);

  useEffect(() => {
    if (!token) return;

    request('/me', { headers })
      .then((body) => {
        setUser(body.user);
        localStorage.setItem(storageKey, JSON.stringify({ token, user: body.user }));
      })
      .catch(() => {
        localStorage.removeItem(storageKey);
        setToken('');
        setUser(null);
        setTransactions([]);
        setAuthMessage('Session berakhir. Silakan login ulang.');
      });
  }, [token]);

  useEffect(() => {
    loadData().catch(console.error);
  }, [token, user?.is_verified, user?.is_blocked, user?.is_deleted, selectedMonth, filters.sort]);

  return (
    <main className="min-h-screen">
      <section className="border-b border-[#d8e1dc] bg-[#edf4ef]">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[#21745b]">Budgetin</p>
            <h1 className="mt-2 text-4xl font-bold text-[#15221c]">
              {token ? `Dashboard milik ${dashboardOwner}` : 'Catat uang masuk dan keluar.'}
            </h1>
            <p className="mt-3 max-w-2xl text-[#4c5e55]">
              {token
                ? 'Pantau ringkasan, kategori terbesar, dan pola transaksi dari data Telegram.'
                : 'Input cepat lewat Telegram, laporan rapi di dashboard web.'}
            </p>
          </div>
          {token ? (
            <div className="grid gap-3 md:min-w-[360px]">
              <p className="text-sm text-[#4c5e55]">Login sebagai</p>
              <p className="text-lg font-semibold text-[#15221c]">{dashboardOwner}</p>
              {user?.display_name && <p className="text-sm text-[#4c5e55]">{user.phone_number}</p>}
              <button className="rounded border border-[#b33a3a] px-4 py-2 font-semibold text-[#b33a3a]" onClick={logout}>Logout</button>
            </div>
          ) : (
            <div className="grid gap-2 md:min-w-[520px]">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <input className="rounded border border-[#cbd8d1] px-3 py-2" placeholder="+6281234567890" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
                <button className="rounded border border-[#21745b] px-4 py-2 font-semibold text-[#21745b]" onClick={requestOtp}>Kirim OTP</button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <input className="rounded border border-[#cbd8d1] px-3 py-2" placeholder="Kode OTP" value={otpCode} onChange={(event) => setOtpCode(event.target.value)} />
                <button className="rounded bg-[#21745b] px-4 py-2 font-semibold text-white" onClick={verifyOtp}>Masuk</button>
              </div>
              <p className="text-sm text-[#4c5e55]">
                {authMessage || 'Buka bot Telegram Budgetin, tekan /start, lalu share phone number sebelum meminta OTP.'}
              </p>
            </div>
          )}
        </div>
      </section>

      {isBlocked && <StatusPanel title="Akun diblokir" tone="danger">Akun kamu belum bisa menggunakan dashboard Budgetin. Hubungi admin jika menurutmu ini keliru.</StatusPanel>}

      {isDeleted && (
        <StatusPanel title="Akun dinonaktifkan" tone="danger">
          Akun Budgetin kamu sedang dinonaktifkan. Hubungi admin jika ingin recovery.
          {user?.delete_recovery_until ? ` Recovery tersedia sampai ${new Date(user.delete_recovery_until).toLocaleString('id-ID')}.` : ''}
        </StatusPanel>
      )}

      {isPendingVerification && (
        <StatusPanel title="Menunggu verifikasi admin">
          Akun kamu sudah bisa mencatat transaksi lewat Telegram. Dashboard, grafik, transaksi lengkap, dan export CSV akan aktif setelah admin memverifikasi akun kamu.
        </StatusPanel>
      )}

      {token && !(isBlocked || isDeleted || isPendingVerification) ? (
        <section className="mx-auto max-w-6xl px-5 py-8">
          <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-2xl font-bold text-[#15221c]">Laporan {monthLabel(selectedMonth)}</h2>
              <p className="mt-1 text-[#63736b]">Transaksi tetap dicatat lewat Telegram. Web ini fokus untuk membaca kondisi uangmu.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[auto_auto]">
              <input className="rounded border border-[#cbd8d1] px-3 py-2" type="month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} />
              <button className="rounded bg-[#21745b] px-4 py-2 font-semibold text-white disabled:opacity-50" onClick={exportCsv} disabled={!token}>Export CSV</button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Pemasukan" value={formatCurrency(periodTotals.income)} />
            <MetricCard label="Pengeluaran" value={formatCurrency(periodTotals.expense)} tone="danger" />
            <MetricCard label="Saldo" value={formatCurrency(balance)} tone={balance < 0 ? 'danger' : 'success'} />
            <MetricCard label="Transaksi" value={formatNumber(periodTotals.count)} />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
            <div className="rounded border border-[#d8e1dc] bg-white p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="text-xl font-semibold">Statistik {periodLabel(period).toLowerCase()}</h2>
                  <p className="mt-1 text-sm text-[#63736b]">Bandingkan pemasukan dan pengeluaran pada periode yang dipilih.</p>
                </div>
                <div className="grid grid-cols-3 overflow-hidden rounded border border-[#cbd8d1]">
                  {[
                    ['daily', 'Harian'],
                    ['weekly', 'Mingguan'],
                    ['monthly', 'Bulanan'],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={period === value ? 'bg-[#21745b] px-3 py-2 text-sm font-semibold text-white' : 'bg-white px-3 py-2 text-sm font-semibold text-[#4c5e55]'}
                      onClick={() => setPeriod(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <TrendChart data={trend} />
            </div>

            <div className="grid gap-6">
              <DonutChart title="Pengeluaran per kategori" items={expenseSummary} emptyText="Belum ada pengeluaran." />
              <DonutChart title="Pemasukan per kategori" items={incomeSummary} emptyText="Belum ada pemasukan." />
            </div>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
            <div className="rounded border border-[#d8e1dc] bg-white p-5">
              <h2 className="text-xl font-semibold">Insight singkat</h2>
              <div className="mt-4 space-y-3 text-sm text-[#4c5e55]">
                <p>{categoryInsight(expenseSummary)}</p>
                <p>{busyDayInsight(transactions)}</p>
                <p>{balance >= 0 ? 'Saldo periode ini masih positif.' : 'Saldo periode ini minus. Cek kategori pengeluaran terbesar.'}</p>
              </div>
            </div>

            <div className="rounded border border-[#d8e1dc] bg-white">
              <div className="border-b border-[#d8e1dc] p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold">Riwayat transaksi</h2>
                    <p className="mt-1 text-sm text-[#63736b]">Filter data bulan ini sebelum export.</p>
                  </div>
                  <p className="text-sm font-semibold text-[#21745b]">{formatNumber(filteredTotals.count)} transaksi</p>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <select className="rounded border border-[#cbd8d1] px-3 py-2" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value, category: '' })}>
                    <option value="">Semua tipe</option>
                    <option value="income">Pemasukan</option>
                    <option value="expense">Pengeluaran</option>
                  </select>
                  <select className="rounded border border-[#cbd8d1] px-3 py-2" value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
                    <option value="">Semua kategori</option>
                    {(filters.type ? categories[filters.type] : allCategories).map((category) => (
                      <option key={category.code} value={category.code}>{category.label}</option>
                    ))}
                  </select>
                  <select className="rounded border border-[#cbd8d1] px-3 py-2" value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value })}>
                    <option value="newest">Terbaru</option>
                    <option value="oldest">Terlama</option>
                    <option value="amount_desc">Nominal terbesar</option>
                    <option value="amount_asc">Nominal terkecil</option>
                  </select>
                </div>
              </div>
              <div className="divide-y divide-[#eef2ef]">
                {filteredTransactions.map((item) => (
                  <div key={item.id} className="grid gap-2 p-5 sm:grid-cols-[1fr_auto]">
                    <div>
                      <p className="font-semibold">{item.category_label || item.category}</p>
                      <p className="text-sm text-[#63736b]">{item.note || '-'} - {new Date(item.created_at).toLocaleString('id-ID')}</p>
                    </div>
                    <p className={item.type === 'income' ? 'font-bold text-[#21745b]' : 'font-bold text-[#b33a3a]'}>
                      {item.type === 'income' ? '+' : '-'} {formatCurrency(item.amount)}
                    </p>
                  </div>
                ))}
                {!filteredTransactions.length && (
                  <p className="p-5 text-[#63736b]">{token ? 'Belum ada transaksi pada filter ini.' : 'Login untuk mulai.'}</p>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function StatusPanel({ title, children, tone = 'default' }) {
  const color = tone === 'danger' ? '#b33a3a' : '#15221c';
  return (
    <section className="mx-auto max-w-3xl px-5 py-10">
      <div className="rounded border border-[#d8e1dc] bg-white p-6">
        <h2 className="text-2xl font-bold" style={{ color }}>{title}</h2>
        <p className="mt-3 text-[#4c5e55]">{children}</p>
      </div>
    </section>
  );
}

function MetricCard({ label, value, tone = 'default' }) {
  const color = tone === 'danger' ? '#b33a3a' : tone === 'success' ? '#21745b' : '#15221c';
  return (
    <div className="rounded border border-[#d8e1dc] bg-white p-5">
      <p className="text-sm text-[#63736b]">{label}</p>
      <p className="mt-2 text-2xl font-bold" style={{ color }}>{value}</p>
    </div>
  );
}

function DonutChart({ title, items, emptyText }) {
  const total = items.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const gradient = total > 0
    ? items.reduce(
        (parts, item) => {
          const start = parts.cursor;
          const end = start + (Number(item.total || 0) / total) * 360;
          parts.segments.push(`${item.color} ${start}deg ${end}deg`);
          parts.cursor = end;
          return parts;
        },
        { cursor: 0, segments: [] },
      ).segments.join(', ')
    : '#eef2ef 0deg 360deg';

  return (
    <div className="rounded border border-[#d8e1dc] bg-white p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-[150px_1fr] sm:items-center">
        <div
          className="mx-auto grid h-[150px] w-[150px] place-items-center rounded-full"
          style={{ background: `conic-gradient(${gradient})` }}
          aria-label={title}
        >
          <div className="grid h-[86px] w-[86px] place-items-center rounded-full bg-white text-center text-sm font-semibold text-[#15221c]">
            {total > 0 ? formatCurrency(total) : '0'}
          </div>
        </div>
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.category} className="grid gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-[#4c5e55]">
                  <span className="h-3 w-3 rounded-full" style={{ background: item.color }} />
                  {item.category_label}
                </span>
                <span className="text-sm font-semibold">{formatCurrency(item.total)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded bg-[#eef2ef]">
                <div className="h-full rounded" style={{ width: `${total ? (item.total / total) * 100 : 0}%`, background: item.color }} />
              </div>
            </div>
          ))}
          {!items.length && <p className="text-sm text-[#63736b]">{emptyText}</p>}
        </div>
      </div>
    </div>
  );
}

function TrendChart({ data }) {
  const maxValue = Math.max(...data.flatMap((item) => [item.income, item.expense]), 1);

  return (
    <div className="mt-6">
      <div className="flex items-center gap-5 text-sm text-[#4c5e55]">
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-[#21745b]" />Pemasukan</span>
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-[#b33a3a]" />Pengeluaran</span>
      </div>
      <div className="mt-5 grid min-h-[240px] grid-flow-col items-end gap-3 overflow-x-auto border-b border-l border-[#d8e1dc] px-3 pb-3">
        {data.map((item) => (
          <div key={item.label} className="grid min-w-[64px] gap-2">
            <div className="flex h-[170px] items-end justify-center gap-2">
              <div className="w-5 rounded-t bg-[#21745b]" style={{ height: `${Math.max((item.income / maxValue) * 100, item.income ? 4 : 0)}%` }} title={`Pemasukan ${formatCurrency(item.income)}`} />
              <div className="w-5 rounded-t bg-[#b33a3a]" style={{ height: `${Math.max((item.expense / maxValue) * 100, item.expense ? 4 : 0)}%` }} title={`Pengeluaran ${formatCurrency(item.expense)}`} />
            </div>
            <p className="truncate text-center text-xs text-[#63736b]" title={item.label}>{item.label}</p>
          </div>
        ))}
        {!data.length && (
          <div className="min-w-[260px] self-center text-sm text-[#63736b]">Belum ada transaksi pada bulan ini.</div>
        )}
      </div>
    </div>
  );
}
