(function () {
  const $ = (s, root = document) => root.querySelector(s);
  const view = $('#view');
  const esc = BT.esc;
  const state = { me: null, mode: localStorage.getItem('bt_mode') || 'test' };

  const api = (url, opts = {}) => BT.api(`/dashboard/api${url}`, { ...opts, mode: state.mode });

  function errorBox(msg) {
    return `<div class="alert error">${esc(msg)}</div>`;
  }

  function modal(html, onMount) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-bg"><div class="modal">${html}</div></div>`;
    const bg = root.firstElementChild;
    bg.addEventListener('click', (e) => {
      if (e.target === bg || e.target.closest('[data-close]')) root.innerHTML = '';
    });
    onMount?.(bg);
    return () => (root.innerHTML = '');
  }

  // Borang ringkas: hantar ke endpoint, papar ralat dalam .form-error.
  function bindForm(form, handler) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const errEl = $('.form-error', form);
      if (errEl) errEl.innerHTML = '';
      const btn = $('button[type=submit], button:not([type])', form);
      if (btn) btn.disabled = true;
      try {
        await handler(BT.formData(form));
      } catch (x) {
        if (errEl) errEl.innerHTML = errorBox(x.message);
        else BT.toast(x.message);
      }
      if (btn) btn.disabled = false;
    };
  }

  // ---------------------------------------------------------------- Ringkasan
  async function viewRingkasan() {
    const s = await api('/stats?days=30');
    const max = Math.max(1, ...s.daily.map((d) => Number(d.gross)));
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() + 8 * 3600e3 - i * 86400e3).toISOString().slice(0, 10);
      days.push(s.daily.find((x) => x.day === d) || { day: d, gross: '0', count: 0 });
    }
    view.innerHTML = `
      <h1>Ringkasan <span class="muted small">(30 hari)</span></h1>
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="card stat"><div class="label">Jualan kasar</div><div class="value">${BT.money(s.gross)}</div></div>
        <div class="card stat"><div class="label">Transaksi berjaya</div><div class="value">${s.count_paid}</div></div>
        <div class="card stat"><div class="label">Kadar kejayaan</div><div class="value">${s.success_rate === null ? '—' : `${s.success_rate}%`}</div></div>
        <div class="card stat"><div class="label">Baki tersedia</div><div class="value">${BT.money(s.balance.available)}</div><div class="small muted">Tertunda ${BT.money(s.balance.pending)}</div></div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <h3>Jualan harian</h3>
          <div class="chart">${days.map((d) => `<div class="bar" style="height:${(Number(d.gross) / max) * 100}%" title="${d.day}: ${BT.money(d.gross)} (${d.count})"></div>`).join('')}</div>
          <div class="row small muted" style="margin-top:6px"><span>${days[0].day}</span><span class="spacer"></span><span>${days[29].day}</span></div>
        </div>
        <div class="card">
          <h3>Mengikut kaedah</h3>
          ${s.by_method.length ? `<table>${s.by_method.map((m) => `<tr><td>${esc(BT.METHOD[m.method] || m.method)}</td><td class="num">${m.count}</td><td class="num">${BT.money(m.gross)}</td></tr>`).join('')}</table>` : '<p class="muted">Belum ada transaksi.</p>'}
          <p class="small muted" style="margin-top:12px">Caj gateway: ${BT.money(s.fees)} · Refund: ${BT.money(s.refunded)}</p>
        </div>
      </div>
      ${s.count_all === 0 ? `<div class="card" style="margin-top:16px"><h3>Mula di sini 👋</h3><p>Pergi ke <a href="#integrasi">Integrasi</a>, salin snippet butang bayar dan tampal di laman web anda. Dalam mod ujian, gunakan kad <code>4242 4242 4242 4242</code>.</p></div>` : ''}`;
  }

  // ---------------------------------------------------------------- Transaksi
  const txFilters = { status: '', method: '', search: '' };

  async function viewTransaksi() {
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h1 style="margin:0">Transaksi</h1><span class="spacer"></span>
        <button class="btn secondary sm" id="csv">⬇ Eksport CSV</button>
        <button class="btn sm" id="newPay">+ Cipta bayaran</button></div>
      <div class="filters">
        <input id="fSearch" placeholder="Cari ID, rujukan, emel…" value="${esc(txFilters.search)}">
        <select id="fStatus"><option value="">Semua status</option>${Object.entries(BT.STATUS).filter(([k]) => k !== 'paid').map(([k, v]) => `<option value="${k}" ${txFilters.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <select id="fMethod"><option value="">Semua kaedah</option>${Object.entries(BT.METHOD).map(([k, v]) => `<option value="${k}" ${txFilters.method === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div class="card" style="padding:0"><div class="table-wrap" id="txTable"><p style="padding:20px" class="muted">Memuatkan…</p></div></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn secondary sm hidden" id="more">Muat lagi</button></div>`;

    let last = null;
    let rows = [];
    const load = async (append) => {
      const q = new URLSearchParams({ ...txFilters, limit: 50 });
      if (append && last) q.set('starting_after', last);
      const out = await api(`/payments?${q}`);
      rows = append ? rows.concat(out.data) : out.data;
      last = rows.length ? rows[rows.length - 1].id : null;
      $('#more').classList.toggle('hidden', !out.has_more);
      $('#txTable').innerHTML = rows.length
        ? `<table><thead><tr><th>Amaun</th><th>Status</th><th>Keterangan</th><th>Pelanggan</th><th>Kaedah</th><th>Tarikh</th></tr></thead><tbody>
          ${rows.map((p) => `<tr class="clickable" data-id="${esc(p.id)}">
            <td><strong>${BT.money(p.amount)}</strong></td><td>${BT.badge(p.status)}</td>
            <td>${esc(p.description || '—')}<div class="small muted mono">${esc(p.reference || p.id)}</div></td>
            <td>${esc(p.customer.email || '—')}</td>
            <td>${p.payment_method ? esc(p.payment_method.detail) : '—'}</td>
            <td class="small">${BT.date(p.created)}</td></tr>`).join('')}</tbody></table>`
        : '<p style="padding:20px" class="muted">Tiada transaksi.</p>';
      view.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => (location.hash = `transaksi/${tr.dataset.id}`)));
    };

    let t;
    $('#fSearch').oninput = (e) => {
      clearTimeout(t);
      t = setTimeout(() => ((txFilters.search = e.target.value), load()), 300);
    };
    $('#fStatus').onchange = (e) => ((txFilters.status = e.target.value), load());
    $('#fMethod').onchange = (e) => ((txFilters.method = e.target.value), load());
    $('#more').onclick = () => load(true);
    $('#csv').onclick = () => {
      const q = new URLSearchParams({ ...txFilters, mode: state.mode });
      location.href = `/dashboard/api/payments.csv?${q}`;
    };
    $('#newPay').onclick = newPaymentModal;
    await load();
  }

  function newPaymentModal() {
    modal(
      `<h2>Cipta bayaran / invois</h2>
      <p class="muted small">Pautan checkout akan dijana — hantar kepada pelanggan melalui WhatsApp atau emel.</p>
      <form id="npForm">
        <div class="form-error"></div>
        <div class="field"><label>Amaun (RM)</label><input name="amount" required inputmode="decimal" placeholder="50.00"></div>
        <div class="field"><label>Keterangan</label><input name="description" placeholder="Invois #123"></div>
        <div class="field"><label>Rujukan (pilihan)</label><input name="reference"></div>
        <div class="field"><label>Emel pelanggan (pilihan)</label><input name="email" type="email"></div>
        <div class="row"><span class="spacer"></span><button type="button" class="btn secondary" data-close>Batal</button><button class="btn" type="submit">Cipta</button></div>
      </form>`,
      (root) =>
        bindForm($('#npForm', root), async (f) => {
          const p = await api('/payments', { method: 'POST', body: { amount: f.amount, description: f.description, reference: f.reference, customer: { email: f.email } } });
          $('.modal', root).innerHTML = `<h2>Bayaran dicipta ✓</h2><p>Hantar pautan ini kepada pelanggan:</p>${BT.codeBlock(p.checkout_url)}
            <div class="row"><a class="btn secondary" href="${esc(p.checkout_url)}" target="_blank">Buka</a><span class="spacer"></span><button class="btn" data-close>Siap</button></div>`;
          if (location.hash.startsWith('#transaksi')) route();
        })
    );
  }

  async function viewPaymentDetail(id) {
    const { payment: p, refunds, events } = await api(`/payments/${encodeURIComponent(id)}`);
    const refundable = Number(p.amount) - Number(p.amount_refunded);
    view.innerHTML = `
      <p><a href="#transaksi">← Transaksi</a></p>
      <div class="row" style="margin-bottom:16px"><h1 style="margin:0">${BT.money(p.amount)}</h1>${BT.badge(p.status)}<span class="spacer"></span>
        ${['succeeded', 'partially_refunded'].includes(p.status) ? '<button class="btn secondary sm" id="refundBtn">↩ Refund</button>' : ''}
        ${['pending', 'failed'].includes(p.status) ? '<button class="btn secondary sm" id="cancelBtn">Batalkan</button>' : ''}
        ${['succeeded', 'partially_refunded', 'refunded'].includes(p.status) ? `<a class="btn secondary sm" href="/receipt/${esc(p.id)}" target="_blank">Resit</a>` : ''}
      </div>
      <div class="grid grid-2">
        <div class="card"><h3>Butiran</h3><dl class="kv">
          <dt>ID</dt><dd class="mono">${esc(p.id)}</dd>
          <dt>Keterangan</dt><dd>${esc(p.description || '—')}</dd>
          <dt>Rujukan</dt><dd>${esc(p.reference || '—')}</dd>
          <dt>Kaedah</dt><dd>${p.payment_method ? `${esc(BT.METHOD[p.payment_method.type])} — ${esc(p.payment_method.detail)}` : '—'}</dd>
          <dt>Caj</dt><dd>${BT.money(p.fee)}</dd>
          <dt>Bersih</dt><dd>${BT.money(p.net)}</dd>
          <dt>Direfund</dt><dd>${BT.money(p.amount_refunded)}</dd>
          <dt>Sumber</dt><dd>${esc(p.source)}${p.payment_link ? ` (${esc(p.payment_link)})` : ''}</dd>
          <dt>Dicipta</dt><dd>${BT.date(p.created)}</dd>
          <dt>Dibayar</dt><dd>${BT.date(p.paid_at)}</dd>
          ${p.failure_reason ? `<dt>Sebab gagal</dt><dd>${esc(p.failure_reason)}</dd>` : ''}
          <dt>Pautan checkout</dt><dd><a href="${esc(p.checkout_url)}" target="_blank">${esc(p.checkout_url)}</a></dd>
        </dl></div>
        <div class="card"><h3>Pelanggan</h3><dl class="kv">
          <dt>Nama</dt><dd>${esc(p.customer.name || '—')}</dd>
          <dt>Emel</dt><dd>${esc(p.customer.email || '—')}</dd>
          <dt>Telefon</dt><dd>${esc(p.customer.phone || '—')}</dd>
        </dl>
        <h3 style="margin-top:18px">Metadata</h3>${Object.keys(p.metadata).length ? BT.codeBlock(JSON.stringify(p.metadata, null, 2)) : '<p class="muted">—</p>'}</div>
      </div>
      <div class="card"><h3>Refund</h3>${refunds.length ? `<table>${refunds.map((r) => `<tr><td class="mono small">${esc(r.id)}</td><td>${BT.money(r.amount)}</td><td>${esc(r.reason || '')}</td><td class="small">${BT.date(r.created)}</td></tr>`).join('')}</table>` : '<p class="muted">Tiada refund.</p>'}</div>
      <div class="card"><h3>Garis masa event</h3>${events.length ? `<table>${events.map((e) => `<tr><td><code>${esc(e.type)}</code></td><td class="mono small">${esc(e.id)}</td><td class="small">${BT.date(e.created)}</td></tr>`).join('')}</table>` : '<p class="muted">—</p>'}</div>`;

    $('#refundBtn') &&
      ($('#refundBtn').onclick = () =>
        modal(
          `<h2>Refund bayaran</h2><form id="rfForm"><div class="form-error"></div>
          <div class="field"><label>Amaun (RM)</label><input name="amount" value="${refundable.toFixed(2)}" inputmode="decimal"><div class="hint">Maksimum ${BT.money(refundable)}. Caj gateway tidak dipulangkan.</div></div>
          <div class="field"><label>Sebab</label><input name="reason" placeholder="Pelanggan minta batal"></div>
          <div class="row"><span class="spacer"></span><button type="button" class="btn secondary" data-close>Batal</button><button class="btn danger" type="submit">Refund</button></div></form>`,
          (root) =>
            bindForm($('#rfForm', root), async (f) => {
              await api(`/payments/${encodeURIComponent(id)}/refund`, { method: 'POST', body: f });
              $('#modalRoot').innerHTML = '';
              BT.toast('Refund berjaya');
              route();
            })
        ));
    $('#cancelBtn') &&
      ($('#cancelBtn').onclick = async () => {
        if (!confirm('Batalkan bayaran ini? Pelanggan tidak lagi boleh membayar.')) return;
        try {
          await api(`/payments/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
          route();
        } catch (x) {
          BT.toast(x.message);
        }
      });
  }

  // ---------------------------------------------------------------- Pautan
  async function viewPautan() {
    const { data } = await api('/links');
    view.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h1 style="margin:0">Pautan Bayaran</h1><span class="spacer"></span><button class="btn sm" id="newLink">+ Pautan baharu</button></div>
      <p class="muted">Kongsi pautan di WhatsApp, Instagram bio atau emel. Tiada laman web diperlukan. Boleh juga dibenam sebagai butang (lihat Integrasi).</p>
      <div class="card" style="padding:0"><div class="table-wrap">${
        data.length
          ? `<table><thead><tr><th>Tajuk</th><th>Amaun</th><th>Jualan</th><th>Pautan</th><th>Status</th><th></th></tr></thead><tbody>${data
              .map(
                (l) => `<tr><td><strong>${esc(l.title)}</strong><div class="small muted mono">${esc(l.id)}</div></td>
                <td>${l.customer_chooses_amount ? '<span class="muted">Pelanggan tentukan</span>' : BT.money(l.amount)}</td>
                <td>${l.paid_count} · ${BT.money(l.paid_total)}</td>
                <td><button class="btn ghost sm" data-copy="${esc(l.url)}">Salin pautan</button></td>
                <td>${l.active ? '<span class="badge ok">Aktif</span>' : '<span class="badge">Tidak aktif</span>'}</td>
                <td><button class="btn secondary sm" data-toggle="${esc(l.id)}" data-active="${l.active ? 0 : 1}">${l.active ? 'Nyahaktif' : 'Aktifkan'}</button></td></tr>`
              )
              .join('')}</tbody></table>`
          : '<p style="padding:20px" class="muted">Belum ada pautan bayaran.</p>'
      }</div></div>`;
    view.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => BT.copy(b.dataset.copy)));
    view.querySelectorAll('[data-toggle]').forEach(
      (b) =>
        (b.onclick = async () => {
          await api(`/links/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active === '1' } });
          route();
        })
    );
    $('#newLink').onclick = () =>
      modal(
        `<h2>Pautan bayaran baharu</h2><form id="lkForm"><div class="form-error"></div>
        <div class="field"><label>Tajuk</label><input name="title" required placeholder="Yuran kelas mengaji"></div>
        <div class="field"><label>Keterangan</label><textarea name="description" rows="3"></textarea></div>
        <div class="field"><label>Amaun (RM)</label><input name="amount" inputmode="decimal" placeholder="Kosongkan jika pelanggan tentukan sendiri"></div>
        <div class="field"><label>Redirect selepas bayar (pilihan)</label><input name="redirect_url" placeholder="https://..."></div>
        <div class="row"><span class="spacer"></span><button type="button" class="btn secondary" data-close>Batal</button><button class="btn" type="submit">Cipta</button></div></form>`,
        (root) =>
          bindForm($('#lkForm', root), async (f) => {
            await api('/links', { method: 'POST', body: f });
            $('#modalRoot').innerHTML = '';
            route();
          })
      );
  }

  // ---------------------------------------------------------------- Pelanggan
  async function viewPelanggan() {
    const { data } = await api('/customers');
    view.innerHTML = `<h1>Pelanggan</h1><p class="muted">Pelanggan direkod secara automatik apabila bayaran berjaya.</p>
      <div class="card" style="padding:0"><div class="table-wrap">${
        data.length
          ? `<table><thead><tr><th>Emel</th><th>Nama</th><th>Telefon</th><th class="num">Bayaran</th><th class="num">Jumlah</th><th>Sejak</th></tr></thead><tbody>${data
              .map(
                (c) => `<tr class="clickable" data-email="${esc(c.email)}"><td>${esc(c.email)}</td><td>${esc(c.name || '—')}</td><td>${esc(c.phone || '—')}</td>
                <td class="num">${c.payments_count}</td><td class="num">${BT.money(c.total_spent)}</td><td class="small">${BT.date(c.created)}</td></tr>`
              )
              .join('')}</tbody></table>`
          : '<p style="padding:20px" class="muted">Belum ada pelanggan.</p>'
      }</div></div>`;
    view.querySelectorAll('tr[data-email]').forEach(
      (tr) =>
        (tr.onclick = () => {
          txFilters.search = tr.dataset.email;
          location.hash = 'transaksi';
        })
    );
  }

  // ---------------------------------------------------------------- Baki
  async function viewBaki() {
    const { balance: b, payouts, min_payout } = await api('/balance');
    const m = state.me.merchant;
    view.innerHTML = `<h1>Baki &amp; Payout</h1>
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="card stat"><div class="label">Tersedia</div><div class="value">${BT.money(b.available)}</div></div>
        <div class="card stat"><div class="label">Tertunda</div><div class="value">${BT.money(b.pending)}</div><div class="small muted">Diselesaikan T+${b.settlement_days}</div></div>
        <div class="card stat"><div class="label">Jumlah</div><div class="value">${BT.money(b.total)}</div></div>
      </div>
      <div class="card"><h3>Keluarkan dana</h3>
        ${m.bank_account_no
          ? `<p>Ke <strong>${esc(m.bank_name)}</strong> ${esc(m.bank_account_no)} (${esc(m.bank_account_name)})</p>
             <form id="poForm" class="row"><div class="form-error" style="width:100%"></div><input name="amount" inputmode="decimal" placeholder="${Number(b.available).toFixed(2)}" style="max-width:180px"><button class="btn" type="submit">Keluarkan</button><span class="small muted">Minimum ${BT.money(min_payout)}. Kosongkan untuk keluarkan semua.</span></form>`
          : '<p>Sila tambah akaun bank anda di <a href="#tetapan">Tetapan</a> dahulu.</p>'}
      </div>
      <div class="card" style="padding:0"><div class="table-wrap">${
        payouts.length
          ? `<table><thead><tr><th>ID</th><th>Amaun</th><th>Status</th><th>Bank</th><th>Tarikh</th></tr></thead><tbody>${payouts
              .map((p) => `<tr><td class="mono small">${esc(p.id)}</td><td>${BT.money(p.amount)}</td><td>${BT.badge(p.status)}</td><td>${esc(p.bank.name)} ${esc(p.bank.account_no)}</td><td class="small">${BT.date(p.created)}</td></tr>`)
              .join('')}</tbody></table>`
          : '<p style="padding:20px" class="muted">Belum ada payout.</p>'
      }</div></div>`;
    const f = $('#poForm');
    if (f)
      bindForm(f, async (d) => {
        await api('/payouts', { method: 'POST', body: d.amount ? d : {} });
        BT.toast('Payout dicipta');
        route();
      });
  }

  // ---------------------------------------------------------------- Integrasi
  async function viewIntegrasi() {
    const [keys, links, wh] = await Promise.all([api('/keys'), api('/links'), api('/webhook')]);
    const base = state.me.base_url;
    const pk = keys.public_key;
    const activeLinks = links.data.filter((l) => l.active);
    const m = state.me.merchant;
    const tabs = [
      ['butang', 'Butang bayar'],
      ['pautan', 'Pautan bayaran'],
      ['borang', 'Borang amaun bebas'],
      ['js', 'JavaScript API'],
      ['api', 'API pelayan'],
      ['webhook', 'Sahkan webhook'],
    ];
    view.innerHTML = `<h1>Integrasi — Copy Config</h1>
      <p class="muted">Salin kod di bawah dan tampal ke dalam HTML laman anda. Kunci <strong>${state.mode === 'test' ? 'ujian' : 'live'}</strong> anda sudah dimasukkan.</p>
      ${m.allowed_domains ? `<div class="alert info">Butang hanya berfungsi pada domain: <strong>${esc(m.allowed_domains)}</strong> (ubah di Tetapan).</div>` : `<div class="alert warn">Tip keselamatan: tetapkan <a href="#tetapan">domain dibenarkan</a> supaya kunci awam anda tidak boleh digunakan di laman lain.</div>`}
      <div class="tabs" id="itabs">${tabs.map(([k, v]) => `<button data-t="${k}">${v}</button>`).join('')}</div>
      <div id="ibody"></div>`;

    const bodies = {
      butang() {
        $('#ibody').innerHTML = `<div class="grid grid-2">
          <div class="card"><h3>Sesuaikan butang</h3>
            <form id="gen">
              <div class="field"><label>Amaun (RM)</label><input name="amount" value="25.00"></div>
              <div class="field"><label>Keterangan produk</label><input name="description" value="Produk saya"></div>
              <div class="field"><label>Teks butang</label><input name="label" placeholder="Bayar RM25.00"></div>
              <div class="field"><label>Redirect selepas bayar (pilihan)</label><input name="returnUrl" placeholder="https://laman-anda.com/terima-kasih"></div>
              <label class="check"><input type="checkbox" name="redirect"> Buka halaman penuh (bukan popup)</label>
            </form>
            <h3 style="margin-top:18px">Pratonton</h3>
            <div class="preview" id="preview"></div>
            <p class="hint">Pratonton menggunakan kunci sebenar anda — dalam mod ujian, guna kad 4242 4242 4242 4242.</p>
          </div>
          <div><h3>Kod untuk disalin</h3><div id="genOut"></div>
            <div class="card small"><strong>Cara guna:</strong><ol style="margin:6px 0 0;padding-left:18px">
            <li>Tampal tag <code>&lt;script&gt;</code> sekali sahaja (cth. sebelum <code>&lt;/body&gt;</code>).</li>
            <li>Tampal <code>&lt;button&gt;</code> di mana-mana — boleh banyak butang dengan amaun berbeza.</li>
            <li>Untuk WordPress: guna blok "Custom HTML". Untuk Wix/Blogger: "Embed HTML".</li>
            <li>Sahkan bayaran di pelayan anda dengan <a href="#webhook">webhook</a> sebelum hantar barang.</li></ol></div></div>
        </div>`;
        const form = $('#gen');
        const update = () => {
          const f = BT.formData(form);
          const code = Snippets.button({ base, pk, ...f, redirect: form.redirect.checked });
          $('#genOut').innerHTML = BT.codeBlock(code);
          const label = f.label || `Bayar RM${f.amount}`;
          $('#preview').innerHTML = '';
          const b = document.createElement('button');
          b.className = 'btn';
          b.textContent = label;
          b.setAttribute('data-bayarterus', '');
          b.dataset.amount = f.amount;
          b.dataset.description = f.description;
          b.dataset.redirect = 'false';
          $('#preview').appendChild(b);
        };
        form.oninput = update;
        update();
        loadSdk(pk);
      },
      pautan() {
        $('#ibody').innerHTML = activeLinks.length
          ? `<div class="field" style="max-width:420px"><label>Pilih pautan bayaran</label><select id="lsel">${activeLinks.map((l) => `<option value="${esc(l.id)}">${esc(l.title)} — ${l.customer_chooses_amount ? 'amaun bebas' : BT.money(l.amount)}</option>`).join('')}</select></div><div id="lout"></div>`
          : '<div class="card"><p>Belum ada pautan bayaran aktif. <a href="#pautan">Cipta satu</a> dahulu.</p><p class="muted small">Kelebihan pautan bayaran: amaun ditetapkan di pelayan, jadi pelanggan tidak boleh mengubahnya.</p></div>';
        const sel = $('#lsel');
        if (!sel) return;
        const upd = () => {
          const l = activeLinks.find((x) => x.id === sel.value);
          $('#lout').innerHTML = `<h3>Pautan terus (WhatsApp / media sosial)</h3>${BT.codeBlock(l.url)}
            <h3>Butang dalam laman web</h3>${BT.codeBlock(Snippets.link({ base, pk, linkId: l.id, label: `Bayar ${l.customer_chooses_amount ? '' : BT.money(l.amount)}`.trim() }))}
            <h3>Pautan HTML biasa</h3>${BT.codeBlock(`<a href="${l.url}">Bayar sekarang</a>`)}`;
        };
        sel.onchange = upd;
        upd();
      },
      borang() {
        $('#ibody').innerHTML = `<p>Sesuai untuk sumbangan, yuran atau bayaran amaun bebas. Medan <code>amount</code>, <code>email</code>, <code>name</code>, <code>phone</code> dibaca secara automatik.</p>
          ${m.allow_client_amount ? '' : '<div class="alert warn">Amaun dari pelayar sedang dimatikan dalam Tetapan — borang ini tidak akan berfungsi sehingga diaktifkan.</div>'}
          ${BT.codeBlock(Snippets.form({ base, pk }))}`;
      },
      js() {
        $('#ibody').innerHTML = `<p>Untuk laman SPA (React, Vue) atau troli beli-belah — panggil <code>BayarTerus.pay()</code> dari kod anda.</p>${BT.codeBlock(Snippets.jsApi({ base, pk }))}
          <h3>Konfigurasi global (pilihan)</h3>${BT.codeBlock(`<script>
  // Letakkan SEBELUM tag skrip bayarterus.js
  window.BayarTerusConfig = {
    key: '${pk}',
    returnUrl: 'https://laman-anda.com/terima-kasih', // pilihan
    redirect: false,                                   // true = halaman penuh
    onSuccess: (r) => console.log('Dibayar', r.payment_id),
    onClose: (r) => console.log('Ditutup', r.status),
  };
</script>
<script src="${base}/js/bayarterus.js"></script>`)}`;
      },
      api() {
        $('#ibody').innerHTML = `<div class="alert info">Kunci rahsia anda: <code>${esc(keys.secret_key_hint)}</code> — ia hanya dipaparkan sekali. Jana semula di <a href="#kunci">Kunci API</a> jika hilang. <strong>Jangan sekali-kali letak kunci rahsia dalam HTML/JS.</strong></div>
          <p>Cara paling selamat: pelayan anda cipta bayaran (amaun tidak boleh diubah pelanggan), kemudian redirect pelanggan ke <code>checkout_url</code>.</p>
          <h3>cURL</h3>${BT.codeBlock(Snippets.curl({ base, sk: keys.secret_key_hint }))}
          <h3>Node.js</h3>${BT.codeBlock(Snippets.node({ base, sk: keys.secret_key_hint }))}
          <h3>PHP</h3>${BT.codeBlock(Snippets.php({ base, sk: keys.secret_key_hint }))}`;
      },
      webhook() {
        $('#ibody').innerHTML = `<p>Rahsia webhook anda (${state.mode}): ${BT.codeBlock(wh.secret)}</p>
          <h3>Node.js / Express</h3>${BT.codeBlock(Snippets.webhookNode({ secret: wh.secret }))}
          <h3>PHP</h3>${BT.codeBlock(Snippets.webhookPhp({ secret: wh.secret }))}
          <h3>Sahkan parameter return_url (PHP)</h3>${BT.codeBlock(Snippets.returnVerify({ secret: wh.secret }))}`;
      },
    };
    const show = (k) => {
      view.querySelectorAll('#itabs button').forEach((b) => b.classList.toggle('active', b.dataset.t === k));
      bodies[k]();
    };
    view.querySelectorAll('#itabs button').forEach((b) => (b.onclick = () => show(b.dataset.t)));
    show('butang');
  }

  function loadSdk(pk) {
    if (window.BayarTerus) {
      window.BayarTerus.configure({ key: pk });
      return;
    }
    const s = document.createElement('script');
    s.src = '/js/bayarterus.js';
    s.dataset.key = pk;
    document.body.appendChild(s);
  }

  // ---------------------------------------------------------------- Webhook
  async function viewWebhook() {
    const wh = await api('/webhook');
    view.innerHTML = `<h1>Webhook</h1>
      <p class="muted">BayarTerus akan menghantar POST ke URL ini setiap kali status bayaran berubah. Cubaan semula automatik sehingga 6 kali (30s, 2m, 10m, 1j, 6j).</p>
      <div class="card"><form id="whForm"><div class="form-error"></div>
        <div class="field"><label>URL endpoint (${state.mode})</label><input name="url" value="${esc(wh.url || '')}" placeholder="https://laman-anda.com/webhook/bayarterus"></div>
        <div class="row"><button class="btn" type="submit">Simpan</button><button type="button" class="btn secondary" id="whTest">Hantar event ujian</button></div></form>
        <h3 style="margin-top:20px">Rahsia tandatangan</h3>${BT.codeBlock(wh.secret)}
        <button class="btn secondary sm" id="whRoll">Jana semula rahsia</button>
        <p class="hint">Event: <code>payment.created</code>, <code>payment.succeeded</code>, <code>payment.failed</code>, <code>payment.cancelled</code>, <code>payment.expired</code>, <code>refund.succeeded</code>, <code>payout.created</code>, <code>ping</code>. Contoh kod pengesahan di <a href="#integrasi">Integrasi → Sahkan webhook</a>.</p>
      </div>
      <div class="card" style="padding:0"><h3 style="padding:16px 20px 0">Penghantaran terkini</h3><div class="table-wrap">${
        wh.deliveries.length
          ? `<table><thead><tr><th>Event</th><th>Status</th><th>HTTP</th><th>Cubaan</th><th>Dikemas kini</th><th></th></tr></thead><tbody>${wh.deliveries
              .map(
                (d) => `<tr><td><code>${esc(d.type)}</code><div class="small muted mono">${esc(d.event_id)}</div></td>
                <td>${BT.badge(d.status)}</td><td>${d.last_status_code ?? `<span class="small muted" title="${esc(d.last_error || '')}">ralat</span>`}</td>
                <td>${d.attempts}</td><td class="small">${BT.date(d.updated_at)}</td>
                <td><button class="btn ghost sm" data-resend="${esc(d.id)}">Hantar semula</button></td></tr>`
              )
              .join('')}</tbody></table>`
          : '<p style="padding:0 20px 20px" class="muted">Tiada penghantaran lagi.</p>'
      }</div></div>`;
    bindForm($('#whForm'), async (f) => {
      await api('/webhook', { method: 'PUT', body: f });
      BT.toast('URL webhook disimpan');
    });
    $('#whTest').onclick = async () => {
      try {
        await api('/webhook/test', { method: 'POST' });
        BT.toast('Event ujian dihantar');
        setTimeout(route, 1500);
      } catch (x) {
        BT.toast(x.message);
      }
    };
    $('#whRoll').onclick = async () => {
      if (!confirm('Rahsia lama akan berhenti berfungsi serta-merta. Teruskan?')) return;
      await api('/webhook/roll-secret', { method: 'POST' });
      route();
    };
    view.querySelectorAll('[data-resend]').forEach(
      (b) =>
        (b.onclick = async () => {
          await api(`/webhook/deliveries/${b.dataset.resend}/resend`, { method: 'POST' });
          BT.toast('Dijadualkan semula');
          setTimeout(route, 1500);
        })
    );
  }

  // ---------------------------------------------------------------- Kunci
  async function viewKunci() {
    const k = await api('/keys');
    view.innerHTML = `<h1>Kunci API (${state.mode === 'test' ? 'ujian' : 'live'})</h1>
      <div class="card"><h3>Kunci awam</h3><p class="muted small">Selamat diletakkan dalam HTML (data-key). Digunakan oleh butang bayar.</p>${BT.codeBlock(k.public_key)}</div>
      <div class="card"><h3>Kunci rahsia</h3><p class="muted small">Untuk pelayan anda sahaja. Jangan kongsi atau letak dalam kod frontend.</p>
        <p class="mono">${esc(k.secret_key_hint)}</p><div id="newKey"></div>
        <button class="btn danger sm" id="roll">Jana semula kedua-dua kunci</button>
        <p class="hint">Kunci lama akan dibatalkan serta-merta — kemas kini snippet dan pelayan anda selepas ini.</p></div>`;
    $('#roll').onclick = async () => {
      if (!confirm('Jana semula kunci? Integrasi sedia ada akan berhenti berfungsi sehingga dikemas kini.')) return;
      const out = await api('/keys/roll', { method: 'POST' });
      $('#newKey').innerHTML = `<div class="alert warn">Salin kunci rahsia baharu sekarang — ia tidak akan dipaparkan lagi.</div>${BT.codeBlock(out.secret_key)}<p class="small">Kunci awam baharu: <code>${esc(out.public_key)}</code></p>`;
    };
  }

  // ---------------------------------------------------------------- Tetapan
  async function viewTetapan() {
    const m = state.me.merchant;
    view.innerHTML = `<h1>Tetapan</h1>
      <form id="setForm"><div class="form-error"></div>
      <div class="card"><h3>Perniagaan &amp; jenama</h3>
        <div class="grid grid-2">
          <div class="field"><label>Nama perniagaan</label><input name="business_name" value="${esc(m.business_name)}" required></div>
          <div class="field"><label>Laman web</label><input name="website" value="${esc(m.website || '')}" placeholder="https://"></div>
          <div class="field"><label>Emel sokongan (dipapar pada resit)</label><input name="support_email" value="${esc(m.support_email || '')}"></div>
          <div class="field"><label>Warna jenama (checkout)</label><input name="brand_color" type="color" value="${esc(m.brand_color)}" style="height:40px"></div>
        </div></div>
      <div class="card"><h3>Keselamatan embed</h3>
        <div class="field"><label>Domain dibenarkan</label><input name="allowed_domains" value="${esc(m.allowed_domains)}" placeholder="kedaisaya.com, www.kedaisaya.com">
          <div class="hint">Pisahkan dengan koma. Subdomain dibenarkan secara automatik. Kosongkan = semua domain.</div></div>
        <label class="check"><input type="checkbox" name="allow_client_amount" ${m.allow_client_amount ? 'checked' : ''}> Benarkan amaun ditetapkan dari pelayar (data-amount / borang)</label>
        <div class="hint">Matikan untuk keselamatan maksimum — hanya pautan bayaran dan API pelayan akan diterima. Jika dihidupkan, sentiasa semak amaun dalam webhook.</div>
      </div>
      <div class="card"><h3>Akaun bank untuk payout</h3>
        <div class="grid grid-2">
          <div class="field"><label>Bank</label><input name="bank_name" value="${esc(m.bank_name || '')}" placeholder="Maybank"></div>
          <div class="field"><label>No. akaun</label><input name="bank_account_no" value="${esc(m.bank_account_no || '')}" inputmode="numeric"></div>
          <div class="field"><label>Nama pemegang akaun</label><input name="bank_account_name" value="${esc(m.bank_account_name || '')}"></div>
        </div></div>
      <div class="row" style="margin-top:16px"><button class="btn" type="submit">Simpan tetapan</button></div>
      </form>
      <div class="card" style="margin-top:24px"><h3>Tukar kata laluan</h3>
        <form id="pwForm" style="max-width:360px"><div class="form-error"></div>
          <div class="field"><label>Kata laluan semasa</label><input name="current_password" type="password" required autocomplete="current-password"></div>
          <div class="field"><label>Kata laluan baharu</label><input name="new_password" type="password" minlength="8" required autocomplete="new-password"></div>
          <button class="btn secondary" type="submit">Tukar</button></form></div>`;
    const form = $('#setForm');
    bindForm(form, async (f) => {
      f.allow_client_amount = form.allow_client_amount.checked;
      const out = await api('/settings', { method: 'PUT', body: f });
      state.me.merchant = out.merchant;
      $('#bizName').textContent = out.merchant.business_name;
      BT.toast('Tetapan disimpan');
    });
    bindForm($('#pwForm'), async (f) => {
      await api('/password', { method: 'PUT', body: f });
      $('#pwForm').reset();
      BT.toast('Kata laluan ditukar');
    });
  }

  // ---------------------------------------------------------------- Router
  const routes = {
    ringkasan: viewRingkasan,
    transaksi: viewTransaksi,
    pautan: viewPautan,
    pelanggan: viewPelanggan,
    baki: viewBaki,
    integrasi: viewIntegrasi,
    webhook: viewWebhook,
    kunci: viewKunci,
    tetapan: viewTetapan,
  };

  async function route() {
    const [name, arg] = (location.hash.slice(1) || 'ringkasan').split('/');
    document.querySelectorAll('.side a.nav').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
    $('#side').classList.remove('open');
    try {
      if (name === 'transaksi' && arg) await viewPaymentDetail(decodeURIComponent(arg));
      else await (routes[name] || viewRingkasan)();
    } catch (x) {
      if (x.status === 401) return (location.href = '/login');
      view.innerHTML = errorBox(x.message);
    }
  }

  function setMode(mode) {
    state.mode = mode;
    localStorage.setItem('bt_mode', mode);
    document.querySelectorAll('#modeToggle button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#liveWarn').classList.toggle('hidden', !(mode === 'live' && state.me && !state.me.live_enabled));
  }

  async function init() {
    try {
      state.me = await api('/me');
    } catch (x) {
      location.href = '/login';
      return;
    }
    $('#bizName').textContent = state.me.merchant.business_name;
    document.querySelectorAll('#modeToggle button').forEach(
      (b) =>
        (b.onclick = () => {
          setMode(b.dataset.mode);
          route();
        })
    );
    setMode(state.mode);
    $('#logout').onclick = async () => {
      await api('/auth/logout', { method: 'POST' });
      location.href = '/login';
    };
    window.addEventListener('hashchange', route);
    document.addEventListener('bayarterus:success', () => BT.toast('Bayaran ujian berjaya!'));
    route();
  }

  init();
})();
