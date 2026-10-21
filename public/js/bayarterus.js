/*!
 * BayarTerus Embed SDK
 *
 * Cara guna (copy-paste ke laman anda):
 *
 *   <script src="https://GATEWAY/js/bayarterus.js" data-key="pk_test_xxx"></script>
 *   <button data-bayarterus data-amount="25.00" data-description="Kek Coklat">Bayar RM25</button>
 *
 * Atribut butang/borang: data-amount, data-description, data-reference, data-email,
 * data-name, data-phone, data-link (ID pautan bayaran), data-return-url,
 * data-redirect="true" (buka halaman penuh, bukan popup).
 *
 * <form data-bayarterus> juga disokong: medan bernama amount, email, name, phone,
 * description dan reference akan dibaca semasa submit.
 *
 * API JavaScript:
 *   BayarTerus.pay({ amount: '25.00', description: 'Kek' }).then(r => r.status)
 *   document.addEventListener('bayarterus:success', e => console.log(e.detail))
 */
(function () {
  'use strict';
  if (window.BayarTerus && window.BayarTerus.__loaded) return;

  var script =
    document.currentScript ||
    (function () {
      var s = document.querySelectorAll('script[src*="bayarterus.js"]');
      return s[s.length - 1];
    })();
  var origin = new URL(script.src, location.href).origin;
  var userCfg = window.BayarTerusConfig || {};
  var cfg = {
    key: userCfg.key || script.getAttribute('data-key'),
    redirect: userCfg.redirect || script.getAttribute('data-redirect') === 'true',
    returnUrl: userCfg.returnUrl || script.getAttribute('data-return-url') || null,
    onSuccess: userCfg.onSuccess,
    onFailed: userCfg.onFailed,
    onClose: userCfg.onClose,
  };

  var css =
    '.bt-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:12px;animation:bt-fade .15s ease}' +
    '.bt-frame-wrap{position:relative;width:100%;max-width:440px;height:min(720px,94vh);background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)}' +
    '.bt-frame-wrap iframe{border:0;width:100%;height:100%}' +
    '.bt-close{position:absolute;top:8px;right:10px;z-index:2;border:0;background:rgba(0,0,0,.06);width:30px;height:30px;border-radius:50%;font-size:18px;line-height:30px;cursor:pointer;color:#111}' +
    '.bt-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:14px system-ui,sans-serif;color:#6b7280}' +
    '[data-bayarterus].bt-busy{opacity:.6;pointer-events:none}' +
    '@keyframes bt-fade{from{opacity:0}to{opacity:1}}';
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var active = null; // { overlay, resolve, el, paymentId }

  function emit(el, name, detail) {
    var ev = new CustomEvent('bayarterus:' + name, { detail: detail, bubbles: true });
    (el || document).dispatchEvent(ev);
  }

  function createPayment(opts) {
    if (!cfg.key) return Promise.reject(new Error('BayarTerus: data-key (kunci awam) tidak ditetapkan.'));
    return fetch(origin + '/v1/embed/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: cfg.key,
        amount: opts.amount,
        link: opts.link,
        description: opts.description,
        reference: opts.reference,
        email: opts.email,
        name: opts.name,
        phone: opts.phone,
        return_url: opts.returnUrl || cfg.returnUrl || undefined,
        metadata: opts.metadata,
      }),
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data.error && data.error.message) || 'Gagal mencipta bayaran.');
        return data;
      });
    });
  }

  function close(result) {
    if (!active) return;
    var a = active;
    active = null;
    result = a.result || result;
    a.overlay.remove();
    document.documentElement.style.overflow = a.prevOverflow;
    if (result.status !== 'succeeded') {
      emit(a.el, 'close', result);
      if (cfg.onClose) cfg.onClose(result);
    }
    a.resolve(result);
  }

  function openModal(url, el, paymentId) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'bt-overlay';
      overlay.innerHTML =
        '<div class="bt-frame-wrap" role="dialog" aria-modal="true" aria-label="Pembayaran">' +
        '<button class="bt-close" aria-label="Tutup">&times;</button>' +
        '<div class="bt-loading">Memuatkan pembayaran…</div>' +
        '<iframe allow="payment" title="BayarTerus Checkout"></iframe></div>';
      var iframe = overlay.querySelector('iframe');
      iframe.src = url + (url.indexOf('?') > -1 ? '&' : '?') + 'embed=1';
      iframe.onload = function () {
        var l = overlay.querySelector('.bt-loading');
        if (l) l.remove();
      };
      overlay.querySelector('.bt-close').onclick = function () {
        close({ status: 'closed', payment_id: paymentId });
      };
      document.body.appendChild(overlay);
      active = { overlay: overlay, resolve: resolve, el: el, paymentId: paymentId, prevOverflow: document.documentElement.style.overflow };
      document.documentElement.style.overflow = 'hidden';
    });
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || e.data.source !== 'bayarterus' || !active) return;
    var d = e.data;
    var detail = { status: d.status, payment_id: d.payment_id, amount: d.amount, reference: d.reference };
    if (d.type === 'success') {
      emit(active.el, 'success', detail);
      if (cfg.onSuccess) cfg.onSuccess(detail);
    } else if (d.type === 'failed') {
      emit(active.el, 'failed', detail);
      if (cfg.onFailed) cfg.onFailed(detail);
    } else if (d.type === 'redirect' && d.url) {
      // Hanya benarkan URL http(s) yang ditandatangani oleh gateway.
      if (/^https?:\/\//.test(d.url)) window.location.href = d.url;
    } else if (d.type === 'close') {
      close(detail);
    }
    if (d.type === 'success') active.result = detail;
  });

  function pay(opts) {
    opts = opts || {};
    return createPayment(opts).then(function (p) {
      var redirect = opts.redirect !== undefined ? opts.redirect : cfg.redirect;
      if (redirect) {
        window.location.href = p.checkout_url;
        return { status: 'redirected', payment_id: p.id };
      }
      return openModal(p.checkout_url, opts.el, p.id);
    });
  }

  function readOpts(el) {
    var a = function (n) {
      var v = el.getAttribute('data-' + n);
      return v === null || v === '' ? undefined : v;
    };
    var opts = {
      el: el,
      amount: a('amount'),
      link: a('link'),
      description: a('description'),
      reference: a('reference'),
      email: a('email'),
      name: a('name'),
      phone: a('phone'),
      returnUrl: a('return-url'),
      redirect: a('redirect') === undefined ? undefined : a('redirect') === 'true',
    };
    if (el.tagName === 'FORM') {
      var fd = new FormData(el);
      ['amount', 'email', 'name', 'phone', 'description', 'reference'].forEach(function (k) {
        var v = fd.get(k);
        if (v !== null && v !== '') opts[k] = String(v);
      });
    }
    return opts;
  }

  function handle(el, ev) {
    ev.preventDefault();
    if (el.classList.contains('bt-busy')) return;
    el.classList.add('bt-busy');
    pay(readOpts(el))
      .catch(function (err) {
        emit(el, 'error', { message: err.message });
        alert(err.message);
      })
      .then(function () {
        el.classList.remove('bt-busy');
      });
  }

  // Delegasi supaya butang yang ditambah kemudian (SPA) juga berfungsi.
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest && ev.target.closest('[data-bayarterus]');
    if (el && el.tagName !== 'FORM') handle(el, ev);
  });
  document.addEventListener('submit', function (ev) {
    var el = ev.target;
    if (el.hasAttribute && el.hasAttribute('data-bayarterus')) handle(el, ev);
  });

  window.BayarTerus = {
    __loaded: true,
    pay: pay,
    configure: function (o) {
      for (var k in o) cfg[k] = o[k];
    },
    origin: origin,
  };
})();
