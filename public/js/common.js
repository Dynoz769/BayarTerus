// Utiliti dikongsi oleh halaman BayarTerus.
const BT = {
  async api(url, { method = 'GET', body, mode } = {}) {
    const headers = { 'X-Requested-With': 'BayarTerus' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (mode) headers['X-Mode'] = mode;
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Ralat ${res.status}`);
      err.status = res.status;
      err.code = data?.error?.code;
      throw err;
    }
    return data;
  },

  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  },

  money(v) {
    return `RM${Number(v || 0).toLocaleString('ms-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  },

  date(ts) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString('ms-MY', { dateStyle: 'medium', timeStyle: 'short' });
  },

  STATUS: {
    pending: 'Menunggu',
    processing: 'Diproses',
    succeeded: 'Berjaya',
    failed: 'Gagal',
    cancelled: 'Dibatalkan',
    expired: 'Tamat tempoh',
    refunded: 'Direfund',
    partially_refunded: 'Refund separa',
    paid: 'Dibayar',
  },

  METHOD: { card: 'Kad', fpx: 'FPX', ewallet: 'E-Dompet', duitnow_qr: 'DuitNow QR' },

  badge(status) {
    return `<span class="badge ${BT.esc(status)}">${BT.esc(BT.STATUS[status] || status)}</span>`;
  },

  toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    BT.toast('Disalin ke clipboard');
  },

  // Blok kod dengan butang "Salin".
  codeBlock(code) {
    const id = `c${Math.random().toString(36).slice(2)}`;
    BT._codes = BT._codes || {};
    BT._codes[id] = code;
    return `<div class="code"><button class="copy" onclick="BT.copy(BT._codes['${id}'])">Salin</button><pre><code>${BT.esc(code)}</code></pre></div>`;
  },

  formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  },
};
window.BT = BT;
