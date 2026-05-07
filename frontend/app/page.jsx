'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL || '/api';
const storageKey = 'budgetin_session';
const themeStorageKey = 'budgetin_theme';
const sidebarItems = [
  { id: 'dashboard', label: 'Dashboard', caption: 'Ringkasan dan statistik utama', icon: DashboardIcon },
  { id: 'kategori', label: 'Kategori', caption: 'Sebaran pemasukan dan pengeluaran', icon: DonutIcon },
  { id: 'riwayat', label: 'Riwayat', caption: 'Daftar transaksi', icon: ListIcon },
  { id: 'export', label: 'Export', caption: 'Unduh data bulanan', icon: ExportIcon },
];

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
  const [filters, setFilters] = useState({ type: '', category: '', sort: 'newest', search: '' });
  const [exportFilters, setExportFilters] = useState({ month: currentMonthValue(), type: '', category: '' });
  const [theme, setTheme] = useState(null);
  const [themeReady, setThemeReady] = useState(false);
  const [activeSection, setActiveSection] = useState('dashboard');
  const [editingTransaction, setEditingTransaction] = useState(null);
  const [editForm, setEditForm] = useState({ type: 'expense', amount: '', category: '', note: '' });
  const refreshPromiseRef = useRef(null);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const dashboardOwner = user?.display_name || user?.phone_number || 'Budgetin';
  const isDeleted = Boolean(token && user?.is_deleted);
  const isPendingVerification = Boolean(token && user && !user.is_verified && !user.is_blocked && !user.is_deleted);
  const isBlocked = Boolean(token && user?.is_blocked && !user.is_deleted);
  const canViewDashboard = Boolean(token && !(isBlocked || isDeleted || isPendingVerification));

  const filteredTransactions = useMemo(() => {
    return transactions.filter((item) => {
      if (filters.type && item.type !== filters.type) return false;
      if (filters.category && item.category !== filters.category) return false;
      if (filters.search) {
        const haystack = `${item.category_label || item.category} ${item.note || ''}`.toLowerCase();
        if (!haystack.includes(filters.search.toLowerCase())) return false;
      }
      return true;
    });
  }, [transactions, filters.type, filters.category, filters.search]);

  const periodTotals = useMemo(() => summarizeTransactions(transactions), [transactions]);
  const filteredTotals = useMemo(() => summarizeTransactions(filteredTransactions), [filteredTransactions]);
  const expenseSummary = useMemo(() => groupByCategory(transactions, 'expense'), [transactions]);
  const incomeSummary = useMemo(() => groupByCategory(transactions, 'income'), [transactions]);
  const trend = useMemo(() => buildTrend(transactions, period), [transactions, period]);
  const balance = periodTotals.income - periodTotals.expense;
  const currentSection = sidebarItems.find((item) => item.id === activeSection) || sidebarItems[0];

  async function clearSession(message = 'Session berakhir. Silakan login ulang.') {
    sessionStorage.removeItem(storageKey);
    setToken('');
    setUser(null);
    setTransactions([]);
    setOtpCode('');
    setAuthMessage(message);
  }

  async function refreshSession() {
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const response = await fetch(`${apiUrl}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || 'Refresh gagal');
        }

        setUser(body.user);
        setToken(body.token);
        sessionStorage.setItem(storageKey, JSON.stringify({ token: body.token, user: body.user }));
        return body;
      } catch {
        await clearSession();
        return null;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }

  async function request(path, options = {}) {
    const { skipRefresh = false, ...fetchOptions } = options;
    const response = await fetch(`${apiUrl}${path}`, {
      ...fetchOptions,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(fetchOptions.headers || {}),
      },
    });

    const body = await response.json().catch(() => ({}));
    const shouldTryRefresh = response.status === 401
      && !skipRefresh
      && token
      && !['/auth/request-otp', '/auth/verify-otp', '/auth/refresh', '/auth/logout'].includes(path);

    if (shouldTryRefresh) {
      const refreshed = await refreshSession();
      if (refreshed?.token) {
        return request(path, {
          ...options,
          skipRefresh: true,
          headers: {
            ...(fetchOptions.headers || {}),
            Authorization: `Bearer ${refreshed.token}`,
          },
        });
      }
    }

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
      sessionStorage.setItem(storageKey, JSON.stringify({ token: body.token, user: body.user }));
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
    if (filters.search.trim()) params.set('search', filters.search.trim());

    const transactionBody = await request(`/transactions?${params.toString()}`, { headers });
    setTransactions(transactionBody.data);
  }

  function startEditTransaction(item) {
    setEditingTransaction(item);
    setEditForm({
      type: item.type,
      amount: String(Number(item.amount || 0)),
      category: item.category,
      note: item.note || '',
    });
  }

  function cancelEditTransaction() {
    setEditingTransaction(null);
    setEditForm({ type: 'expense', amount: '', category: '', note: '' });
  }

  async function saveTransactionEdit() {
    if (!editingTransaction) return;
    const body = await request(`/transactions/${editingTransaction.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        type: editForm.type,
        amount: Number(editForm.amount),
        category: editForm.category,
        note: editForm.note,
      }),
    });
    setTransactions((current) => current.map((item) => (item.id === editingTransaction.id ? body.data : item)));
    cancelEditTransaction();
  }

  async function deleteTransaction(itemId) {
    if (!token) return;
    const confirmed = window.confirm('Hapus transaksi ini?');
    if (!confirmed) return;

    await request(`/transactions/${itemId}`, {
      method: 'DELETE',
      headers,
    });
    setTransactions((current) => current.filter((item) => item.id !== itemId));
  }

  async function exportCsv() {
    if (!token) return;
    const params = new URLSearchParams({ month: exportFilters.month });
    if (exportFilters.type) params.set('type', exportFilters.type);
    if (exportFilters.category) params.set('category', exportFilters.category);

    let exportHeaders = headers;
    let response = await fetch(`${apiUrl}/exports/transactions.csv?${params.toString()}`, {
      headers: exportHeaders,
      credentials: 'include',
    });
    if (response.status === 401) {
      const refreshed = await refreshSession();
      if (refreshed?.token) {
        exportHeaders = { Authorization: `Bearer ${refreshed.token}` };
        response = await fetch(`${apiUrl}/exports/transactions.csv?${params.toString()}`, {
          headers: exportHeaders,
          credentials: 'include',
        });
      }
    }
    if (!response.ok) throw new Error('Export gagal');

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `budgetin-export-${exportFilters.month}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  }

  async function logout() {
    try {
      await fetch(`${apiUrl}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch {
      // Logout tetap membersihkan sesi lokal walau revoke gagal.
    }

    sessionStorage.removeItem(storageKey);
    setToken('');
    setUser(null);
    setTransactions([]);
    setOtpCode('');
    setAuthMessage('Kamu sudah logout.');
  }

  useEffect(() => {
    const resolvedTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    setTheme(resolvedTheme);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    const saved = sessionStorage.getItem(storageKey);
    if (!saved) return;

    try {
      const session = JSON.parse(saved);
      if (!session.token) return;
      setToken(session.token);
      setUser(session.user || null);
      setAuthMessage('Session dipulihkan.');
    } catch {
      sessionStorage.removeItem(storageKey);
    }
  }, []);

  useEffect(() => {
    if (!token) return;

    request('/me', { headers })
      .then((body) => {
        setUser(body.user);
        sessionStorage.setItem(storageKey, JSON.stringify({ token, user: body.user }));
      })
      .catch(() => clearSession());
  }, [token]);

  useEffect(() => {
    loadData().catch(console.error);
  }, [token, user?.is_verified, user?.is_blocked, user?.is_deleted, selectedMonth, filters.sort, filters.search]);

  function toggleTheme() {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  function selectSection(sectionId) {
    setActiveSection(sectionId);
  }

  if (!themeReady) return null;

  return (
    <main className="min-h-screen bg-[var(--bg)]">
      <div className="mx-auto flex max-w-[1600px] gap-6 px-4 py-4 lg:px-6">
        {token ? (
          <aside className="surface-card hidden min-h-[calc(100vh-2rem)] w-80 shrink-0 rounded-[24px] p-6 lg:flex lg:flex-col">
            <div className="space-y-3">
              <div className="flex justify-center">
                <img
                  className="h-20 w-auto max-w-[260px] object-contain"
                  src={theme === 'dark' ? '/logotransparandarkmode.png' : '/logotransparan.png'}
                  alt="Budgetin"
                />
              </div>

              <div>
                <p className="heading-text text-base font-semibold tracking-tight">
                  {dashboardOwner}
                </p>
                <p className="muted-text text-sm">
                  Dashboard pribadi
                </p>
              </div>
            </div>

            <nav className="mt-8 space-y-2">
              {sidebarItems.map((item) => (
                <button
                  key={item.label}
                  className={activeSection === item.id ? 'w-full rounded-2xl bg-[var(--surface-soft)] px-4 py-3 text-left' : 'w-full rounded-2xl px-4 py-3 text-left transition-colors duration-200 hover:bg-[var(--surface-muted)]'}
                  onClick={() => selectSection(item.id)}
                >
                  <div className="flex items-start gap-3">
                    <span className={activeSection === item.id ? 'brand-text mt-0.5' : 'muted-text mt-0.5'}>
                      <item.icon />
                    </span>
                    <div>
                      <p className={activeSection === item.id ? 'brand-text text-sm font-semibold' : 'heading-text text-sm font-semibold'}>{item.label}</p>
                      <p className="muted-text mt-1 text-xs">{item.caption}</p>
                    </div>
                  </div>
                </button>
              ))}
            </nav>

            <div className="mt-8 rounded-2xl bg-[var(--surface-soft)] p-4">
              <p className="muted-text text-xs font-medium uppercase tracking-[0.08em]">Periode aktif</p>
              <p className="heading-text mt-2 text-base font-semibold">{monthLabel(selectedMonth)}</p>
              <p className="muted-text mt-1 text-sm">{formatNumber(periodTotals.count)} transaksi tercatat</p>
            </div>

            <div className="mt-auto space-y-3 pt-8">
              <button
                className="soft-button flex w-full items-center justify-between rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
                onClick={toggleTheme}
              >
                <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
              </button>
              <button className="danger-button w-full rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={logout}>Logout</button>
            </div>
          </aside>
        ) : null}

        <div className="flex-1 space-y-6">
          <header className="surface-card rounded-[24px] p-5 sm:p-6">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
              <div className="space-y-2">
                <p className="muted-text text-sm font-medium uppercase tracking-[0.08em]">{canViewDashboard ? 'Dashboard' : 'Akses dashboard'}</p>
                <h1 className="heading-text text-2xl font-bold tracking-tight sm:text-3xl">
                  {canViewDashboard ? `${currentSection.label} ${monthLabel(selectedMonth)}` : 'Masuk ke dashboard Budgetin'}
                </h1>
                <p className="muted-text max-w-2xl text-sm leading-6">
                  {canViewDashboard
                    ? currentSection.caption
                    : 'Gunakan nomor Telegram yang sudah terhubung untuk melihat seluruh catatan dan statistik kamu.'}
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                <button
                  className="soft-button flex items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
                  onClick={toggleTheme}
                >
                  <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
                  <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
                </button>
                {canViewDashboard ? (
                  <>
                    <input className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" type="month" value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)} />
                    <button className="danger-button rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md lg:hidden" onClick={logout}>Logout</button>
                  </>
                ) : null}
              </div>
            </div>
          </header>

          {canViewDashboard ? (
            <section className="surface-card rounded-[24px] p-3 lg:hidden">
              <div className="flex gap-2 overflow-x-auto">
                {sidebarItems.map((item) => (
                  <button
                    key={item.id}
                    className={activeSection === item.id ? 'rounded-2xl bg-[var(--surface-soft)] px-4 py-3 text-sm font-semibold brand-text whitespace-nowrap' : 'rounded-2xl px-4 py-3 text-sm font-semibold heading-text whitespace-nowrap transition-colors duration-200 hover:bg-[var(--surface-muted)]'}
                    onClick={() => selectSection(item.id)}
                  >
                    <span className="inline-flex items-center gap-2">
                      <item.icon />
                      {item.label}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          {!token && (
            <section className="surface-card mx-auto w-full max-w-2xl rounded-[24px] p-6 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:p-8">
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <input className="field-surface heading-text rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out placeholder:text-[var(--text-soft)] focus:-translate-y-0.5 focus:shadow-md" placeholder="+6281234567890" value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} />
                  <button className="soft-button rounded-2xl px-4 py-3 font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={requestOtp}>Kirim OTP</button>
                </div>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <input className="field-surface heading-text rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out placeholder:text-[var(--text-soft)] focus:-translate-y-0.5 focus:shadow-md" placeholder="Kode OTP" value={otpCode} onChange={(event) => setOtpCode(event.target.value)} />
                  <button className="brand-button rounded-2xl px-4 py-3 font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={verifyOtp}>Masuk</button>
                </div>
                <p className="muted-text text-sm">{authMessage || 'Masuk untuk melihat dashboard pribadi kamu.'}</p>
              </div>
            </section>
          )}

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

          {canViewDashboard && activeSection === 'dashboard' ? (
            <>
              <section className="grid gap-5 sm:grid-cols-2 2xl:grid-cols-4">
                <MetricCard label="Pemasukan" value={formatCurrency(periodTotals.income)} />
                <MetricCard label="Pengeluaran" value={formatCurrency(periodTotals.expense)} tone="danger" />
                <MetricCard label="Saldo" value={formatCurrency(balance)} tone={balance < 0 ? 'danger' : 'success'} featured={balance >= 0} />
                <MetricCard label="Transaksi" value={formatNumber(periodTotals.count)} />
              </section>

              <section className="grid gap-6 2xl:grid-cols-[1.55fr_0.85fr]">
                <div className="surface-card rounded-[24px] p-6 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:p-8">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="space-y-1">
                      <h2 className="heading-text text-xl font-semibold tracking-tight">Aktivitas transaksi</h2>
                      <p className="muted-text text-sm leading-6">Perbandingan pemasukan dan pengeluaran pada periode yang sedang dipilih.</p>
                    </div>
                    <div className="surface-soft grid grid-cols-3 gap-2 rounded-2xl p-1 shadow-sm">
                      {[
                        ['daily', 'Harian'],
                        ['weekly', 'Mingguan'],
                        ['monthly', 'Bulanan'],
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          className={period === value ? 'rounded-xl bg-[var(--primary)] px-3 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 ease-out' : 'muted-text rounded-xl px-3 py-2 text-sm font-semibold transition-colors duration-200 ease-out hover:bg-[var(--surface)] hover:text-[var(--text-primary)]'}
                          onClick={() => setPeriod(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <TrendChart data={trend} />
                </div>

                <div className="surface-card rounded-[24px] p-6 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md">
                  <h2 className="heading-text text-lg font-semibold tracking-tight">Ringkasan utama</h2>
                  <div className="mt-5 grid gap-4">
                    <SummaryTile label="Kategori terbesar" value={categoryInsight(expenseSummary)} />
                    <SummaryTile label="Pola harian" value={busyDayInsight(transactions)} />
                    <SummaryTile label="Status saldo" value={balance >= 0 ? 'Saldo periode ini masih positif.' : 'Saldo periode ini sedang minus.'} />
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {canViewDashboard && activeSection === 'kategori' ? (
            <section className="grid gap-6 2xl:grid-cols-2">
              <DonutChart title="Pengeluaran per kategori" items={expenseSummary} emptyText="Belum ada pengeluaran." />
              <DonutChart title="Pemasukan per kategori" items={incomeSummary} emptyText="Belum ada pemasukan." />
            </section>
          ) : null}

          {canViewDashboard && activeSection === 'riwayat' ? (
            <section className="surface-card rounded-[24px] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md">
              <div className="p-6 sm:p-8">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="heading-text text-xl font-semibold tracking-tight">Riwayat transaksi</h2>
                    <p className="muted-text mt-1 text-sm leading-6">Filter transaksi berdasarkan tipe, kategori, dan urutan data.</p>
                  </div>
                  <p className="surface-soft brand-text rounded-full px-3 py-1 text-sm font-semibold">{formatNumber(filteredTotals.count)} transaksi</p>
                </div>
                <div className="mt-6 grid gap-3 md:grid-cols-3">
                  <input
                    className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out placeholder:text-[var(--text-soft)] focus:-translate-y-0.5 focus:shadow-md md:col-span-3"
                    placeholder="Cari catatan atau kategori"
                    value={filters.search}
                    onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                  />
                  <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value, category: '' })}>
                    <option value="">Semua tipe</option>
                    <option value="income">Pemasukan</option>
                    <option value="expense">Pengeluaran</option>
                  </select>
                  <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
                    <option value="">Semua kategori</option>
                    {(filters.type ? categories[filters.type] : allCategories).map((category) => (
                      <option key={category.code} value={category.code}>{category.label}</option>
                    ))}
                  </select>
                  <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={filters.sort} onChange={(event) => setFilters({ ...filters, sort: event.target.value })}>
                    <option value="newest">Terbaru</option>
                    <option value="oldest">Terlama</option>
                    <option value="amount_desc">Nominal terbesar</option>
                    <option value="amount_asc">Nominal terkecil</option>
                  </select>
                </div>
              </div>
              {editingTransaction ? (
                <div className="border-b border-[var(--border)] px-6 pb-6 sm:px-8">
                  <div className="surface-soft rounded-[20px] p-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="heading-text text-lg font-semibold tracking-tight">Edit transaksi</h3>
                        <p className="muted-text text-sm">Perbarui data yang salah input tanpa hapus transaksi.</p>
                      </div>
                      <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold" onClick={cancelEditTransaction}>Batal</button>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={editForm.type} onChange={(event) => setEditForm({ ...editForm, type: event.target.value, category: categories[event.target.value][0].code })}>
                        <option value="income">Pemasukan</option>
                        <option value="expense">Pengeluaran</option>
                      </select>
                      <input className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" type="number" min="1" value={editForm.amount} onChange={(event) => setEditForm({ ...editForm, amount: event.target.value })} placeholder="Nominal" />
                      <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value })}>
                        {categories[editForm.type].map((category) => (
                          <option key={category.code} value={category.code}>{category.label}</option>
                        ))}
                      </select>
                      <input className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={editForm.note} onChange={(event) => setEditForm({ ...editForm, note: event.target.value })} placeholder="Catatan" />
                    </div>
                    <div className="mt-4 flex justify-end">
                      <button className="brand-button rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={saveTransactionEdit}>Simpan perubahan</button>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="px-3 pb-3 sm:px-4 sm:pb-4">
                {filteredTransactions.map((item) => (
                  <div key={item.id} className="grid gap-3 rounded-2xl p-4 transition-all duration-200 ease-out hover:bg-[var(--row-hover)] hover:shadow-sm sm:grid-cols-[1fr_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className="heading-text font-semibold tracking-tight">{item.category_label || item.category}</p>
                      <p className="muted-text mt-1 text-sm leading-6">{item.note || '-'} - {new Date(item.created_at).toLocaleString('id-ID')}</p>
                    </div>
                    <div className="flex items-center justify-end gap-3">
                      <p className={item.type === 'income' ? 'brand-text text-right font-bold' : 'danger-text text-right font-bold'}>
                        {item.type === 'income' ? '+' : '-'} {formatCurrency(item.amount)}
                      </p>
                      <button
                        className="soft-button rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
                        onClick={() => startEditTransaction(item)}
                      >
                        Edit
                      </button>
                      <button
                        className="danger-button rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
                        onClick={() => deleteTransaction(item.id)}
                      >
                        Hapus
                      </button>
                    </div>
                  </div>
                ))}
                {!filteredTransactions.length && (
                  <p className="muted-text rounded-2xl px-4 py-5 text-sm">{token ? 'Belum ada transaksi pada filter ini.' : 'Login untuk mulai.'}</p>
                )}
              </div>
            </section>
          ) : null}

          {canViewDashboard && activeSection === 'export' ? (
            <section className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
              <div className="surface-card rounded-[24px] p-6 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:p-8">
                <div className="space-y-2">
                  <h2 className="heading-text text-xl font-semibold tracking-tight">Export data</h2>
                  <p className="muted-text text-sm leading-6">Unduh data transaksi berdasarkan filter export di halaman ini, tanpa mengikuti filter riwayat.</p>
                </div>
                <div className="mt-6 grid gap-4">
                  <div className="grid gap-4 md:grid-cols-3">
                    <input className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" type="month" value={exportFilters.month} onChange={(event) => setExportFilters({ ...exportFilters, month: event.target.value })} />
                    <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={exportFilters.type} onChange={(event) => setExportFilters({ ...exportFilters, type: event.target.value, category: '' })}>
                      <option value="">Semua tipe</option>
                      <option value="income">Pemasukan</option>
                      <option value="expense">Pengeluaran</option>
                    </select>
                    <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={exportFilters.category} onChange={(event) => setExportFilters({ ...exportFilters, category: event.target.value })}>
                      <option value="">Semua kategori</option>
                      {(exportFilters.type ? categories[exportFilters.type] : allCategories).map((category) => (
                        <option key={category.code} value={category.code}>{category.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex justify-start">
                    <button className="brand-button rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50" onClick={exportCsv} disabled={!token}>Export CSV</button>
                  </div>
                </div>
              </div>

              <div className="surface-card rounded-[24px] p-6 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md">
                <h2 className="heading-text text-lg font-semibold tracking-tight">Ringkasan export</h2>
                <div className="mt-5 grid gap-4">
                  <SummaryTile label="Bulan export" value={monthLabel(exportFilters.month)} />
                  <SummaryTile label="Tipe aktif" value={exportFilters.type ? (exportFilters.type === 'income' ? 'Pemasukan' : 'Pengeluaran') : 'Semua tipe'} />
                  <SummaryTile label="Kategori aktif" value={exportFilters.category ? (allCategories.find((category) => category.code === exportFilters.category)?.label || exportFilters.category) : 'Semua kategori'} />
                </div>
              </div>
            </section>
          ) : null}

          <footer className="pb-2 pt-2 text-center">
            <p className="muted-text text-xs">© 2026 Budgetin by Roy Davita Handoko</p>
          </footer>
        </div>
      </div>
    </main>
  );
}

function StatusPanel({ title, children, tone = 'default' }) {
  const color = tone === 'danger' ? 'var(--danger)' : 'var(--text-primary)';
  return (
    <section className="w-full">
      <div className="surface-card rounded-xl p-6">
        <h2 className="text-2xl font-bold" style={{ color }}>{title}</h2>
        <p className="muted-text mt-3">{children}</p>
      </div>
    </section>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div className="surface-soft rounded-2xl p-4 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md">
      <p className="muted-text text-xs font-medium uppercase tracking-[0.08em]">{label}</p>
      <p className="heading-text mt-2 text-sm font-semibold leading-6">{value}</p>
    </div>
  );
}

function SidebarIcon({ children }) {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" className="h-5 w-5">
        {children}
      </svg>
    </span>
  );
}

function DashboardIcon() {
  return (
    <SidebarIcon>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="11" y="3" width="6" height="10" rx="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1.5" />
      <rect x="11" y="15" width="6" height="2" rx="1" />
    </SidebarIcon>
  );
}

function DonutIcon() {
  return (
    <SidebarIcon>
      <path d="M10 3a7 7 0 1 0 7 7h-4a3 3 0 1 1-3-3V3Z" />
      <path d="M12.5 3.5A7 7 0 0 1 17 8h-4.2A3.1 3.1 0 0 0 10 5.2V3c.9 0 1.7.2 2.5.5Z" />
    </SidebarIcon>
  );
}

function ListIcon() {
  return (
    <SidebarIcon>
      <path d="M6 5h10" />
      <path d="M6 10h10" />
      <path d="M6 15h10" />
      <circle cx="3.5" cy="5" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="15" r="1" fill="currentColor" stroke="none" />
    </SidebarIcon>
  );
}

function ExportIcon() {
  return (
    <SidebarIcon>
      <path d="M10 3v8" />
      <path d="m6.5 8.5 3.5 3.5 3.5-3.5" />
      <path d="M4 14.5V16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-1.5" />
    </SidebarIcon>
  );
}

function MetricCard({ label, value, tone = 'default', featured = false }) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'success' ? 'var(--primary)' : 'var(--text-primary)';
  return (
    <div className={featured ? 'rounded-[24px] bg-[var(--primary)] p-5 text-white shadow-[var(--shadow-md)] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md' : 'surface-card rounded-[24px] p-5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md'}>
      <div className="flex items-start justify-between gap-3">
        <div className={featured ? 'grid h-10 w-10 place-items-center rounded-2xl bg-white/15 text-lg' : 'surface-soft grid h-10 w-10 place-items-center rounded-2xl text-lg brand-text'}>
          <span aria-hidden="true">{tone === 'danger' ? '↓' : tone === 'success' ? '↑' : '•'}</span>
        </div>
        <span className={featured ? 'text-white/80' : 'muted-text'} aria-hidden="true">•••</span>
      </div>
      <p className={featured ? 'mt-5 text-xs font-medium uppercase tracking-[0.08em] text-white/80' : 'muted-text mt-5 text-xs font-medium uppercase tracking-[0.08em]'}>{label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight" style={{ color: featured ? '#ffffff' : color }}>{value}</p>
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
    : 'var(--surface-soft) 0deg 360deg';

  return (
    <div className="surface-card rounded-xl p-6 transition-shadow hover:shadow-md">
      <h2 className="heading-text text-lg font-semibold">{title}</h2>
      <div className="mt-5 grid gap-6 sm:grid-cols-[170px_1fr] sm:items-center">
        <div
          className="mx-auto grid h-[170px] w-[170px] place-items-center rounded-full"
          style={{ background: `conic-gradient(${gradient})` }}
          aria-label={title}
        >
          <div className="surface-card heading-text grid h-[96px] w-[96px] place-items-center rounded-full text-center text-sm font-semibold">
            {total > 0 ? formatCurrency(total) : '0'}
          </div>
        </div>
        <div className="space-y-4">
          {items.map((item) => (
            <div key={item.category} className="grid gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="muted-text flex items-center gap-2 text-sm">
                  <span className="h-3 w-3 rounded-full" style={{ background: item.color }} />
                  {item.category_label}
                </span>
                <span className="text-sm font-semibold">{formatCurrency(item.total)}</span>
              </div>
              <div className="surface-soft h-2 overflow-hidden rounded">
                <div className="h-full rounded" style={{ width: `${total ? (item.total / total) * 100 : 0}%`, background: item.color }} />
              </div>
            </div>
          ))}
          {!items.length && <p className="muted-text text-sm">{emptyText}</p>}
        </div>
      </div>
    </div>
  );
}

function TrendChart({ data }) {
  const maxValue = Math.max(...data.flatMap((item) => [item.income, item.expense]), 1);

  return (
    <div className="surface-muted mt-6 rounded-xl p-4">
      <div className="muted-text flex flex-wrap items-center gap-5 text-sm">
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-[var(--primary)]" />Pemasukan</span>
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-[var(--danger)]" />Pengeluaran</span>
      </div>
      <div className="surface-card mt-5 grid min-h-[260px] grid-flow-col items-end gap-4 overflow-x-auto rounded-xl px-4 pb-4 pt-6">
        {data.map((item) => (
          <div key={item.label} className="grid min-w-[64px] gap-2">
            <div className="flex h-[170px] items-end justify-center gap-2">
              <div className="w-5 rounded-t bg-[var(--primary)]" style={{ height: `${Math.max((item.income / maxValue) * 100, item.income ? 4 : 0)}%` }} title={`Pemasukan ${formatCurrency(item.income)}`} />
              <div className="w-5 rounded-t bg-[var(--danger)]" style={{ height: `${Math.max((item.expense / maxValue) * 100, item.expense ? 4 : 0)}%` }} title={`Pengeluaran ${formatCurrency(item.expense)}`} />
            </div>
            <p className="muted-text truncate text-center text-xs" title={item.label}>{item.label}</p>
          </div>
        ))}
        {!data.length && (
          <div className="muted-text min-w-[260px] self-center text-sm">Belum ada transaksi pada bulan ini.</div>
        )}
      </div>
    </div>
  );
}
