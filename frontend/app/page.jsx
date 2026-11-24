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
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
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

function jakartaDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function dateKey(date) {
  const parts = jakartaDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function weekKey(date) {
  const parts = jakartaDateParts(date);
  const firstDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1));
  const week = Math.ceil((Number(parts.day) + firstDay.getUTCDay()) / 7);
  return `Minggu ${week}`;
}

function formatDateTimeWib(value) {
  return new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
}

function formatDateWib(value) {
  return new Date(value).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
}

function monthLabel(value) {
  const [year, month] = String(value || '').split('-');
  if (!year || !month) return 'Bulan ini';
  return new Date(Date.UTC(Number(year), Number(month) - 1, 1, 12)).toLocaleDateString('id-ID', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
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

function filterHistory(transactions, filters) {
  return transactions.filter((item) => {
    if (filters.type && item.type !== filters.type) return false;
    if (filters.category && item.category !== filters.category) return false;
    if (filters.subcategory === '__default__' && item.subcategory) return false;
    if (filters.subcategory && filters.subcategory !== '__default__' && item.subcategory !== filters.subcategory) return false;
    if (filters.search) {
      const haystack = `${item.category_label || item.category} ${item.subcategory || ''} ${item.note || ''}`.toLowerCase();
      if (!haystack.includes(filters.search.toLowerCase())) return false;
    }
    return true;
  }).sort((a, b) => {
    if (filters.sort === 'amount_desc') return Number(b.amount) - Number(a.amount);
    if (filters.sort === 'amount_asc') return Number(a.amount) - Number(b.amount);
    const order = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return filters.sort === 'oldest' ? order : -order;
  });
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

function groupBySubcategory(transactions, type, category) {
  const grouped = new Map();
  transactions
    .filter((item) => item.type === type && item.category === category)
    .forEach((item) => {
      const key = item.subcategory || '__default__';
      const current = grouped.get(key) || {
        key,
        label: item.subcategory || 'Tanpa sub-kategori',
        total: 0,
      };
      current.total += Number(item.amount || 0);
      grouped.set(key, current);
    });

  return [...grouped.values()].sort((a, b) => b.total - a.total);
}

function totalForCategory(transactions, type, category) {
  return transactions
    .filter((item) => item.type === type && item.category === category)
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
}

function namedSubcategoryCount(transactions, type, category) {
  return groupBySubcategory(transactions, type, category).filter((item) => item.key !== '__default__').length;
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
        : `${jakartaDateParts(date).year}-${jakartaDateParts(date).month}`;

    const label = period === 'monthly'
      ? date.toLocaleDateString('id-ID', { month: 'short', year: 'numeric', timeZone: 'Asia/Jakarta' })
      : key;
    const current = grouped.get(key) || { label, income: 0, expense: 0 };
    if (item.type === 'income' || item.type === 'expense') current[item.type] += Number(item.amount || 0);
    grouped.set(key, current);
  });

  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}

async function fetchAllTransactions(requestPage, month, signal) {
  const transactions = [];
  const ids = new Set();
  const limit = 500;

  for (let offset = 0; ; offset += limit) {
    if (signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), sort: 'oldest' });
    if (month) params.set('month', month);
    const body = await requestPage(`/transactions?${params.toString()}`, signal);
    if (signal.aborted) throw new DOMException('Dibatalkan', 'AbortError');
    if (!Array.isArray(body.data) || body.data.length > limit) throw new Error('Respons transaksi tidak valid.');
    for (const item of body.data) {
      if (item.id == null || ids.has(item.id)) throw new Error('Halaman transaksi tidak konsisten. Silakan coba lagi.');
      ids.add(item.id);
      transactions.push(item);
    }
    if (body.data.length < limit) return transactions;
  }
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
      const label = date.toLocaleDateString('id-ID', { weekday: 'long', timeZone: 'Asia/Jakarta' });
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
  const [monthlyTrendTransactions, setMonthlyTrendTransactions] = useState([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [dataStatus, setDataStatus] = useState({ key: '', error: '' });
  const [period, setPeriod] = useState('weekly');
  const [selectedMonth, setSelectedMonth] = useState(currentMonthValue());
  const [filters, setFilters] = useState({ type: '', category: '', subcategory: '', sort: 'newest', search: '' });
  const [exportFilters, setExportFilters] = useState({ month: currentMonthValue(), type: '', category: '' });
  const [theme, setTheme] = useState(null);
  const [themeReady, setThemeReady] = useState(false);
  const [activeSection, setActiveSection] = useState('dashboard');
  const [editingTransaction, setEditingTransaction] = useState(null);
  const [editForm, setEditForm] = useState({ type: 'expense', amount: '', category: '', subcategory: '', note: '' });
  const [isBulkSelectMode, setIsBulkSelectMode] = useState(false);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState([]);
  const [isBulkEditModalOpen, setIsBulkEditModalOpen] = useState(false);
  const [bulkEditForm, setBulkEditForm] = useState({ category: '', subcategory: '' });
  const [customCategories, setCustomCategories] = useState([]);
  const [categoryForm, setCategoryForm] = useState({ type: 'expense', parent_category: 'food_drink', name: '' });
  const [categoryMessage, setCategoryMessage] = useState('');
  const [subcategoryView, setSubcategoryView] = useState({ type: 'expense', category: 'food_drink' });
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);
  const [isSubcategoryDrawerOpen, setIsSubcategoryDrawerOpen] = useState(false);
  const [selectedSubcategoryKey, setSelectedSubcategoryKey] = useState('');
  const [isSubcategoryTransactionsModalOpen, setIsSubcategoryTransactionsModalOpen] = useState(false);
  const [subcategoryTransactionsPage, setSubcategoryTransactionsPage] = useState(1);
  const refreshPromiseRef = useRef(null);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const dashboardOwner = user?.display_name || user?.phone_number || 'Budgetin';
  const isDeleted = Boolean(token && user?.is_deleted);
  const isPendingVerification = Boolean(token && user && !user.is_verified && !user.is_blocked && !user.is_deleted);
  const isBlocked = Boolean(token && user?.is_blocked && !user.is_deleted);
  const canViewDashboard = Boolean(token && user?.is_verified && !(isBlocked || isDeleted || isPendingVerification));
  const dataKey = JSON.stringify([token, user?.id, selectedMonth, dataVersion]);
  const dataReady = dataStatus.key === dataKey && !dataStatus.error;
  const dataError = dataStatus.key === dataKey ? dataStatus.error : '';

  const filteredTransactions = useMemo(() => filterHistory(transactions, filters), [transactions, filters]);

  const periodTotals = useMemo(() => summarizeTransactions(transactions), [transactions]);
  const filteredTotals = useMemo(() => summarizeTransactions(filteredTransactions), [filteredTransactions]);
  const selectedTransactions = useMemo(
    () => filteredTransactions.filter((item) => selectedTransactionIds.includes(item.id)),
    [filteredTransactions, selectedTransactionIds],
  );
  const selectedTransactionType = useMemo(() => {
    if (!selectedTransactions.length) return '';
    const uniqueTypes = [...new Set(selectedTransactions.map((item) => item.type))];
    return uniqueTypes.length === 1 ? uniqueTypes[0] : '';
  }, [selectedTransactions]);
  const bulkEditSubcategoryOptions = useMemo(() => {
    if (!selectedTransactionType || !bulkEditForm.category) return [];
    return customCategories.filter((item) => item.type === selectedTransactionType && item.parent_category === bulkEditForm.category);
  }, [customCategories, selectedTransactionType, bulkEditForm.category]);
  const expenseSummary = useMemo(() => groupByCategory(transactions, 'expense'), [transactions]);
  const incomeSummary = useMemo(() => groupByCategory(transactions, 'income'), [transactions]);
  const trendSourceTransactions = period === 'monthly' ? monthlyTrendTransactions : transactions;
  const trend = useMemo(() => buildTrend(trendSourceTransactions, period), [trendSourceTransactions, period]);
  const balance = periodTotals.income - periodTotals.expense;
  const currentSection = sidebarItems.find((item) => item.id === activeSection) || sidebarItems[0];
  const subcategorySummary = useMemo(() => {
    return groupBySubcategory(transactions, subcategoryView.type, subcategoryView.category);
  }, [transactions, subcategoryView.type, subcategoryView.category]);
  const selectedCategoryMeta = categoryMeta[subcategoryView.category];
  const selectedCategoryTotal = subcategorySummary.reduce((sum, item) => sum + item.total, 0);
  const selectedCategorySubcategoryCount = subcategorySummary.filter((item) => item.key !== '__default__').length;
  const currentTypeTotal = subcategoryView.type === 'income' ? periodTotals.income : periodTotals.expense;
  const selectedCategoryShare = currentTypeTotal ? Math.round((selectedCategoryTotal / currentTypeTotal) * 100) : 0;
  const selectedSubcategoryItem = subcategorySummary.find((item) => item.key === selectedSubcategoryKey) || null;
  const selectedSubcategoryTransactions = useMemo(() => {
    if (!selectedSubcategoryKey) return [];
    return transactions
      .filter((item) => {
        if (item.type !== subcategoryView.type || item.category !== subcategoryView.category) return false;
        const itemKey = item.subcategory || '__default__';
        return itemKey === selectedSubcategoryKey;
      })
      .sort((left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime());
  }, [transactions, subcategoryView.type, subcategoryView.category, selectedSubcategoryKey]);
  const subcategoryTransactionsPageSize = 10;
  const subcategoryTransactionsPageCount = Math.max(1, Math.ceil(selectedSubcategoryTransactions.length / subcategoryTransactionsPageSize));
  const paginatedSubcategoryTransactions = useMemo(() => {
    const startIndex = (subcategoryTransactionsPage - 1) * subcategoryTransactionsPageSize;
    return selectedSubcategoryTransactions.slice(startIndex, startIndex + subcategoryTransactionsPageSize);
  }, [selectedSubcategoryTransactions, subcategoryTransactionsPage]);
  const customCategoryGroups = useMemo(() => {
    return customCategories.reduce((groups, item) => {
      const key = `${item.type}:${item.parent_category}`;
      const list = groups.get(key) || [];
      list.push(item);
      groups.set(key, list);
      return groups;
    }, new Map());
  }, [customCategories]);
  const editSubcategoryOptions = useMemo(() => {
    return customCategories.filter((item) => item.type === editForm.type && item.parent_category === editForm.category);
  }, [customCategories, editForm.type, editForm.category]);
  const modalCategoryList = customCategoryGroups.get(`${categoryForm.type}:${categoryForm.parent_category}`) || [];

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

  async function loadCategories() {
    if (!token || !user?.is_verified || user?.is_blocked || user?.is_deleted) {
      setCustomCategories([]);
      return;
    }

    const body = await request('/categories', { headers });
    setCustomCategories(body.custom || []);
  }

  function startEditTransaction(item) {
    setEditingTransaction(item);
    setEditForm({
      type: item.type,
      amount: String(Number(item.amount || 0)),
      category: item.category,
      subcategory: item.subcategory || '',
      note: item.note || '',
    });
  }

  function cancelEditTransaction() {
    setEditingTransaction(null);
    setEditForm({ type: 'expense', amount: '', category: '', subcategory: '', note: '' });
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
        subcategory: editForm.subcategory,
        note: editForm.note,
      }),
    });
    setTransactions((current) => current.map((item) => (item.id === editingTransaction.id ? body.data : item)));
    setMonthlyTrendTransactions((current) => current.map((item) => (item.id === editingTransaction.id ? body.data : item)));
    setDataVersion((current) => current + 1);
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
    setMonthlyTrendTransactions((current) => current.filter((item) => item.id !== itemId));
    setDataVersion((current) => current + 1);
  }

  function toggleBulkSelectMode() {
    setIsBulkSelectMode((current) => {
      if (current) {
        setSelectedTransactionIds([]);
        setIsBulkEditModalOpen(false);
      }
      return !current;
    });
  }

  function toggleTransactionSelection(transactionId) {
    setSelectedTransactionIds((current) => (
      current.includes(transactionId)
        ? current.filter((id) => id !== transactionId)
        : [...current, transactionId]
    ));
  }

  function selectAllVisibleTransactions() {
    setSelectedTransactionIds(filteredTransactions.map((item) => item.id));
  }

  function clearSelectedTransactions() {
    setSelectedTransactionIds([]);
  }

  function openBulkEditModal() {
    if (!selectedTransactions.length || !selectedTransactionType) return;
    setBulkEditForm({
      category: selectedTransactions[0]?.category || categories[selectedTransactionType][0].code,
      subcategory: '',
    });
    setIsBulkEditModalOpen(true);
  }

  function closeBulkEditModal() {
    setIsBulkEditModalOpen(false);
    setBulkEditForm({ category: '', subcategory: '' });
  }

  async function saveBulkTransactionEdit() {
    if (!selectedTransactions.length || !selectedTransactionType) return;

    const updates = await Promise.allSettled(
      selectedTransactions.map((item) => request(`/transactions/${item.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          type: item.type,
          amount: Number(item.amount),
          category: bulkEditForm.category,
          subcategory: bulkEditForm.subcategory,
          note: item.note || '',
        }),
      })),
    );

    const updatedById = new Map();
    let failedCount = 0;
    updates.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        updatedById.set(selectedTransactions[index].id, result.value.data);
      } else {
        failedCount += 1;
      }
    });

    setTransactions((current) => current.map((item) => updatedById.get(item.id) || item));
    setMonthlyTrendTransactions((current) => current.map((item) => updatedById.get(item.id) || item));
    if (updatedById.size > 0) {
      setDataVersion((current) => current + 1);
      setSelectedTransactionIds([]);
      setIsBulkSelectMode(false);
      closeBulkEditModal();
    }
    if (failedCount > 0) {
      window.alert(`${failedCount} transaksi gagal diperbarui. Sisanya berhasil.`);
    }
  }

  async function deleteSelectedTransactions() {
    if (!selectedTransactions.length) return;
    const confirmed = window.confirm(`Hapus ${selectedTransactions.length} transaksi terpilih?`);
    if (!confirmed) return;

    const results = await Promise.allSettled(
      selectedTransactions.map((item) => request(`/transactions/${item.id}`, {
        method: 'DELETE',
        headers,
      })),
    );

    const deletedIds = new Set();
    let failedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        deletedIds.add(selectedTransactions[index].id);
      } else {
        failedCount += 1;
      }
    });

    setTransactions((current) => current.filter((item) => !deletedIds.has(item.id)));
    setMonthlyTrendTransactions((current) => current.filter((item) => !deletedIds.has(item.id)));
    if (deletedIds.size) setDataVersion((current) => current + 1);
    setSelectedTransactionIds([]);
    setIsBulkSelectMode(false);
    if (failedCount > 0) {
      window.alert(`${failedCount} transaksi gagal dihapus. Sisanya berhasil.`);
    }
  }

  async function createCustomCategory() {
    try {
      setCategoryMessage('');
      const body = await request('/categories', {
        method: 'POST',
        headers,
        body: JSON.stringify(categoryForm),
      });
      setCustomCategories((current) => [...current, body.data].sort((a, b) => a.name.localeCompare(b.name, 'id-ID')));
      setCategoryForm((current) => ({ ...current, name: '' }));
      setCategoryMessage('Sub-kategori berhasil ditambahkan.');
    } catch (error) {
      setCategoryMessage(error.message);
    }
  }

  async function removeCustomCategory(categoryId) {
    const confirmed = window.confirm('Hapus sub-kategori ini? Transaksi lama yang masih memakainya akan menolak penghapusan.');
    if (!confirmed) return;
    const removed = customCategories.find((item) => item.id === categoryId);
    try {
      setCategoryMessage('');
      await request(`/categories/${categoryId}`, {
        method: 'DELETE',
        headers,
      });
      setCustomCategories((current) => current.filter((item) => item.id !== categoryId));
      setCategoryMessage('Sub-kategori berhasil dihapus.');
      setEditForm((current) => {
        const shouldClear = removed
          && current.type === removed.type
          && current.category === removed.parent_category
          && current.subcategory === removed.name;
        const stillExists = customCategories.some((item) => item.id !== categoryId && item.type === current.type && item.parent_category === current.category && item.name === current.subcategory);
        return shouldClear && !stillExists ? { ...current, subcategory: '' } : current;
      });
    } catch (error) {
      setCategoryMessage(error.message);
    }
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
    setMonthlyTrendTransactions([]);
    setIsBulkSelectMode(false);
    setSelectedTransactionIds([]);
    setIsBulkEditModalOpen(false);
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
    if (!canViewDashboard) {
      setDataStatus({ key: '', error: '' });
      return;
    }
    const controller = new AbortController();
    const requestPage = (path, signal) => request(path, { headers, signal });

    Promise.all([
      fetchAllTransactions(requestPage, selectedMonth, controller.signal),
      fetchAllTransactions(requestPage, '', controller.signal),
    ]).then(([monthTransactions, allTransactions]) => {
      if (controller.signal.aborted) return;
      setTransactions(monthTransactions);
      setMonthlyTrendTransactions(allTransactions);
      setDataStatus({ key: dataKey, error: '' });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      controller.abort();
      setDataStatus({ key: dataKey, error: error.message || 'Gagal memuat transaksi.' });
    });
    return () => controller.abort();
  }, [token, user?.id, user?.is_verified, user?.is_blocked, user?.is_deleted, selectedMonth, dataVersion]);

  useEffect(() => {
    loadCategories().catch(console.error);
  }, [token, user?.is_verified, user?.is_blocked, user?.is_deleted]);

  useEffect(() => {
    if (!isBulkSelectMode) return;
    const visibleIds = new Set(filteredTransactions.map((item) => item.id));
    setSelectedTransactionIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [isBulkSelectMode, filteredTransactions]);

  useEffect(() => {
    setEditingTransaction(null);
    setIsBulkSelectMode(false);
    setSelectedTransactionIds([]);
    setIsBulkEditModalOpen(false);
    setIsSubcategoryDrawerOpen(false);
    setIsSubcategoryTransactionsModalOpen(false);
  }, [selectedMonth]);

  useEffect(() => {
    if (!isSubcategoryDrawerOpen) return;
    if (!subcategorySummary.length) {
      setSelectedSubcategoryKey('');
      return;
    }

    const stillExists = subcategorySummary.some((item) => item.key === selectedSubcategoryKey);
    if (!stillExists) {
      setSelectedSubcategoryKey(subcategorySummary[0].key);
    }
  }, [isSubcategoryDrawerOpen, subcategorySummary, selectedSubcategoryKey]);

  useEffect(() => {
    if (subcategoryTransactionsPage > subcategoryTransactionsPageCount) {
      setSubcategoryTransactionsPage(subcategoryTransactionsPageCount);
    }
  }, [subcategoryTransactionsPage, subcategoryTransactionsPageCount]);

  function toggleTheme() {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }

  function openCategoryModal() {
    setCategoryMessage('');
    setIsSubcategoryDrawerOpen(false);
    setIsSubcategoryTransactionsModalOpen(false);
    setIsCategoryModalOpen(true);
  }

  function closeCategoryModal() {
    setCategoryMessage('');
    setIsCategoryModalOpen(false);
  }

  function openSubcategoryDrawer(type, category) {
    setSubcategoryView({ type, category });
    setSelectedSubcategoryKey('');
    setIsSubcategoryDrawerOpen(true);
  }

  function closeSubcategoryDrawer() {
    setIsSubcategoryDrawerOpen(false);
    setIsSubcategoryTransactionsModalOpen(false);
  }

  function openSubcategoryTransactionsModal(key) {
    setSelectedSubcategoryKey(key);
    setSubcategoryTransactionsPage(1);
    setIsSubcategoryTransactionsModalOpen(true);
  }

  function closeSubcategoryTransactionsModal() {
    setIsSubcategoryTransactionsModalOpen(false);
    setSubcategoryTransactionsPage(1);
  }

  function openSelectedSubcategoryInHistory() {
    if (!selectedSubcategoryItem) return;

    setFilters({
      type: subcategoryView.type,
      category: subcategoryView.category,
      subcategory: selectedSubcategoryItem.key === '__default__' ? '__default__' : selectedSubcategoryItem.label,
      sort: 'newest',
      search: '',
    });
    setIsSubcategoryTransactionsModalOpen(false);
    setIsSubcategoryDrawerOpen(false);
    setActiveSection('riwayat');
  }

  function selectSection(sectionId) {
    setIsBulkSelectMode(false);
    setSelectedTransactionIds([]);
    setIsBulkEditModalOpen(false);
    setIsSubcategoryDrawerOpen(false);
    setIsSubcategoryTransactionsModalOpen(false);
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
              {dataReady ? <p className="muted-text mt-1 text-sm">{formatNumber(periodTotals.count)} transaksi tercatat</p> : null}
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
                    : 'Gunakan nomor yang terhubung ke Telegram. Jika kode kedaluwarsa, minta OTP lagi. Jangan bagikan kode.'}
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
                    <input className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" type="month" value={selectedMonth} onChange={(event) => { if (event.target.value) setSelectedMonth(event.target.value); }} />
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

          {isBlocked && <StatusPanel title="Akun diblokir" tone="danger">Akun kamu belum bisa menggunakan dashboard Budgetin. Buka bot Telegram Budgetin dan ketik /tentang untuk melihat kontak admin.</StatusPanel>}

          {isDeleted && (
            <StatusPanel title="Akun dinonaktifkan" tone="danger">
              Akun Budgetin kamu sedang dinonaktifkan. Hubungi admin jika ingin recovery.
              {user?.delete_recovery_until ? ` Recovery tersedia sampai ${formatDateTimeWib(user.delete_recovery_until)}.` : ''}
            </StatusPanel>
          )}

          {isPendingVerification && (
            <StatusPanel title="Menunggu verifikasi admin">
              Akun kamu sudah bisa mencatat transaksi lewat Telegram. Dashboard, grafik, transaksi lengkap, dan export CSV akan aktif setelah admin memverifikasi akun kamu.
            </StatusPanel>
          )}

          {canViewDashboard && !dataReady && activeSection !== 'export' ? (
            <section className="surface-card rounded-xl p-6" role={dataError ? 'alert' : 'status'}>
              <p className="heading-text font-semibold">{dataError ? 'Transaksi gagal dimuat' : 'Memuat transaksi...'}</p>
              {dataError ? (
                <>
                  <p className="muted-text mt-2 text-sm">{dataError}</p>
                  <button className="soft-button mt-3 rounded-xl px-3 py-2 text-sm font-semibold" onClick={() => setDataVersion((current) => current + 1)}>Coba lagi</button>
                </>
              ) : null}
            </section>
          ) : null}

          {canViewDashboard && dataReady && activeSection === 'dashboard' ? (
            <>
              <section className="surface-card rounded-[28px] p-5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:p-8">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="brand-text text-xs font-medium uppercase tracking-[0.08em]">Ringkasan periode aktif</p>
                    <h2 className="heading-text mt-3 text-4xl font-bold tracking-tight">{formatCurrency(balance)}</h2>
                    <p className="muted-text mt-2 text-sm leading-6">
                      Selisih pemasukan dan pengeluaran pada periode ini.
                    </p>
                  </div>
                  <div className="surface-soft rounded-full px-4 py-2 text-sm font-semibold brand-text">
                    {monthLabel(selectedMonth)}
                  </div>
                </div>
                <div className="mt-5 grid gap-3 sm:mt-6 sm:gap-4 sm:grid-cols-3">
                  <InlineStat label="Pemasukan" value={formatCurrency(periodTotals.income)} tone="success" />
                  <InlineStat label="Pengeluaran" value={formatCurrency(periodTotals.expense)} tone="danger" />
                  <InlineStat label="Transaksi" value={formatNumber(periodTotals.count)} />
                </div>
              </section>

              <section className="surface-card rounded-[24px] p-5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:p-8">
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
                <TrendChart data={trend} period={period} />
              </section>
            </>
          ) : null}

          {canViewDashboard && dataReady && activeSection === 'kategori' ? (
            <section className="grid gap-5 sm:gap-6">
              <div className="surface-card flex flex-col gap-4 rounded-[24px] p-5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:flex-row sm:items-center sm:justify-between sm:p-6">
                <div className="space-y-1">
                  <h2 className="heading-text text-xl font-semibold tracking-tight">Kategori utama</h2>
                  <p className="muted-text text-sm leading-6">Klik kategori utama untuk membuka detail sub-kategori tanpa memenuhi halaman utama.</p>
                </div>
                <button className="soft-button rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={openCategoryModal}>Kelola sub-kategori</button>
              </div>
              <div className="grid gap-5 sm:gap-6 2xl:grid-cols-2">
                <DonutChart title="Pengeluaran per kategori" items={expenseSummary} emptyText="Belum ada pengeluaran." onSelect={(category) => openSubcategoryDrawer('expense', category)} />
                <DonutChart title="Pemasukan per kategori" items={incomeSummary} emptyText="Belum ada pemasukan." onSelect={(category) => openSubcategoryDrawer('income', category)} />
              </div>
            </section>
          ) : null}

          {canViewDashboard && dataReady && activeSection === 'riwayat' ? (
            <section className="surface-card rounded-[24px] transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md">
              <div className="p-6 sm:p-8">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <h2 className="heading-text text-xl font-semibold tracking-tight">Riwayat transaksi</h2>
                    <p className="muted-text mt-1 text-sm leading-6">Cari, filter, lalu perbaiki transaksi yang salah input dari sini.</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <p className="surface-soft brand-text rounded-full px-3 py-1 text-sm font-semibold">{formatNumber(filteredTotals.count)} transaksi</p>
                    <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={toggleBulkSelectMode}>
                      {isBulkSelectMode ? 'Batal pilih' : 'Pilih banyak'}
                    </button>
                    <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={() => setFilters({ type: '', category: '', subcategory: '', sort: 'newest', search: '' })}>Reset filter</button>
                  </div>
                </div>
                <div className="surface-soft mt-6 grid gap-3 rounded-[20px] p-4 lg:grid-cols-[1.3fr_0.8fr_0.8fr_0.8fr]">
                  <input
                    className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out placeholder:text-[var(--text-soft)] focus:-translate-y-0.5 focus:shadow-md"
                    placeholder="Cari catatan, kategori, atau sub-kategori"
                    value={filters.search}
                    onChange={(event) => setFilters({ ...filters, search: event.target.value })}
                  />
                    <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value, category: '', subcategory: '' })}>
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
                {isBulkSelectMode ? (
                  <div className="surface-soft mt-4 flex flex-col gap-3 rounded-[20px] p-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <p className="heading-text text-sm font-semibold">{formatNumber(selectedTransactions.length)} transaksi dipilih</p>
                      <p className="muted-text mt-1 text-xs">
                        {selectedTransactions.length && !selectedTransactionType ? 'Edit massal hanya bisa untuk transaksi dengan tipe yang sama.' : 'Kamu bisa hapus bersama atau ubah kategori dan sub-kategori sekaligus.'}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={selectAllVisibleTransactions}>
                        Pilih semua terlihat
                      </button>
                      <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={clearSelectedTransactions}>
                        Kosongkan
                      </button>
                      <button className="brand-button rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50" onClick={openBulkEditModal} disabled={!selectedTransactions.length || !selectedTransactionType}>
                        Edit bersama
                      </button>
                      <button className="danger-button rounded-xl px-3 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50" onClick={deleteSelectedTransactions} disabled={!selectedTransactions.length}>
                        Hapus bersama
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="px-3 pb-3 sm:px-4 sm:pb-4">
                {filteredTransactions.map((item) => (
                  <div key={item.id} className={`grid gap-3 rounded-2xl p-4 transition-all duration-200 ease-out hover:bg-[var(--row-hover)] hover:shadow-sm ${isBulkSelectMode ? 'sm:grid-cols-[auto_1fr_auto]' : 'sm:grid-cols-[1fr_auto]'} sm:items-center`}>
                    {isBulkSelectMode ? (
                      <label className="flex items-center justify-center">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-[var(--primary)]"
                          checked={selectedTransactionIds.includes(item.id)}
                          onChange={() => toggleTransactionSelection(item.id)}
                        />
                      </label>
                    ) : null}
                    <div className="min-w-0">
                      <p className="heading-text font-semibold tracking-tight">
                        {item.category_label || item.category}
                        {item.subcategory ? ` - ${item.subcategory}` : ''}
                      </p>
                      <p className="muted-text mt-1 text-sm leading-6">{item.note || '-'} - {formatDateTimeWib(item.created_at)}</p>
                    </div>
                    <div className="flex items-center justify-end gap-3">
                      <p className={item.type === 'income' ? 'brand-text text-right font-bold' : 'danger-text text-right font-bold'}>
                        {item.type === 'income' ? '+' : '-'} {formatCurrency(item.amount)}
                      </p>
                      {!isBulkSelectMode ? (
                        <>
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
                        </>
                      ) : null}
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
                  <p className="muted-text text-sm leading-6">Pilih periode dan filter yang ingin dibawa ke file export. Filter di halaman ini berdiri sendiri, tidak mengikuti riwayat.</p>
                </div>
                <div className="mt-6 grid gap-5">
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
                  <div className="grid gap-3 md:grid-cols-3">
                    <SummaryTile label="1. Periode" value={monthLabel(exportFilters.month)} />
                    <SummaryTile label="2. Tipe" value={exportFilters.type ? (exportFilters.type === 'income' ? 'Pemasukan' : 'Pengeluaran') : 'Semua tipe'} />
                    <SummaryTile label="3. Kategori" value={exportFilters.category ? (allCategories.find((category) => category.code === exportFilters.category)?.label || exportFilters.category) : 'Semua kategori'} />
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

      {canViewDashboard && dataReady && editingTransaction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6">
          <div className="surface-card max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-[24px] p-6 shadow-[var(--shadow-md)] sm:p-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="heading-text text-xl font-semibold tracking-tight">Edit transaksi</h3>
                <p className="muted-text mt-1 text-sm leading-6">Perbarui data yang salah input tanpa menghapus transaksi.</p>
              </div>
              <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold" onClick={cancelEditTransaction}>Tutup</button>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={editForm.type} onChange={(event) => setEditForm({ ...editForm, type: event.target.value, category: categories[event.target.value][0].code, subcategory: '' })}>
                <option value="income">Pemasukan</option>
                <option value="expense">Pengeluaran</option>
              </select>
              <input className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" type="number" min="1" value={editForm.amount} onChange={(event) => setEditForm({ ...editForm, amount: event.target.value })} placeholder="Nominal" />
              <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={editForm.category} onChange={(event) => setEditForm({ ...editForm, category: event.target.value, subcategory: '' })}>
                {categories[editForm.type].map((category) => (
                  <option key={category.code} value={category.code}>{category.label}</option>
                ))}
              </select>
              <select className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md" value={editForm.subcategory} onChange={(event) => setEditForm({ ...editForm, subcategory: event.target.value })}>
                <option value="">Tanpa sub-kategori</option>
                {editSubcategoryOptions.map((subcategory) => (
                  <option key={subcategory.id} value={subcategory.name}>{subcategory.name}</option>
                ))}
              </select>
              <input className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md md:col-span-2" value={editForm.note} onChange={(event) => setEditForm({ ...editForm, note: event.target.value })} placeholder="Catatan" />
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button className="soft-button rounded-2xl px-4 py-3 text-sm font-semibold" onClick={cancelEditTransaction}>Batal</button>
              <button className="brand-button rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={saveTransactionEdit}>Simpan perubahan</button>
            </div>
          </div>
        </div>
      ) : null}

      {canViewDashboard && dataReady && isBulkEditModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6">
          <div className="surface-card w-full max-w-2xl rounded-[24px] p-6 shadow-[var(--shadow-md)] sm:p-8">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="heading-text text-xl font-semibold tracking-tight">Edit transaksi terpilih</h3>
                <p className="muted-text mt-1 text-sm leading-6">
                  Ubah kategori dan sub-kategori untuk {formatNumber(selectedTransactions.length)} transaksi sekaligus.
                </p>
              </div>
              <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold" onClick={closeBulkEditModal}>Tutup</button>
            </div>

            <div className="surface-soft mt-6 rounded-[20px] p-4">
              <p className="heading-text text-sm font-semibold">
                Tipe transaksi: {selectedTransactionType === 'income' ? 'Pemasukan' : 'Pengeluaran'}
              </p>
              <p className="muted-text mt-1 text-xs leading-5">
                Edit massal dibatasi ke kategori dan sub-kategori agar perubahan tetap aman.
              </p>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <select
                className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md"
                value={bulkEditForm.category}
                onChange={(event) => setBulkEditForm({ category: event.target.value, subcategory: '' })}
              >
                {selectedTransactionType ? categories[selectedTransactionType].map((category) => (
                  <option key={category.code} value={category.code}>{category.label}</option>
                )) : null}
              </select>
              <select
                className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md"
                value={bulkEditForm.subcategory}
                onChange={(event) => setBulkEditForm({ ...bulkEditForm, subcategory: event.target.value })}
              >
                <option value="">Tanpa sub-kategori</option>
                {bulkEditSubcategoryOptions.map((subcategory) => (
                  <option key={subcategory.id} value={subcategory.name}>{subcategory.name}</option>
                ))}
              </select>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button className="soft-button rounded-2xl px-4 py-3 text-sm font-semibold" onClick={closeBulkEditModal}>Batal</button>
              <button
                className="brand-button rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md"
                onClick={saveBulkTransactionEdit}
              >
                Simpan perubahan
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {canViewDashboard && dataReady && isSubcategoryDrawerOpen ? (
        <div className="fixed inset-0 z-40 bg-black/35" onClick={closeSubcategoryDrawer}>
          <div className="absolute inset-y-0 right-0 w-full max-w-xl p-3 sm:p-4" onClick={(event) => event.stopPropagation()}>
            <div className="surface-card flex h-full flex-col rounded-[28px] p-5 shadow-[var(--shadow-md)] sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-2">
                  <p className="muted-text text-xs font-medium uppercase tracking-[0.08em]">
                    {subcategoryView.type === 'income' ? 'Pemasukan' : 'Pengeluaran'}
                  </p>
                  <h2 className="heading-text text-2xl font-semibold tracking-tight">
                    {selectedCategoryMeta?.label || 'Kategori'}
                  </h2>
                  <p className="muted-text text-sm leading-6">
                    {subcategorySummary.length ? 'Detail sub-kategori dari kategori utama yang kamu pilih.' : 'Belum ada sub-kategori atau transaksi pada kategori ini.'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button className="soft-button rounded-2xl px-4 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={openCategoryModal}>Kelola sub-kategori</button>
                  <button className="soft-button rounded-2xl px-4 py-2 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={closeSubcategoryDrawer}>Tutup</button>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                <SummaryTile label="Total kategori" value={formatCurrency(selectedCategoryTotal)} accent="success" />
                <SummaryTile label="Sub-kategori aktif" value={`${selectedCategorySubcategoryCount}`} />
                <SummaryTile label="Porsi kategori" value={`${selectedCategoryShare}% dari ${subcategoryView.type === 'income' ? 'pemasukan' : 'pengeluaran'}`} />
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {categories[subcategoryView.type].map((category) => {
                  const isActive = subcategoryView.category === category.code;
                  const total = totalForCategory(transactions, subcategoryView.type, category.code);
                  return (
                    <button
                      key={category.code}
                      className={isActive ? 'rounded-full border border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_10%,var(--surface))] px-4 py-2 text-sm font-semibold brand-text transition-all duration-200 ease-out' : 'surface-soft rounded-full px-4 py-2 text-sm font-semibold muted-text transition-all duration-200 ease-out hover:bg-[var(--surface-muted)] hover:text-[var(--text-primary)]'}
                      onClick={() => setSubcategoryView({ type: subcategoryView.type, category: category.code })}
                    >
                      {category.label} <span className="ml-1 opacity-80">{formatCurrency(total)}</span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 flex-1 overflow-y-auto pr-1">
                <div className="grid gap-3">
                  {subcategorySummary.length ? subcategorySummary.map((item) => {
                    const percentage = selectedCategoryTotal ? (item.total / selectedCategoryTotal) * 100 : 0;
                    const isActive = selectedSubcategoryKey === item.key;
                    return (
                      <button
                        key={item.key}
                        className={isActive
                          ? 'surface-soft w-full rounded-[20px] border border-[var(--primary)] p-4 text-left shadow-sm transition-all duration-200 ease-out'
                          : 'surface-soft w-full rounded-[20px] p-4 text-left transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md'}
                        onClick={() => openSubcategoryTransactionsModal(item.key)}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className={isActive ? 'brand-text text-sm font-semibold' : 'heading-text text-sm font-semibold'}>{item.label}</p>
                            <p className="muted-text mt-1 text-xs">{percentage.toFixed(0)}% dari {selectedCategoryMeta?.label || 'kategori ini'}</p>
                          </div>
                          <p className="heading-text text-sm font-semibold">{formatCurrency(item.total)}</p>
                        </div>
                        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-muted)]">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${percentage}%`,
                              background: selectedCategoryMeta?.color || 'var(--primary)',
                            }}
                          />
                        </div>
                      </button>
                    );
                  }) : (
                    <div className="surface-soft rounded-2xl p-5">
                      <p className="heading-text text-sm font-semibold">Belum ada sub-kategori custom</p>
                      <p className="muted-text mt-2 text-sm">Tambahkan sub-kategori dari tombol kelola agar kategori ini punya detail yang lebih spesifik.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {canViewDashboard && dataReady && isSubcategoryTransactionsModalOpen && selectedSubcategoryItem ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6">
          <div className="surface-card flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-[24px] p-6 shadow-[var(--shadow-md)] sm:p-8">
            <div className="flex flex-col gap-3 border-b border-[var(--border)] pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="muted-text text-xs font-medium uppercase tracking-[0.08em]">
                  {selectedCategoryMeta?.label || 'Kategori'}
                </p>
                <h3 className="heading-text mt-2 text-xl font-semibold tracking-tight">
                  Transaksi dalam {selectedSubcategoryItem.label}
                </h3>
                <p className="muted-text mt-1 text-sm leading-6">
                  {formatNumber(selectedSubcategoryTransactions.length)} transaksi • Halaman {formatNumber(subcategoryTransactionsPage)} dari {formatNumber(subcategoryTransactionsPageCount)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="surface-soft brand-text rounded-full px-3 py-1 text-sm font-semibold">
                  {formatCurrency(selectedSubcategoryItem.total)}
                </p>
                <button
                  className="soft-button rounded-xl px-3 py-2 text-sm font-semibold"
                  onClick={openSelectedSubcategoryInHistory}
                >
                  Buka di riwayat
                </button>
                <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold" onClick={closeSubcategoryTransactionsModal}>Tutup</button>
              </div>
            </div>

            <div className="mt-6 flex-1 overflow-y-auto pr-1">
              <div className="grid gap-3">
              {paginatedSubcategoryTransactions.map((item) => (
                <div key={item.id} className="surface-soft rounded-[18px] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="heading-text truncate text-sm font-semibold">{item.note || 'Tanpa catatan'}</p>
                      <p className="muted-text mt-1 text-xs">
                        {formatDateTimeWib(item.created_at)}
                      </p>
                    </div>
                    <p className={item.type === 'income' ? 'brand-text text-sm font-semibold' : 'danger-text text-sm font-semibold'}>
                      {item.type === 'income' ? '+' : '-'} {formatCurrency(item.amount)}
                    </p>
                  </div>
                </div>
              ))}

              {!selectedSubcategoryTransactions.length ? (
                <div className="surface-soft rounded-2xl p-5">
                  <p className="muted-text text-sm">Belum ada transaksi di sub-kategori ini.</p>
                </div>
              ) : null}
              </div>
            </div>

            {selectedSubcategoryTransactions.length > subcategoryTransactionsPageSize ? (
              <div className="mt-5 flex flex-col gap-3 border-t border-[var(--border)] pt-5 sm:flex-row sm:items-center sm:justify-between">
                <button
                  className="soft-button rounded-xl px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setSubcategoryTransactionsPage((current) => Math.max(1, current - 1))}
                  disabled={subcategoryTransactionsPage === 1}
                >
                  Sebelumnya
                </button>
                <p className="muted-text text-sm sm:text-center">
                  Menampilkan {formatNumber((subcategoryTransactionsPage - 1) * subcategoryTransactionsPageSize + 1)}-
                  {formatNumber(Math.min(subcategoryTransactionsPage * subcategoryTransactionsPageSize, selectedSubcategoryTransactions.length))} dari {formatNumber(selectedSubcategoryTransactions.length)}
                </p>
                <button
                  className="soft-button rounded-xl px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setSubcategoryTransactionsPage((current) => Math.min(subcategoryTransactionsPageCount, current + 1))}
                  disabled={subcategoryTransactionsPage === subcategoryTransactionsPageCount}
                >
                  Berikutnya
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {canViewDashboard && isCategoryModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4 py-6">
          <div className="surface-card max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-[24px] shadow-[var(--shadow-md)]">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-6 py-5 sm:px-8">
              <div>
                <h2 className="heading-text text-xl font-semibold tracking-tight">Kelola sub-kategori</h2>
                <p className="muted-text mt-1 text-sm leading-6">Kategori utama tetap mengikuti struktur Budgetin. Sub-kategori menambah detail tanpa mengubah ringkasan utama.</p>
              </div>
              <button className="soft-button rounded-xl px-3 py-2 text-sm font-semibold" onClick={closeCategoryModal}>Tutup</button>
            </div>

            <div className="grid max-h-[calc(90vh-88px)] gap-6 overflow-y-auto p-6 sm:p-8 xl:grid-cols-[0.95fr_1.05fr]">
              <div className="grid gap-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <select
                    className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md"
                    value={categoryForm.type}
                    onChange={(event) => {
                      const nextType = event.target.value;
                      const nextParent = categories[nextType][0].code;
                      setCategoryForm({ type: nextType, parent_category: nextParent, name: '' });
                    }}
                  >
                    <option value="expense">Pengeluaran</option>
                    <option value="income">Pemasukan</option>
                  </select>
                  <select
                    className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out focus:-translate-y-0.5 focus:shadow-md"
                    value={categoryForm.parent_category}
                    onChange={(event) => setCategoryForm({ ...categoryForm, parent_category: event.target.value })}
                  >
                    {categories[categoryForm.type].map((category) => (
                      <option key={category.code} value={category.code}>{category.label}</option>
                    ))}
                  </select>
                  <input
                    className="field-surface rounded-2xl px-4 py-3 outline-none transition-all duration-200 ease-out placeholder:text-[var(--text-soft)] focus:-translate-y-0.5 focus:shadow-md"
                    value={categoryForm.name}
                    onChange={(event) => setCategoryForm({ ...categoryForm, name: event.target.value })}
                    placeholder="Contoh: Kopi"
                    maxLength={40}
                  />
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="muted-text text-sm">Maksimal 10 sub-kategori per kategori utama.</p>
                  <button className="brand-button rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={createCustomCategory}>Tambah sub-kategori</button>
                </div>
                <p className="muted-text text-sm">{categoryMessage}</p>
              </div>

              <div className="grid gap-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="heading-text text-lg font-semibold tracking-tight">
                      {categories[categoryForm.type].find((item) => item.code === categoryForm.parent_category)?.label || 'Daftar sub-kategori'}
                    </h3>
                    <p className="muted-text mt-1 text-sm">Sub-kategori yang sudah dipakai transaksi lama tidak bisa dihapus.</p>
                  </div>
                  <span className="muted-text text-sm">{modalCategoryList.length}/10</span>
                </div>

                <div className="grid gap-3">
                  {modalCategoryList.length ? modalCategoryList.map((item) => (
                    <div key={item.id} className="surface-soft flex items-center justify-between gap-3 rounded-2xl px-4 py-3">
                      <div>
                        <p className="heading-text text-sm font-semibold">{item.name}</p>
                        <p className="muted-text mt-1 text-xs">{formatDateWib(item.created_at)}</p>
                      </div>
                      <button className="danger-button rounded-xl px-3 py-2 text-xs font-semibold transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md" onClick={() => removeCustomCategory(item.id)}>Hapus</button>
                    </div>
                  )) : (
                    <div className="surface-soft rounded-2xl p-5">
                      <p className="muted-text text-sm">Belum ada sub-kategori custom untuk kategori ini.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
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

function InlineStat({ label, value, tone = 'default' }) {
  const toneClass = tone === 'success'
    ? 'bg-[color-mix(in_srgb,var(--primary)_12%,var(--surface))] border-[color-mix(in_srgb,var(--primary)_18%,transparent)]'
    : tone === 'danger'
      ? 'bg-[color-mix(in_srgb,var(--danger)_12%,var(--surface))] border-[color-mix(in_srgb,var(--danger)_18%,transparent)]'
      : 'bg-[color-mix(in_srgb,var(--surface-soft)_55%,var(--surface))] border-transparent';
  const labelClass = tone === 'success'
    ? 'brand-text'
    : tone === 'danger'
      ? 'danger-text'
      : 'muted-text';
  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <p className={`text-xs font-medium uppercase tracking-[0.08em] ${labelClass}`}>{label}</p>
      <p className="heading-text mt-2 text-lg font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function SummaryTile({ label, value, accent = 'default' }) {
  const accentClass = accent === 'success'
    ? 'border-[var(--primary)]/20 bg-[color-mix(in_srgb,var(--primary)_10%,var(--surface-soft))]'
    : accent === 'danger'
      ? 'border-[var(--danger)]/20 bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface-soft))]'
      : 'border-transparent';
  return (
    <div className={`surface-soft rounded-2xl border p-4 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md ${accentClass}`}>
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

function DonutChart({ title, items, emptyText, onSelect }) {
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
    <div className="surface-card rounded-[24px] p-5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="heading-text text-lg font-semibold">{title}</h2>
        <span className="surface-soft muted-text rounded-full px-3 py-1 text-xs font-semibold">{items.length || 0} kategori</span>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-[156px_1fr] sm:items-center sm:gap-6">
        <div
          className="mx-auto grid h-[150px] w-[150px] place-items-center rounded-full sm:h-[170px] sm:w-[170px]"
          style={{ background: `conic-gradient(${gradient})` }}
          aria-label={title}
        >
          <div className="surface-card heading-text grid h-[88px] w-[88px] place-items-center rounded-full text-center text-sm font-semibold sm:h-[96px] sm:w-[96px]">
            {total > 0 ? formatCurrency(total) : '0'}
          </div>
        </div>
        <div className="space-y-3 sm:space-y-4">
          {items.map((item) => {
            const content = (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="muted-text flex items-center gap-2 text-sm">
                    <span className="h-3 w-3 rounded-full" style={{ background: item.color }} />
                    {item.category_label}
                  </span>
                  <span className="text-sm font-semibold">{formatCurrency(item.total)}</span>
                </div>
                <div className="surface-muted mt-3 h-2 overflow-hidden rounded-full">
                  <div className="h-full rounded" style={{ width: `${total ? (item.total / total) * 100 : 0}%`, background: item.color }} />
                </div>
              </>
            );

            if (!onSelect) {
              return (
                <div key={item.category} className="surface-soft rounded-2xl p-3 sm:p-4">
                  {content}
                </div>
              );
            }

            return (
              <button
                key={item.category}
                className="surface-soft w-full rounded-2xl p-3 text-left transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md sm:p-4"
                onClick={() => onSelect(item.category)}
              >
                {content}
              </button>
            );
          })}
          {!items.length && <p className="muted-text text-sm">{emptyText}</p>}
        </div>
      </div>
    </div>
  );
}

function TrendChart({ data, period }) {
  const maxValue = Math.max(...data.flatMap((item) => [item.income, item.expense]), 1);

  if (!data.length) {
    return (
      <div className="surface-soft mt-5 rounded-[20px] p-5 sm:mt-6 sm:p-6">
        <p className="heading-text text-sm font-semibold">Belum ada aktivitas</p>
        <p className="muted-text mt-2 text-sm">Grafik {periodLabel(period).toLowerCase()} akan muncul setelah ada transaksi di periode ini.</p>
      </div>
    );
  }

  return (
    <div className="surface-muted mt-5 rounded-[20px] p-4 sm:mt-6 sm:p-5">
      <div className="muted-text flex flex-wrap items-center gap-5 text-sm">
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-[var(--primary)]" />Pemasukan</span>
        <span className="flex items-center gap-2"><span className="h-3 w-3 rounded bg-[var(--danger)]" />Pengeluaran</span>
      </div>
      <div className="surface-card mt-4 grid min-h-[220px] grid-flow-col items-end gap-3 overflow-x-auto rounded-[20px] px-3 pb-3 pt-5 sm:mt-5 sm:min-h-[260px] sm:gap-4 sm:px-4 sm:pb-4 sm:pt-6">
        {data.map((item) => (
          <div key={item.label} className="grid min-w-[56px] gap-2 sm:min-w-[64px]">
            <div className="flex h-[150px] items-end justify-center gap-2 sm:h-[170px]">
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
