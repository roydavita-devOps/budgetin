'use client';

import { useEffect, useMemo, useState } from 'react';

const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

function formatCurrency(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export default function Home() {
  const [email, setEmail] = useState('demo@budgetin.local');
  const [password, setPassword] = useState('secret123');
  const [token, setToken] = useState('');
  const [summary, setSummary] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [form, setForm] = useState({ type: 'expense', amount: '', category: 'food', note: '' });
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  async function request(path, options = {}) {
    const response = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function login(mode = 'login') {
    const body = await request(`/auth/${mode}`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(body.token);
  }

  async function loadData() {
    if (!token) return;
    const [summaryBody, transactionBody] = await Promise.all([
      request('/analytics/summary', { headers }),
      request('/transactions', { headers }),
    ]);
    setSummary(summaryBody.data);
    setTransactions(transactionBody.data);
  }

  async function addTransaction(event) {
    event.preventDefault();
    await request('/transactions', {
      method: 'POST',
      headers,
      body: JSON.stringify(form),
    });
    setForm({ type: 'expense', amount: '', category: 'food', note: '' });
    await loadData();
  }

  useEffect(() => {
    loadData().catch(console.error);
  }, [token]);

  return (
    <main className="min-h-screen">
      <section className="border-b border-[#d8e1dc] bg-[#edf4ef]">
        <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-8 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.08em] text-[#21745b]">Budgetin</p>
            <h1 className="mt-2 text-4xl font-bold text-[#15221c]">Catat uang masuk dan keluar.</h1>
            <p className="mt-3 max-w-2xl text-[#4c5e55]">
              Dashboard sederhana untuk transaksi harian, ringkasan saldo, dan input cepat via Telegram.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <input className="rounded border border-[#cbd8d1] px-3 py-2" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className="rounded border border-[#cbd8d1] px-3 py-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="flex gap-2">
              <button className="rounded bg-[#21745b] px-4 py-2 font-semibold text-white" onClick={() => login('login')}>Login</button>
              <button className="rounded border border-[#21745b] px-4 py-2 font-semibold text-[#21745b]" onClick={() => login('register')}>Register</button>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[1fr_1.3fr]">
        <div className="rounded border border-[#d8e1dc] bg-white p-5">
          <h2 className="text-xl font-semibold">Tambah transaksi</h2>
          <form className="mt-4 grid gap-3" onSubmit={addTransaction}>
            <select className="rounded border border-[#cbd8d1] px-3 py-2" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
            <input className="rounded border border-[#cbd8d1] px-3 py-2" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            <input className="rounded border border-[#cbd8d1] px-3 py-2" placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            <textarea className="rounded border border-[#cbd8d1] px-3 py-2" placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            <button className="rounded bg-[#21745b] px-4 py-2 font-semibold text-white" disabled={!token}>Simpan</button>
          </form>
        </div>

        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ['Income', summary?.income],
              ['Expense', summary?.expense],
              ['Balance', summary?.balance],
            ].map(([label, value]) => (
              <div key={label} className="rounded border border-[#d8e1dc] bg-white p-5">
                <p className="text-sm text-[#63736b]">{label}</p>
                <p className="mt-2 text-2xl font-bold">{formatCurrency(value)}</p>
              </div>
            ))}
          </div>

          <div className="rounded border border-[#d8e1dc] bg-white">
            <div className="border-b border-[#d8e1dc] p-5">
              <h2 className="text-xl font-semibold">Transaksi terbaru</h2>
            </div>
            <div className="divide-y divide-[#eef2ef]">
              {transactions.map((item) => (
                <div key={item.id} className="grid gap-2 p-5 sm:grid-cols-[1fr_auto]">
                  <div>
                    <p className="font-semibold">{item.category}</p>
                    <p className="text-sm text-[#63736b]">{item.note || '-'} · {new Date(item.created_at).toLocaleString('id-ID')}</p>
                  </div>
                  <p className={item.type === 'income' ? 'font-bold text-[#21745b]' : 'font-bold text-[#b33a3a]'}>
                    {item.type === 'income' ? '+' : '-'} {formatCurrency(item.amount)}
                  </p>
                </div>
              ))}
              {!transactions.length && (
                <p className="p-5 text-[#63736b]">{token ? 'Belum ada transaksi.' : 'Login atau register untuk mulai.'}</p>
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
