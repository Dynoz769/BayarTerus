(function () {
  const id = location.pathname.split('/').pop();
  const embed = new URLSearchParams(location.search).get('embed') === '1';
  const $ = (s) => document.querySelector(s);
  let payment = null;
  let method = 'fpx';

  if (embed) document.body.classList.add('embed');

  function notifyParent(msg) {
    if (embed && window.parent !== window) {
      window.parent.postMessage({ source: 'bayarterus', ...msg }, '*');
    }
  }

  function showError(msg) {
    const el = $('#error');
    el.textContent = msg;
    el.classList.toggle('hidden', !msg);
  }

  function selectMethod(m) {
    method = m;
    document.querySelectorAll('#methods button').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== m));
  }

  async function goBack(cancel) {
    const { url } = await BT.api(`/checkout/api/payments/${id}/return${cancel ? '?cancel=1' : ''}`);
    if (!url) {
      notifyParent({ type: 'close', status: payment.status, payment_id: id });
      return;
    }
    if (embed) notifyParent({ type: 'redirect', url });
    else location.href = url;
  }

  function renderResult() {
    const view = $('#resultView');
    const ok = ['succeeded', 'refunded', 'partially_refunded'].includes(payment.status);
    const failed = payment.status === 'failed';
    let html;
    if (ok) {
      html = `<div class="icon ok">✓</div><h2>Pembayaran berjaya</h2>
        <p class="muted">${BT.esc(BT.money(payment.amount))} kepada ${BT.esc(payment.merchant.name)}<br>
        <span class="small mono">${BT.esc(payment.id)}</span></p>
        <div class="grid" style="gap:8px">
          ${payment.has_return_url ? '<button class="btn block" id="backBtn">Kembali ke kedai</button>' : ''}
          <a class="btn secondary block" href="/receipt/${encodeURIComponent(payment.id)}" target="_blank" rel="noopener">Lihat resit</a>
          ${embed && !payment.has_return_url ? '<button class="btn secondary block" id="closeBtn">Tutup</button>' : ''}
        </div>`;
    } else {
      const label = { expired: 'Bayaran tamat tempoh', cancelled: 'Bayaran dibatalkan' }[payment.status] || 'Bayaran tidak tersedia';
      html = `<div class="icon bad">!</div><h2>${BT.esc(label)}</h2>
        <p class="muted">Sila hubungi ${BT.esc(payment.merchant.name)} untuk bantuan.</p>
        ${payment.has_cancel_url ? '<button class="btn secondary block" id="backBtn">Kembali ke kedai</button>' : ''}`;
    }
    view.innerHTML = html;
    view.classList.remove('hidden');
    $('#payForm').classList.add('hidden');
    const back = $('#backBtn');
    if (back) back.onclick = () => goBack(!ok);
    const close = $('#closeBtn');
    if (close) close.onclick = () => notifyParent({ type: 'close', status: payment.status, payment_id: id });
    if (ok) notifyParent({ type: 'success', status: payment.status, payment_id: id, amount: payment.amount, reference: payment.reference });
    if (failed) notifyParent({ type: 'failed', status: payment.status, payment_id: id });
  }

  function render() {
    const m = payment.merchant;
    document.documentElement.style.setProperty('--brand', m.brand_color);
    $('#merchant').textContent = m.name;
    $('#amount').textContent = BT.money(payment.amount);
    $('#desc').textContent = [payment.description, payment.reference ? `Rujukan: ${payment.reference}` : ''].filter(Boolean).join(' · ');
    $('#testbar').classList.toggle('hidden', payment.livemode);
    $('#testCards').classList.toggle('hidden', payment.livemode);
    document.title = `Bayar ${BT.money(payment.amount)} — ${m.name}`;

    if (payment.closed) return renderResult();

    $('#payForm').classList.remove('hidden');
    $('#payBtn').textContent = `Bayar ${BT.money(payment.amount)}`;
    if (payment.customer_email && !$('#email').value) $('#email').value = payment.customer_email;
    if (payment.customer_name && !$('#name').value) $('#name').value = payment.customer_name;
    $('#cancelBtn').classList.toggle('hidden', !payment.has_cancel_url);
    if (payment.status === 'failed' && payment.failure_reason) showError(`${payment.failure_reason} Sila cuba lagi.`);
    if (payment.status === 'failed') notifyParent({ type: 'failed', status: 'failed', payment_id: id });
  }

  async function load() {
    try {
      payment = await BT.api(`/checkout/api/payments/${id}`);
    } catch (e) {
      $('#merchant').textContent = 'BayarTerus';
      showError(e.message);
      return;
    }
    $('#banks').innerHTML = payment.fpx_banks
      .map((b, i) => `<label><input type="radio" name="bank" value="${BT.esc(b.code)}" ${i === 0 ? 'checked' : ''}>${BT.esc(b.name)}</label>`)
      .join('');
    $('#wallets').innerHTML = payment.ewallets
      .map((w, i) => `<label><input type="radio" name="wallet" value="${BT.esc(w.code)}" ${i === 0 ? 'checked' : ''}>${BT.esc(w.name)}</label>`)
      .join('');
    render();
  }

  document.querySelectorAll('#methods button').forEach((b) => (b.onclick = () => selectMethod(b.dataset.m)));
  selectMethod('fpx');

  $('#cancelBtn').onclick = () => goBack(true);

  $('#payForm').onsubmit = async (e) => {
    e.preventDefault();
    showError('');
    const btn = $('#payBtn');
    btn.disabled = true;
    btn.textContent = 'Memproses…';
    const f = BT.formData(e.target);
    const body = { method, email: f.email, name: f.name || undefined };
    if (method === 'card') Object.assign(body, { card_number: f.card_number, exp_month: f.exp_month, exp_year: f.exp_year, cvc: f.cvc });
    if (method === 'fpx') body.bank = f.bank;
    if (method === 'ewallet') body.wallet = f.wallet;
    try {
      const out = await BT.api(`/checkout/api/payments/${id}/pay`, { method: 'POST', body });
      if (out.next_action?.type === 'redirect') {
        const u = new URL(out.next_action.url, location.href);
        if (embed) u.searchParams.set('embed', '1');
        location.href = u.toString();
        return;
      }
      payment = out.payment;
      render();
    } catch (err) {
      showError(err.message);
    }
    btn.disabled = false;
    if (payment && !payment.closed) btn.textContent = `Bayar ${BT.money(payment.amount)}`;
  };

  load();
})();
