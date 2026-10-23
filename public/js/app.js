/* ============================================================
   Meowji Official — shared frontend helpers (public/js/app.js)
   ============================================================ */
'use strict';

/* ---------------- HTTP ---------------- */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* non-JSON body */ }
  if (!res.ok) throw { status: res.status, data };
  return data;
}

/* ---------------- Formatting / escaping ---------------- */
// Display currencies. Prices are stored/charged in INR; rates are approximate
// and for display only. The store always charges the INR total.
const CURRENCIES = {
  INR: { label: 'India · INR (₹)',     symbol: '₹',   rate: 1,   locale: 'en-IN', decimals: 0 },
  USD: { label: 'USA · USD ($)',       symbol: '$',   rate: 103,  locale: 'en-US', decimals: 2 },
};
function getCurrency() {
  try {
    const c = localStorage.getItem('mds_currency');
    if (c && CURRENCIES[c]) return c;
  } catch (_) {}
  return 'INR';
}

/* Per-product currency availability: a product can be sold in INR only,
   USD only, or both. Missing flags default to available (backwards compat). */
function isAvailableInCurrency(p, currency) {
  const cur = currency || getCurrency();
  if (cur === 'USD') return !(p.available_usd === false || p.available_usd === 0 || p.available_usd === '0');
  return !(p.available_inr === false || p.available_inr === 0 || p.available_inr === '0');
}
function setCurrency(code) {
  if (!CURRENCIES[code]) return;
  try { localStorage.setItem('mds_currency', code); } catch (_) {}
  location.reload();
}
// fmt(): price in INR -> selected display currency. fmtINR(): always INR.
const fmt = (n) => {
  const cur = CURRENCIES[getCurrency()];
  const v = Number(n ?? 0) / cur.rate;
  const str = cur.decimals === 0
    ? Math.round(v).toLocaleString(cur.locale)
    : v.toLocaleString(cur.locale, { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
  return cur.symbol + str;
};
const fmtINR = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');
// AV COINS: 1 coin = ₹1, never converted by display currency.
const fmtCoins = (n) => Number(n ?? 0).toLocaleString('en-IN') + ' AV COINS';
// Dual-currency pricing: a product/variant may carry its own USD price
// (item.price_usd). When the $ selector is active and a USD price is set, it is
// used directly; otherwise the INR price converts at the fixed store rate.
// item = { price (INR, privileged-aware), price_usd (optional, privileged-aware) }.
const priceNow = (item) => {
  if (getCurrency() === 'USD' && item.price_usd != null && item.price_usd !== '') {
    return Number(item.price_usd);
  }
  return Number(item.price ?? 0) / CURRENCIES[getCurrency()].rate;
};
const fmtPrice = (item) => {
  if (getCurrency() === 'USD' && item.price_usd != null && item.price_usd !== '') {
    return '$' + Number(item.price_usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return fmt(item.price ?? 0);
};
// fmtCur(): format an amount already in the display currency (no conversion).
const fmtCur = (n) => {
  const cur = CURRENCIES[getCurrency()];
  const v = Number(n ?? 0);
  const str = cur.decimals === 0
    ? Math.round(v).toLocaleString(cur.locale)
    : v.toLocaleString(cur.locale, { minimumFractionDigits: cur.decimals, maximumFractionDigits: cur.decimals });
  return cur.symbol + str;
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
const waDigits = (n) => String(n || '').replace(/\D/g, '');
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

/* ---------------- Cart (localStorage 'mds_cart') ---------------- */
const CART_KEY = 'mds_cart';

function getCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(c) ? c : [];
  } catch (_) { return []; }
}
function setCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}
function cartKey(it) {
  return it.product_id + ':' + (it.variant_id || 0);
}
function addToCart(productId, qty = 1, variantId = null) {
  const cart = getCart();
  const vid = variantId ? Number(variantId) : null;
  const found = cart.find((i) => i.product_id === productId && (i.variant_id || null) === vid);
  if (found) found.qty = Math.min(99, (Number(found.qty) || 0) + Number(qty || 1));
  else cart.push({ product_id: productId, variant_id: vid, qty: Math.max(1, Number(qty || 1)) });
  setCart(cart);
}
function cartCount() {
  return getCart().reduce((s, i) => s + (Number(i.qty) || 0), 0);
}
function updateCartBadge() {
  const el = document.getElementById('cart-count');
  if (!el) return;
  const n = cartCount();
  el.textContent = n;
  el.classList.toggle('hidden', n === 0);
}

/* ---------------- Auth ---------------- */
let currentUser = null;

async function loadUser() {
  try {
    const d = await api('/api/auth/me');
    currentUser = d.user || null;
  } catch (e) {
    if (e && e.status === 401) currentUser = null;
    else throw e;
  }
  return currentUser;
}

function requireLogin() {
  if (!currentUser) {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    return false;
  }
  return true;
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  try { localStorage.removeItem(CART_KEY); } catch (_) {}
  location.href = '/';
}

/* ---------------- Inline SVG icons ---------------- */
const ICON = {
  cart: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 00-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 00-16.536-1.84M7.5 14.25L5.106 5.272M6 20.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm12.75 0a.75.75 0 11-1.5 0 .75.75 0 011.5 0z"/></svg>',
  user: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>',
  search: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>',
  menu: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/></svg>',
  x: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
  chevL: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>',
  chevR: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>',
  check: '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>',
  star: '<svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>',
  trash: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>',
  plus: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>',
  minus: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 12h14"/></svg>',
  bolt: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"/></svg>',
  logo: '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg>',
  shield: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>',
  chat: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457.133-.901.133-1.333 0-4.555-4.03-8.25-9-8.25S3 7.99 3 12.547c0 1.048.137 2.06.394 3.023.612 2.302 2.03 4.22 3.836 5.356"/></svg>',
  arrowR: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"/></svg>',
  tag: '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z"/><path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6z"/></svg>',
  spark: '<svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"/></svg>',
};

const SOCIAL = {
  instagram: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2.2c3.2 0 3.58.01 4.85.07 3.25.15 4.77 1.69 4.92 4.92.06 1.27.07 1.65.07 4.85s-.01 3.58-.07 4.85c-.15 3.23-1.66 4.77-4.92 4.92-1.27.06-1.64.07-4.85.07s-3.58-.01-4.85-.07c-3.26-.15-4.77-1.7-4.92-4.92C2.21 15.58 2.2 15.2 2.2 12s.01-3.58.07-4.85C2.42 3.92 3.94 2.38 7.19 2.23 8.46 2.21 8.8 2.2 12 2.2zm0 3.68a6.12 6.12 0 100 12.24 6.12 6.12 0 000-12.24zm0 10.1a3.98 3.98 0 110-7.96 3.98 3.98 0 010 7.96zm6.36-11.85a1.43 1.43 0 100 2.86 1.43 1.43 0 000-2.86z"/></svg>',
  x: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.9 2H22l-6.77 7.74L23.2 22h-6.24l-4.89-6.4L6.47 22H3.34l7.24-8.28L2.4 2h6.4l4.42 5.85L18.9 2zm-1.1 17.8h1.73L7.86 3.9H6.01L17.8 19.8z"/></svg>',
  youtube: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M23.5 6.2a3.02 3.02 0 00-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.51A3.02 3.02 0 00.5 6.2C0 8.07 0 12 0 12s0 3.93.5 5.8a3.02 3.02 0 002.12 2.14c1.88.51 9.38.51 9.38.51s7.5 0 9.38-.51a3.02 3.02 0 002.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.8zM9.55 15.57V8.43L15.82 12l-6.27 3.57z"/></svg>',
  telegram: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.94 0A12 12 0 100 12a12 12 0 0011.94 12h.06a12 12 0 000-24h-.06zM8.7 16.3l-.35-4.9 9.6-6.1c.42-.26.8.3.45.6l-7.9 7.1-.3 3.1c-.05.5-.7.6-.95.2l-1.7-2.1 3.2-2.9-3.9 2.5c-.4.25-.85-.1-.8-.55l.5-2.4 6.6-4.2-6.6 5.5-.31 1.15z" opacity=".9"/></svg>',
  whatsapp: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.558h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>',
};

/* ---------------- Toast ---------------- */
function toast(msg) {
  let wrap = document.getElementById('toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toast-wrap';
    wrap.className = 'fixed bottom-5 right-5 z-[100] flex flex-col gap-2 items-end';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast-in bg-gray-900 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-xl flex items-center gap-2 max-w-xs';
  el.innerHTML = '<span class="text-brand-400">' + ICON.check + '</span><span>' + esc(msg) + '</span>';
  wrap.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 350);
  }, 2600);
}

/* Renders the brand logo block: the uploaded custom logo image when set
   (settings.site_logo), otherwise the custom logo text (settings.site_logo_text),
   otherwise the default bolt mark + site name. */
function logoHtml(settings) {
  const s = settings || {};
  const siteName = s.site_name || 'Meowji Official';
  const custom = s.site_logo ? String(s.site_logo) : '';
  const customText = s.site_logo_text ? String(s.site_logo_text).trim() : '';
  if (custom) {
    return `<img src="${esc(custom)}" alt="${esc(siteName)}" class="h-12 w-auto max-w-[240px] object-contain">`;
  }
  if (customText) {
    return `<span class="font-black text-2xl tracking-tight bg-gradient-to-r from-[#f97316] to-[#0a3fb8] bg-clip-text text-transparent">${esc(customText)}</span>`;
  }
  return `<span class="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white flex items-center justify-center shadow-md shadow-brand-500/30">${ICON.logo}</span>
          <span class="font-extrabold text-xl tracking-tight text-gray-100">${esc(siteName)}</span>`;
}

/* ---------------- Form error helper ---------------- */
function formError(msg) {
  const el = document.getElementById('form-error');
  if (el) {
    if (msg) { el.textContent = msg; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  } else if (msg) toast(msg);
}

/* ---------------- Navbar / footer ---------------- */
function renderNavbar() {
  const host = document.getElementById('navbar');
  if (!host) return;
  const ctx = window.MDS || {};
  const user = ctx.user || null;
  const settings = ctx.settings || {};
  const categories = Array.isArray(ctx.categories) ? ctx.categories : [];
  const siteName = settings.site_name || 'Meowji Official';
  const waNum = waDigits(settings.whatsapp_number);
  const waSupportLink = waNum ? `https://wa.me/${waNum}` : '';

  const chevDown = '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>';
  const inMenu = (c) => c.show_in_menu !== 0;
  const menuCats = categories.filter(inMenu);
  const catLinks = menuCats.slice(0, 4).map((c) => {
    const kids = (Array.isArray(c.children) ? c.children : []).filter(inMenu);
    if (kids.length) {
      return `<div class="mg-navdrop">
        <a href="/?category=${esc(c.slug)}" class="px-3 py-2 text-sm font-bold text-gray-200 hover:text-[#c2410c] rounded-lg transition inline-flex items-center gap-1">${esc(c.name)}${chevDown}</a>
        <div class="mg-navdrop-menu">${kids.map((k) => `<a href="/?category=${esc(k.slug)}">${esc(k.name)}</a>`).join('')}</div>
      </div>`;
    }
    return `<a href="/?category=${esc(c.slug)}" class="px-3 py-2 text-sm font-bold text-gray-200 hover:text-[#c2410c] rounded-lg transition">${esc(c.name)}</a>`;
  }).join('');

  const acctLabel = user ? (user.name || 'Account') : 'Login';
  const acctHref = user ? '/account.html' : '/login.html';
  const roleLink = user && user.role === 'admin'
    ? `<a href="/admin.html" class="px-3 py-2 text-sm font-bold text-[#c2410c] rounded-lg transition">Admin</a>`
    : user && user.role === 'reseller'
    ? `<a href="/reseller.html" class="px-3 py-2 text-sm font-bold text-[#c2410c] rounded-lg transition">Reseller dashboard</a>`
    : '';

  const curOptions = Object.entries(CURRENCIES).map(([code, c]) =>
    `<option value="${code}"${code === getCurrency() ? ' selected' : ''}>${esc(c.label)}</option>`
  ).join('');

  const globeSm = '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path stroke-linecap="round" d="M3.5 12h17M12 3.5c2.4 2.5 3.7 5.4 3.7 8.5s-1.3 6-3.7 8.5c-2.4-2.5-3.7-5.4-3.7-8.5s1.3-6 3.7-8.5z"/></svg>';
  const boltSm = '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"/></svg>';
  const shieldSm = '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>';
  const headsetSm = '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 14v-2a8 8 0 0116 0v2"/><path stroke-linecap="round" stroke-linejoin="round" d="M4 14h2.5v5.5H5.75A1.75 1.75 0 014 17.75V14zm16 0h-2.5v5.5h.75a1.75 1.75 0 001.75-1.75V14z"/></svg>';

  host.innerHTML = `
  <div class="mg-trustbar">
    <div class="tb-row max-w-7xl mx-auto px-4 py-1.5 flex items-center justify-center gap-6">
      <span class="tb-item">${boltSm}Instant delivery</span>
      <span class="tb-item">${shieldSm}Secure payment</span>
      <span class="tb-item">${headsetSm}24/7 support</span>
    </div>
  </div>
  <header class="sticky top-0 z-40 bg-[#151b2e]/90 backdrop-blur-md border-b border-[#e2e8f0]">
    <div class="max-w-7xl mx-auto px-4">
      <div class="flex items-center gap-2 h-16">
        <button id="nav-toggle" class="md:hidden p-2 -ml-2 text-gray-300 hover:text-[#c2410c] rounded-lg" aria-label="Menu">${ICON.menu}</button>
        <a href="/" class="flex items-center gap-2 shrink-0">
          ${logoHtml(settings)}
        </a>
        <nav class="hidden md:flex items-center gap-0.5 mx-auto">
          <a href="/" class="px-3 py-2 text-sm font-bold text-gray-200 hover:text-[#c2410c] rounded-lg transition">Home</a>
          ${catLinks}
          <a href="/blog.html" class="px-3 py-2 text-sm font-bold text-gray-200 hover:text-[#c2410c] rounded-lg transition">Blog</a>
        </nav>
        <div class="flex items-center gap-1 ml-auto md:ml-0">
          <label class="mg-cur-pill hidden sm:inline-flex" aria-label="Country / currency">${globeSm}<select id="currency-select" style="background:transparent;border:none;outline:none;font:inherit;cursor:pointer">${curOptions}</select></label>
          <a href="${acctHref}" class="hidden sm:flex items-center gap-1.5 px-3 py-2 text-sm font-bold text-gray-200 hover:text-[#c2410c] rounded-lg transition"><span class="text-gray-500">${ICON.user}</span><span class="max-w-28 truncate">${esc(acctLabel)}</span></a>
          ${roleLink}
          <a href="/cart.html" class="relative p-2 text-gray-300 hover:text-[#c2410c] rounded-lg transition" aria-label="Cart">${ICON.cart}<span id="cart-count" class="hidden absolute -top-0.5 -right-0.5 min-w-[20px] h-5 px-1 rounded-full bg-[#f97316] text-[#ffffff] text-[11px] font-bold flex items-center justify-center">0</span></a>
          <button id="theme-toggle" class="p-2 text-gray-300 hover:text-[#c2410c] rounded-lg transition" aria-label="Toggle dark mode">
            <svg id="theme-icon-moon" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0012 21.75a9.753 9.753 0 009.752-6.748z"/></svg>
            <svg id="theme-icon-sun" class="w-5 h-5 hidden" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"/></svg>
          </button>
        </div>
      </div>
    </div>
    <div class="max-w-7xl mx-auto px-4 pb-3">
      <form data-search class="mg-searchpill max-w-2xl mx-auto">
        <span class="text-gray-400 shrink-0">${ICON.search}</span>
        <input name="q" placeholder="Find games, gift cards or top-ups" aria-label="Search products">
        <span class="mg-kbd">/</span>
        <button type="submit" class="mg-btn-dark shrink-0" style="padding:.6rem 1.5rem;font-size:.85rem">Search</button>
      </form>
    </div>
    <div class="max-w-7xl mx-auto px-4">
      <div id="mobile-menu" class="hidden md:hidden pb-4 border-t border-[#e2e8f0]">
        <form data-search class="flex items-center relative mt-3 sm:hidden">
          <input type="text" name="q" placeholder="Find games, gift cards or top-ups" class="field w-full text-sm border border-[#e2e8f0] rounded-full pl-9 pr-3 py-2.5 bg-[#f6f7f9]">
          <span class="absolute left-3 text-gray-400">${ICON.search}</span>
        </form>
        <div class="mt-3 bg-[#2b1c0d] rounded-2xl px-5 py-3.5 flex items-center justify-between">
          <span class="flex items-center gap-2 text-[15px] font-extrabold text-gray-100"><span class="text-[#f97316]">${globeSm}</span>Currency</span>
          <span class="relative inline-flex items-center">
            <select id="currency-select-mobile" aria-label="Currency" class="appearance-none bg-[#151b2e] rounded-full pl-4 pr-9 py-2 text-sm font-extrabold text-gray-100 shadow-sm cursor-pointer outline-none max-w-[190px] truncate">${curOptions}</select>
            <span class="pointer-events-none absolute right-3 text-gray-400">${chevDown}</span>
          </span>
        </div>
        <nav class="flex flex-col gap-2.5 mt-3">
          <a href="/" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-gray-100">Home</a>
          ${menuCats.map((c) => {
            const kids = (Array.isArray(c.children) ? c.children : []).filter(inMenu);
            if (!kids.length) return `<a href="/?category=${esc(c.slug)}" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-gray-100">${esc(c.name)}</a>`;
            return `<div class="bg-[#f6f7f9] rounded-2xl overflow-hidden">
              <div class="flex items-center">
                <a href="/?category=${esc(c.slug)}" class="flex-1 px-5 py-4 text-[15px] font-extrabold text-gray-100">${esc(c.name)}</a>
                <button type="button" class="mm-sub-toggle p-4 mr-1 text-gray-400 transition-transform" aria-label="Show sub-categories">${chevDown}</button>
              </div>
              <div class="mm-sub hidden px-3 pb-3 flex flex-col gap-1.5">
                ${kids.map((k) => `<a href="/?category=${esc(k.slug)}" class="block bg-[#151b2e] rounded-xl px-4 py-3 text-sm font-bold text-gray-300">${esc(k.name)}</a>`).join('')}
              </div>
            </div>`;
          }).join('')}
          <a href="/" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-gray-100">All Products</a>
          <a href="/blog.html" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-gray-100">Blog</a>
          ${waSupportLink ? `<a href="${waSupportLink}" target="_blank" rel="noopener" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-gray-100">24/7 Support</a>` : ''}
          <a href="${acctHref}" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-gray-100">${user ? 'My Account' : 'Sign in'}</a>
          ${user && user.role === 'admin' ? '<a href="/admin.html" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-[#c2410c]">Admin</a>' : ''}
          ${user && user.role === 'reseller' ? '<a href="/reseller.html" class="block bg-[#f6f7f9] rounded-2xl px-5 py-4 text-[15px] font-extrabold text-[#c2410c]">Reseller dashboard</a>' : ''}
        </nav>
      </div>
    </div>
  </header>`;

  const toggle = document.getElementById('nav-toggle');
  const menu = document.getElementById('mobile-menu');
  if (toggle && menu) toggle.addEventListener('click', () => menu.classList.toggle('hidden'));

  host.querySelectorAll('form[data-search]').forEach((f) => {
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = f.querySelector('input[name="q"]').value.trim();
      if (q) location.href = '/search.html?q=' + encodeURIComponent(q);
    });
  });
  const curSel = document.getElementById('currency-select');
  if (curSel) curSel.addEventListener('change', (e) => setCurrency(e.target.value));
  const curSelM = document.getElementById('currency-select-mobile');
  if (curSelM) curSelM.addEventListener('change', (e) => setCurrency(e.target.value));
  host.querySelectorAll('.mm-sub-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sub = btn.parentElement.nextElementSibling;
      if (sub) sub.classList.toggle('hidden');
      btn.classList.toggle('rotate-180');
    });
  });
  updateCartBadge();
  initLiveSearch();
}

/* ---------------- Live search suggestions ---------------- */
function flatCategories(tree) {
  const out = [];
  (function walk(list, ancestors) {
    for (const c of list || []) {
      out.push({ slug: c.slug, name: c.name, image_url: c.image_url || '', show_in_menu: c.show_in_menu, depth: ancestors.length, ancestors: ancestors.slice() });
      walk(c.children, ancestors.concat(c.name));
    }
  })(tree, []);
  return out;
}

/* Word-order matcher shared by suggestions + search page: every query word
   must be a prefix of a word in the haystack, in the same order. */
function normText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function searchWords(q) {
  return normText(q).split(' ').filter(Boolean);
}
function wordsInOrder(hay, qWords) {
  if (!qWords.length) return false;
  const hw = normText(hay).split(' ').filter(Boolean);
  let hi = 0;
  for (const q of qWords) {
    let found = -1;
    for (let i = hi; i < hw.length; i++) {
      if (hw[i].startsWith(q)) { found = i; break; }
    }
    if (found < 0) return false;
    hi = found + 1;
  }
  return true;
}

function initLiveSearch() {
  const forms = document.querySelectorAll('form[data-search]');
  if (!forms.length) return;
  const cats = flatCategories((window.MDS || {}).categories || []);
  forms.forEach((form) => {
    const input = form.querySelector('input[name="q"]');
    if (!input || input.dataset.liveSearch) return;
    input.dataset.liveSearch = '1';
    if (getComputedStyle(form).position === 'static') form.style.position = 'relative';
    const drop = document.createElement('div');
    drop.className = 'mg-suggest';
    drop.hidden = true;
    form.appendChild(drop);
    let timer = null;
    const close = () => { drop.hidden = true; };
    const go = (url) => { close(); location.href = url; };

    const render = (matchedCats, matchedProds, q) => {
      const catHtml = matchedCats.length
        ? `<div class="mg-suggest-group">Categories</div>` + matchedCats.map((c) => `
              <button type="button" class="mg-suggest-row" data-url="/?category=${esc(c.slug)}">
                <span class="mg-suggest-thumb ${c.image_url ? '' : 'mg-suggest-cat'}">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : '&rsaquo;'}</span>
                <span class="mg-suggest-name" style="white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(c.name)}</span>
                <span class="mg-suggest-tag">${esc(c.ancestors.length ? c.ancestors[c.ancestors.length - 1] : 'Category')}</span>
              </button>`).join('')
        : '';
      const prodHtml = matchedProds.length
        ? `<div class="mg-suggest-group">Products</div>` + matchedProds.map((p) => `
              <button type="button" class="mg-suggest-row" data-url="/product.html?slug=${esc(p.slug)}">
                <span class="mg-suggest-thumb ${p.image_url ? '' : 'mg-suggest-cat'}">${p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : '&#9670;'}</span>
                <span class="mg-suggest-name" style="white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(p.name)}</span>
                <span class="mg-suggest-tag">${esc(fmtPrice(p))}</span>
              </button>`).join('')
        : '';
      if (!catHtml && !prodHtml) {
        drop.innerHTML = `<div class="mg-suggest-empty">No matches for &ldquo;${esc(q)}&rdquo; &mdash; press Enter to search</div>`;
      } else {
        drop.innerHTML = catHtml + prodHtml;
      }
      drop.hidden = false;
      drop.querySelectorAll('.mg-suggest-row').forEach((row) => {
        row.addEventListener('mousedown', (e) => { e.preventDefault(); go(row.dataset.url); });
      });
    };

    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        // Sub-categories: match own name or any parent category name,
        // query words in the same order. Products: server-side relevance search.
        const qw = searchWords(q);
        const matchedCats = cats
          .filter((c) => c.depth > 0)
          .filter((c) => wordsInOrder(c.name, qw) || (c.ancestors || []).some((a) => wordsInOrder(a, qw)))
          .slice(0, 6);
        let matchedProds = [];
        try {
          matchedProds = (await api('/api/products?search=' + encodeURIComponent(q) + '&limit=5')) || [];
        } catch (_) { /* suggestions stay category-only on API failure */ }
        render(matchedCats, matchedProds, q);
      }, 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { close(); input.blur(); }
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });
  });
}

function renderFooter() {
  const host = document.getElementById('footer');
  if (!host) return;
  const ctx = window.MDS || {};
  const settings = ctx.settings || {};
  const categories = Array.isArray(ctx.categories) ? ctx.categories : [];
  const siteName = settings.site_name || 'Meowji Official';
  const wa = waDigits(settings.whatsapp_number);
  const waLink = wa ? `https://wa.me/${wa}` : '#';
  const year = new Date().getFullYear();

  const shopLinks = [
    ...categories.filter((c) => c.show_in_menu !== 0).slice(0, 5).map((c) => ({ href: `/?category=${esc(c.slug)}`, label: esc(c.name) })),
    { href: '/cart.html', label: 'Cart' },
  ];
  const supportLinks = [
    { href: waLink, label: 'WhatsApp support', blank: true },
    { href: '/account.html', label: 'My account' },
    { href: '/wallet.html', label: 'Wallet' },
    { href: '/faq.html', label: 'FAQ' },
    { href: '/refunds.html', label: 'Refund policy' },
  ];
  const companyLinks = [
    { href: '/blog.html', label: 'Blog' },
    { href: '/terms.html', label: 'Terms of service' },
    { href: '/privacy.html', label: 'Privacy policy' },
  ];
  const linkList = (links) =>
    `<ul>${links.map((l) => `<li><a href="${l.href}"${l.blank ? ' target="_blank" rel="noopener"' : ''}>${l.label}</a></li>`).join('')}</ul>`;

  const payBadges = ['UPI', 'VISA', 'Mastercard', 'XtraGateway']
    .map((p) => `<span class="mg-pay-badge">${p}</span>`).join('');

  const accordion = (name, body) => `
    <details class="border-b border-[#e2e8f0]">
      <summary class="py-3.5 text-sm font-extrabold text-gray-100 cursor-pointer list-none flex items-center justify-between">${name}<span class="text-gray-400">${ICON.chevR}</span></summary>
      <div class="pb-5">${body}</div>
    </details>`;

  const socialLinks = [
    ['social_instagram', 'Instagram', SOCIAL.instagram],
    ['social_x', 'X', SOCIAL.x],
    ['social_youtube', 'YouTube', SOCIAL.youtube],
    ['social_whatsapp', 'WhatsApp', SOCIAL.whatsapp],
  ].map(([key, label, icon]) => {
    const raw = String(settings[key] || '').trim();
    if (!raw) return '';
    const href = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
    return `<a href="${esc(href)}" aria-label="${label}" target="_blank" rel="noopener" class="mg-social">${icon}</a>`;
  }).join('');

  host.innerHTML = `
  <footer class="mg-footer mt-20">
    <div class="max-w-7xl mx-auto px-4 py-14 grid gap-10 md:grid-cols-5">
      <div>
        <a href="/" class="flex items-center gap-2 mb-4">
          ${logoHtml(settings)}
        </a>
        <p class="text-sm text-gray-500 leading-relaxed">Game top-ups, gift cards &amp; subscriptions — delivered fast.</p>
        <div class="flex gap-2.5 mt-5">
          ${socialLinks}
        </div>
      </div>
      <div class="md:hidden">
        ${accordion('Shop', linkList(shopLinks))}
        ${accordion('Support', linkList(supportLinks))}
        ${accordion('Company', linkList(companyLinks))}
        ${accordion('We accept', `<div class="flex flex-wrap gap-2">${payBadges}</div>`)}
      </div>
      <div class="hidden md:block"><h4>Shop</h4>${linkList(shopLinks)}</div>
      <div class="hidden md:block"><h4>Support</h4>${linkList(supportLinks)}</div>
      <div class="hidden md:block"><h4>Company</h4>${linkList(companyLinks)}</div>
      <div class="hidden md:block"><h4>We accept</h4><div class="flex flex-wrap gap-2">${payBadges}</div></div>
    </div>
    <div class="border-t border-[#e2e8f0]">
      <div class="max-w-7xl mx-auto px-4 py-5 flex flex-col sm:flex-row gap-1.5 items-center justify-between text-xs text-gray-400">
        <span>© ${year} ${esc(siteName)}</span>
        <span>Digital goods delivered electronically.</span>
      </div>
    </div>
  </footer>`;
}

/* ---------------- Product bits ---------------- */
function discountPct(p) {
  const mrp = Number(p.price_mrp), price = Number(p.price);
  if (mrp && mrp > price) return Math.round((1 - price / mrp) * 100);
  return 0;
}
function isOutOfStock(p) {
  return String(p.stock_status || '').toLowerCase().includes('out');
}
function stockBadge(p) {
  const s = String(p.stock_status || '').toLowerCase();
  if (s.includes('out')) return '<span class="badge badge-red">Out of stock</span>';
  if (s.includes('low')) return '<span class="badge badge-amber">Low stock</span>';
  return '';
}
function productImage(p, cls, initialSize) {
  if (p.image_url) {
    return `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" class="${cls} object-cover">`;
  }
  const initial = esc((String(p.name || '?').trim().charAt(0) || '?').toUpperCase());
  return `<div class="${cls} placeholder-gradient flex items-center justify-center"><span class="text-white ${initialSize || 'text-5xl'} font-extrabold opacity-90">${initial}</span></div>`;
}

/* Listing card: coin chip + name/price + quick Add/Buy on the same page.
   Price is also on the product page below the options. */
function productCard(p) {
  const out = isOutOfStock(p);
  // Currency availability: a product not sold in the active currency is shown
  // as out of stock (not hidden) so buyers see it exists.
  const curOut = !isAvailableInCurrency(p);
  const soldOut = out || curOut;
  const sale = p.price_mrp && Number(p.price_mrp) > Number(p.price);
  const href = `/product.html?slug=${esc(p.slug)}`;
  const low = !soldOut && String(p.stock_status || '').toLowerCase().includes('low');
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const hasVariants = variants.length > 0;
  const cheapest = hasVariants ? variants.reduce((a, b) => (priceNow(a) <= priceNow(b) ? a : b)) : p;
  // Currency-unavailable products: show the price in their native currency
  // instead of a converted ₹0/$0.00.
  let priceStr;
  if (curOut && getCurrency() === 'INR' && cheapest.price_usd != null && cheapest.price_usd !== '') {
    priceStr = '$' + Number(cheapest.price_usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (curOut && getCurrency() === 'USD' && cheapest.price != null) {
    priceStr = fmt(cheapest.price);
  } else {
    priceStr = fmtPrice(cheapest);
  }
  const mrpStr = sale && !hasVariants && !curOut ? `<span class="text-[12px] font-bold text-[#8b93b0] line-through ml-2">${fmt(p.price_mrp)}</span>` : '';
  const resellerLine = p.price_reseller != null && !curOut
    ? `<div class="text-[#8b93b0] text-[11px] mt-1">Reseller: ${fmtPrice(cheapest)}</div>` : '';
  const curTag = curOut ? `<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-[#151b2e]/10 text-white/70">${esc(getCurrency() === 'USD' ? 'INR only' : 'USD only')}</span>` : '';
  const badges = `
    ${sale ? '<span class="bg-[#e11d48] text-white text-[9px] font-extrabold px-1.5 py-0.5 rounded-md leading-none tracking-wide">SALE</span>' : ''}
    ${low ? '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-brand-400/15 text-brand-300 border border-brand-400/30">Low stock</span>' : ''}
    ${soldOut ? '<span class="text-[9px] font-bold px-2 py-0.5 rounded-full bg-red-400/15 text-red-300 border border-red-400/30">Out of stock</span>' : ''}
    ${curTag}`;
  let actions;
  if (soldOut) {
    actions = `<span class="text-xs font-bold text-red-400">Out of stock</span>`;
  } else if (hasVariants) {
    actions = `<a href="${href}" class="flex-1 text-center text-xs font-extrabold text-white bg-[#f97316] rounded-full px-4 py-3.5 hover:opacity-90 active:scale-[0.98] transition">Choose option</a>`;
  } else {
    actions = `
      <button onclick="mdsQuickAdd(event, ${Number(p.id)})" class="flex-1 text-xs font-extrabold text-[#101828] bg-[#151b2e] rounded-full px-3 py-3.5 hover:bg-[#1b2338] active:scale-[0.98] transition">Add to cart</button>
      <button onclick="mdsQuickBuy(event, ${Number(p.id)})" class="flex-1 text-xs font-extrabold text-white bg-[#f97316] rounded-full px-3 py-3.5 hover:opacity-90 active:scale-[0.98] transition">Buy now</button>`;
  }
  const cardImg = p.image_url
    ? `<a href="${href}" class="block mt-2 rounded-xl overflow-hidden bg-[#151b2e]/5"><img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" class="w-full aspect-square object-cover"></a>`
    : '';
  return `<div class="h-full rounded-[1.25rem] bg-[#151d38] p-4 shadow-sm hover:shadow-lg transition ${soldOut ? 'opacity-70' : ''}">
    <div class="flex gap-1.5 flex-wrap">${badges}</div>
    ${cardImg}
    <a href="${href}" class="block mt-1.5 text-[#5b8cff] text-[12px] font-extrabold uppercase tracking-wider line-clamp-2 leading-snug break-words hover:text-[#7da2ff]">${esc(p.name)}</a>
    <div class="mt-1.5 text-white text-[26px] font-extrabold leading-none">${hasVariants ? '<span class="text-[13px] font-bold text-[#8b93b0]">From </span>' : ''}${priceStr}${mrpStr}</div>
    ${resellerLine}
    <div class="flex gap-2 mt-3">${actions}</div>
  </div>`;
}

/* Related-product card ("You may also like"): squared, compact, professional.
   Vertical layout, whole card links to the product page. *//* Related-product card ("You may also like"): squared, compact, professional.
   Vertical layout, whole card links to the product page. */
function relatedCard(p) {
  const out = isOutOfStock(p);
  const curOut = !isAvailableInCurrency(p);
  const soldOut = out || curOut;
  const href = `/product.html?slug=${esc(p.slug)}`;
  const variants = Array.isArray(p.variants) ? p.variants : [];
  const hasVariants = variants.length > 0;
  const priceHtml = hasVariants
    ? `<span class="text-[12px] font-bold text-gray-500">From ${fmtPrice(variants.reduce((a, b) => (priceNow(a) <= priceNow(b) ? a : b)))}</span>`
    : `<span class="text-[12px] font-bold text-gray-500">${fmtPrice(p)}</span>`;
  const chipImg = p.chip_image_url ? String(p.chip_image_url) : '';
  const chipTxt = p.chip_text ? String(p.chip_text).slice(0, 6) : '';
  const chip = chipImg
    ? `<span class="mds-chip mds-chip-img"><img src="${esc(chipImg)}" alt="" loading="lazy"></span>`
    : chipTxt
      ? `<span class="mds-chip mds-chip-gold mds-chip-txt">${esc(chipTxt)}</span>`
      : `<span class="mds-chip mds-chip-gold">₹</span>`;
  const cta = soldOut
    ? `<span class="mt-2 text-[11px] font-bold text-red-600">Out of stock</span>`
    : `<span class="mt-2 inline-block text-[11px] font-extrabold text-white bg-[#f97316] rounded-lg px-4 py-1.5">${hasVariants ? 'Choose option' : 'View'}</span>`;
  return `<a href="${href}" class="block h-full rounded-lg border border-[#1d263e] bg-[#151b2e] p-3 shadow-sm hover:shadow-md hover:border-[#f97316]/30 transition ${soldOut ? 'opacity-70' : ''}">
    <div class="flex flex-col items-center text-center">
      ${chip}
      <div class="mt-2 font-bold text-[#101828] text-[13px] leading-snug line-clamp-2 min-h-[2.4em]">${esc(p.name)}</div>
      <div class="mt-1">${priceHtml}</div>
      ${cta}
    </div>
  </a>`;
}

/* Quick buy from listing cards (quick add already exists below). */
function mdsQuickBuy(ev, id) {
  ev.preventDefault();
  ev.stopPropagation();
  addToCart(Number(id), 1);
  location.href = '/cart.html';
}

/* Global handler used by inline onclick in productCard */
function mdsQuickAdd(ev, id) {
  ev.preventDefault();
  ev.stopPropagation();
  addToCart(Number(id), 1);
  toast('Added to cart');
}

function statusBadge(status) {
  const map = {
    pending: 'bg-brand-100 text-brand-800',
    paid: 'bg-brand-100 text-brand-800',
    delivered: 'bg-brand-100 text-brand-700',
    cancelled: 'bg-red-100 text-red-800',
  };
  return `<span class="text-xs font-bold px-2.5 py-1 rounded-full capitalize ${map[status] || 'bg-[#1b2338] text-gray-300'}">${esc(status || 'unknown')}</span>`;
}

function stars(rating) {
  const r = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  let out = '<span class="inline-flex gap-0.5 text-brand-400">';
  for (let i = 1; i <= 5; i++) {
    out += `<span class="${i <= r ? '' : 'text-gray-300'}">${ICON.star}</span>`;
  }
  return out + '</span>';
}

function sectionHead(a, b, c) {
  // Backward compatible: sectionHead(title, sub) or sectionHead(eyebrow, title, sub)
  let eyebrow = '', title = '', sub = '';
  if (c === undefined) { title = a; sub = b; }
  else { eyebrow = a; title = b; sub = c; }
  return `
  <div class="mb-6 reveal">
    ${eyebrow ? `<div class="mg-eyebrow mb-2">${esc(eyebrow)}</div>` : ''}
    <h2 class="text-2xl sm:text-3xl font-extrabold tracking-tight text-gray-100">${esc(title)}</h2>
    ${sub ? `<p class="text-gray-500 mt-1 text-sm sm:text-base">${esc(sub)}</p>` : ''}
  </div>`;
}

/* ---------------- Mobile bottom nav ---------------- */
function renderBottomNav() {
  if (document.querySelector('.mg-bottomnav')) return; // idempotent
  const ctx = window.MDS || {};
  const settings = ctx.settings || {};
  const user = ctx.user || null;
  const path = location.pathname || '/';
  const hash = location.hash || '';
  const acctHref = user ? '/account.html' : '/login.html';

  const homeIcon = '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75"/></svg>';

  const searchIcon = '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>';
  const bagIcon = '<svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 10.5V6a3.75 3.75 0 10-7.5 0v4.5m11.356-1.993l1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 01-1.12-1.243l1.264-12A1.125 1.125 0 015.513 7.5h12.974c.576 0 1.059.435 1.119 1.007z"/></svg>';

  const link = (href, icon, label, active, extra) =>
    `<a href="${href}" class="${active ? 'active' : ''}"${extra || ''}>${icon}<span>${label}</span></a>`;

  const nav = document.createElement('nav');
  nav.className = 'mg-bottomnav';
  nav.setAttribute('aria-label', 'Mobile navigation');
  const acctPaths = ['/account.html', '/wallet.html', '/login.html', '/register.html'];
  nav.innerHTML =
    link('/', homeIcon, 'Home', path === '/' && !hash) +
    link('/search.html', searchIcon, 'Search', path === '/search.html') +
    link('/#sec-categories', bagIcon, 'Shop', path === '/' && hash === '#sec-categories') +
    link('/cart.html', ICON.cart, 'Cart', path === '/cart.html') +
    link(acctHref, ICON.user, 'Account', acctPaths.includes(path));
  document.body.appendChild(nav);
}

/* ---------------- Scroll reveal ---------------- */
function initReveal() {
  const els = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach((e) => e.classList.add('visible'));
    return;
  }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('visible'); io.unobserve(en.target); }
    });
  }, { threshold: 0.06 });
  els.forEach((e) => io.observe(e));
}

/* ---------------- Page boot ---------------- */
/* ---------------- Theme (dark / light) ---------------- */
function applyThemeIcon() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const moon = document.getElementById('theme-icon-moon');
  const sun = document.getElementById('theme-icon-sun');
  if (moon) moon.classList.toggle('hidden', dark);
  if (sun) sun.classList.toggle('hidden', !dark);
}
function initTheme() {
  try {
    const saved = localStorage.getItem('mds_theme');
    const theme = saved || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (_) {}
  applyThemeIcon();
  const btn = document.getElementById('theme-toggle');
  if (btn && !btn.dataset.wired) {
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('mds_theme', next); } catch (_) {}
      applyThemeIcon();
    });
  }
}

async function boot() {
  if (!window.MDS) window.MDS = {};
  try { await loadUser(); } catch (e) { console.warn('loadUser failed', e); }
  let settings = {}, categories = [];
  try { settings = await api('/api/settings/public'); } catch (e) { console.warn('settings failed', e); }
  try { categories = await api('/api/categories'); } catch (e) { console.warn('categories failed', e); }
  window.MDS.user = currentUser;
  window.MDS.settings = settings;
  window.MDS.categories = categories;
  // Custom favicon uploaded in Admin → Settings (falls back to /favicon.ico).
  try {
    const fav = settings && settings.favicon ? String(settings.favicon) : '';
    if (fav) {
      let link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = fav;
    }
  } catch (e) { console.warn('favicon apply failed', e); }
  renderNavbar();
  renderFooter();
  initTheme();
  initReveal();
  renderBottomNav();
  initSupportWidget();
  return window.MDS;
}

/* Guard: require one of the given roles; redirects otherwise. Returns user or null. */
async function guard(roles, fallback) {
  await boot();
  const u = currentUser;
  if (!u) {
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
    return null;
  }
  if (!roles.includes(u.role)) {
    location.href = fallback || '/';
    return null;
  }
  return u;
}

/* ---------------- Google Identity Services (optional) ---------------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.defer = true;
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function initGoogleAuth(buttonHostId, noticeId) {
  const host = document.getElementById(buttonHostId);
  const notice = document.getElementById(noticeId);
  let cfg = { enabled: false };
  try { cfg = await api('/api/auth/google-config'); } catch (_) {}
  if (cfg.enabled && cfg.client_id && host) {
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      window.google.accounts.id.initialize({
        client_id: cfg.client_id,
        callback: async (resp) => {
          formError(null);
          try {
            const d = await api('/api/auth/google', {
              method: 'POST',
              body: JSON.stringify({ credential: resp.credential }),
            });
            afterAuth(d.user);
          } catch (e) {
            formError((e && e.data && e.data.error) || 'Google sign-in failed. Please try again.');
          }
        },
      });
      window.google.accounts.id.renderButton(host, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
      return;
    } catch (_) { /* fall through to notice */ }
  }
  if (notice) notice.classList.remove('hidden');
}

function afterAuth(user) {
  currentUser = user;
  const params = new URLSearchParams(location.search);
  const next = params.get('next');
  if (next && next.startsWith('/') && !next.startsWith('//')) { location.href = next; return; }
  if (user.role === 'admin') location.href = '/admin.html';
  else if (user.role === 'reseller') location.href = '/reseller.html';
  else location.href = '/';
}

/* ---------------- Support chat widget ---------------- */
const SUPPORT_GUEST_KEY = 'mds_support_guest';
const supportState = { open: false, threadId: null, guestToken: null, lastMsgId: 0, pollTimer: null, starting: false };

function supportGuestToken() {
  let t = null;
  try { t = localStorage.getItem(SUPPORT_GUEST_KEY); } catch (_) {}
  return t;
}
function setSupportGuestToken(t) {
  try { localStorage.setItem(SUPPORT_GUEST_KEY, t); } catch (_) {}
  supportState.guestToken = t;
}

function supportMsgHtml(m) {
  const mine = m.sender === 'customer';
  const img = m.attachment_url
    ? `<a href="${esc(m.attachment_url)}" target="_blank" rel="noopener"><img src="${esc(m.attachment_url)}" alt="Attachment" class="rounded-xl max-w-[220px] max-h-[220px] object-cover mt-1 ${m.body ? '' : '-mt-1'}"></a>`
    : '';
  const txt = m.body ? esc(m.body) : '';
  return `
  <div class="flex ${mine ? 'justify-end' : 'justify-start'} mb-2.5">
    <div class="max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words ${
      mine ? 'text-white rounded-br-md' : 'bg-[#1b2338] text-gray-200 rounded-bl-md'
    }" ${mine ? 'style="background:#f97316"' : ''}>${txt}${img}</div>
  </div>`;
}

function renderSupportMessages(messages, append) {
  const box = document.getElementById('support-messages');
  if (!box) return;
  if (!append) box.innerHTML = '';
  const empty = box.querySelector('[data-empty]');
  if (empty) empty.remove();
  box.insertAdjacentHTML('beforeend', messages.map(supportMsgHtml).join(''));
  box.scrollTop = box.scrollHeight;
}

async function supportStart() {
  if (supportState.starting) return;
  supportState.starting = true;
  const box = document.getElementById('support-messages');
  try {
    let customerName = 'Guest';
    if (window.MDS && window.MDS.user && window.MDS.user.name) customerName = window.MDS.user.name;
    else {
      try { customerName = localStorage.getItem('mds_support_name') || 'Guest'; } catch (_) {}
    }
    const r = await api('/api/support/start', {
      method: 'POST',
      body: JSON.stringify({ guest_token: supportGuestToken(), customer_name: customerName }),
    });
    supportState.threadId = r.thread.id;
    if (r.guest_token) setSupportGuestToken(r.guest_token);
    supportState.lastMsgId = 0;
    renderSupportMessages(r.messages || []);
    supportState.lastMsgId = (r.messages || []).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
    const statusEl = document.getElementById('support-status');
    if (statusEl) {
      const closed = r.thread.status !== 'open';
      statusEl.innerHTML = closed
        ? '<span class="text-xs font-bold text-brand-600">This chat is closed — send a message to start a new one.</span>'
        : '<span class="text-xs text-gray-400">Typically replies within a few hours</span>';
    }
  } catch (e) {
    if (box) box.innerHTML = `<div class="text-center text-sm text-red-500 py-8">Could not load chat. Please try again.</div>`;
  } finally {
    supportState.starting = false;
  }
}

async function supportPoll() {
  if (!supportState.open || !supportState.threadId) return;
  try {
    const q = new URLSearchParams({ after: String(supportState.lastMsgId) });
    const gt = supportGuestToken();
    if (gt) q.set('guest_token', gt);
    const r = await api('/api/support/thread/' + supportState.threadId + '/messages?' + q.toString());
    if (r.messages && r.messages.length) {
      renderSupportMessages(r.messages, true);
      supportState.lastMsgId = r.messages.reduce((m, x) => Math.max(m, Number(x.id) || 0), supportState.lastMsgId);
    }
  } catch (_) { /* polling is best-effort */ }
}

let supportAttachment = null; // data URL of pending image attachment

function supportClearAttachment() {
  supportAttachment = null;
  const p = document.getElementById('support-preview');
  if (p) p.classList.add('hidden');
  const f = document.getElementById('support-file');
  if (f) f.value = '';
}

function supportHandleFile(file) {
  if (!file || !file.type.startsWith('image/')) { toast('Please choose an image file.'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('Image must be 5MB or smaller.'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Downscale to max 1024px to keep the data URL small.
      const max = 1024;
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      supportAttachment = c.toDataURL('image/jpeg', 0.82);
      const prev = document.getElementById('support-preview-img');
      const box = document.getElementById('support-preview');
      if (prev) prev.src = supportAttachment;
      if (box) box.classList.remove('hidden');
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

async function supportSend() {
  const input = document.getElementById('support-input');
  const body = input ? input.value.trim() : '';
  const attachment = supportAttachment;
  if ((!body && !attachment) || !supportState.threadId) return;
  input.value = '';
  input.disabled = true;
  try {
    const r = await api('/api/support/thread/' + supportState.threadId + '/messages', {
      method: 'POST',
      body: JSON.stringify({ body, attachment_url: attachment, guest_token: supportGuestToken() }),
    });
    supportClearAttachment();
    if (r.message) {
      renderSupportMessages([r.message], true);
      supportState.lastMsgId = Math.max(supportState.lastMsgId, Number(r.message.id) || 0);
    }
  } catch (e) {
    if (e && e.data && e.data.error && /closed/i.test(e.data.error)) {
      supportState.threadId = null;
      await supportStart();
      return supportSend();
    }
    if (input) input.value = body;
    toast((e && e.data && e.data.error) || 'Could not send. Try again.');
  } finally {
    if (input) input.disabled = false;
    if (input) input.focus();
  }
}

function supportChannelList() {
  const s = (window.MDS && window.MDS.settings) || {};
  const list = [];
  let waUrl = s.support_whatsapp_url || '';
  if (!waUrl && s.whatsapp_number) {
    const digits = String(s.whatsapp_number).replace(/\D/g, '');
    if (digits) waUrl = 'https://wa.me/' + digits;
  }
  if (waUrl) list.push({ id: 'whatsapp', label: 'WhatsApp', url: waUrl, color: '#25D366', icon: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.558h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>' });
  if (s.support_telegram_url) list.push({ id: 'telegram', label: 'Telegram', url: s.support_telegram_url, color: '#229ED9', icon: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M21.9 4.6L2.8 12c-.9.3-.9 1.6 0 1.9l4.7 1.5 1.8 5.6c.3.9 1.5 1 2 .2l2.7-3.2 5.1 3.8c.7.5 1.7.1 1.9-.8l2.8-14.6c.2-1.1-1-1.9-1.9-1.4zM8.5 13.2l9.3-6.9c.2-.2.5.1.3.3l-7.7 7.4-.3 2.8-1.6-3.6z"/></svg>' });
  if (s.support_wechat_id) list.push({ id: 'wechat', label: 'WeChat', wechatId: s.support_wechat_id, color: '#07C160', icon: '<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M9.5 3.5C5.4 3.5 2 6.4 2 10c0 2 1.2 3.9 3 5.1l-.7 2.4 2.8-1.4c.8.2 1.6.4 2.4.4h.4c-.4-1-.6-2-.6-3.1 0-4 3.4-7.2 7.6-7.2H9.5zm7 6.5c-3.3 0-6 2.2-6 5 0 1.6.9 3 2.3 3.9l-.5 1.9 2.2-1.1c.6.2 1.3.3 2 .3 3.3 0 6-2.2 6-5s-2.7-5-6-5z"/></svg>' });
  return list;
}

function toggleChannelChooser(show) {
  const c = document.getElementById('support-channels');
  if (!c) return;
  const willShow = show === undefined ? c.classList.contains('hidden') : !!show;
  c.classList.toggle('hidden', !willShow);
}

function openWebsiteChat() {
  toggleChannelChooser(false);
  toggleSupport(true);
}

function copyWeChatId(id, btn) {
  const done = () => { if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy ID'; }, 1500); } else toast('WeChat ID copied'); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(id).then(done).catch(() => toast('WeChat ID: ' + id));
    else { const t = document.createElement('textarea'); t.value = id; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); }
  } catch (_) { toast('WeChat ID: ' + id); }
}

function renderChannelChooser() {
  const old = document.getElementById('support-channels');
  if (old) old.remove();
  const channels = supportChannelList();
  const rows = channels.map((ch) => {
    if (ch.id === 'wechat') {
      return `
      <div class="flex items-center gap-3 w-full px-4 py-3 rounded-xl border border-[#1d263e] bg-[#0d1120]">
        <span class="w-9 h-9 rounded-full text-white flex items-center justify-center shrink-0" style="background:${ch.color}">${ch.icon}</span>
        <span class="flex-1 min-w-0 text-left">
          <span class="block text-sm font-bold text-gray-100">${esc(ch.label)}</span>
          <span class="block text-xs text-gray-500 truncate">ID: ${esc(ch.wechatId)}</span>
        </span>
        <button onclick="copyWeChatId('${esc(ch.wechatId).replace(/'/g, "\\'")}', this)" class="px-3 py-1.5 rounded-lg text-xs font-bold text-white shrink-0" style="background:${ch.color}">Copy ID</button>
      </div>`;
    }
    return `
    <a href="${esc(ch.url)}" target="_blank" rel="noopener" class="flex items-center gap-3 w-full px-4 py-3 rounded-xl border border-[#1d263e] bg-[#0d1120] hover:bg-[#1b2338] transition">
      <span class="w-9 h-9 rounded-full text-white flex items-center justify-center shrink-0" style="background:${ch.color}">${ch.icon}</span>
      <span class="flex-1 text-left text-sm font-bold text-gray-100">${esc(ch.label)}</span>
      <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
    </a>`;
  }).join('');
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <div id="support-channels" class="hidden fixed z-50 bottom-40 md:bottom-24 right-5 w-[calc(100vw-2.5rem)] max-w-[320px] bg-[#151b2e] rounded-2xl shadow-2xl border border-[#1d263e] overflow-hidden">
    <div class="px-5 py-4 border-b border-[#1d263e] flex items-center justify-between">
      <div>
        <div class="font-bold text-sm">How would you like to chat?</div>
        <div class="text-xs text-gray-400 mt-0.5">Pick a channel below</div>
      </div>
      <button onclick="toggleChannelChooser(false)" class="p-1.5 hover:bg-[#1b2338] rounded-lg text-gray-400" aria-label="Close">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="p-3 space-y-2">
      <button onclick="openWebsiteChat()" class="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-white font-bold text-sm hover:opacity-90 active:scale-[0.99] transition" style="background:#f97316">
        <span class="w-9 h-9 rounded-full bg-[#151b2e]/20 flex items-center justify-center shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>
        </span>
        <span class="flex-1 text-left">Chat on website</span>
        <svg class="w-4 h-4 text-white/70" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      </button>
      ${rows}
    </div>
  </div>`;
  document.body.appendChild(wrap);
  document.addEventListener('click', (e) => {
    const c = document.getElementById('support-channels');
    const b = document.getElementById('support-btn');
    if (c && !c.classList.contains('hidden') && !c.contains(e.target) && b && !b.contains(e.target)) toggleChannelChooser(false);
  });
}

function onSupportBtnClick() {
  if (supportChannelList().length) toggleChannelChooser();
  else toggleSupport(true);
}

function toggleSupport(open) {
  supportState.open = open === undefined ? !supportState.open : !!open;
  const panel = document.getElementById('support-panel');
  const btn = document.getElementById('support-btn');
  if (!panel || !btn) return;
  panel.classList.toggle('hidden', !supportState.open);
  btn.classList.toggle('hidden', supportState.open);
  if (supportState.open) toggleChannelChooser(false);
  if (supportState.open) {
    if (!supportState.threadId) supportStart();
    supportState.pollTimer = setInterval(supportPoll, 4000);
    setTimeout(() => { const i = document.getElementById('support-input'); if (i) i.focus(); }, 100);
  } else {
    if (supportState.pollTimer) clearInterval(supportState.pollTimer);
    supportState.pollTimer = null;
  }
}

function initSupportWidget() {
  if (document.getElementById('support-btn')) return;
  if (/\/admin\.html/.test(location.pathname)) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
  <button id="support-btn" aria-label="Chat with support"
    class="fixed bottom-24 md:bottom-5 right-5 z-50 w-14 h-14 rounded-full text-white shadow-xl hover:scale-105 active:scale-95 transition flex items-center justify-center"
    style="background:#f97316;box-shadow:0 10px 25px #f9731655">
    <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"/></svg>
  </button>
  <div id="support-panel" class="hidden fixed z-50 bottom-24 md:bottom-5 right-5 w-[calc(100vw-2.5rem)] max-w-[380px] h-[520px] max-h-[calc(100vh-7rem)] bg-[#151b2e] rounded-3xl shadow-2xl border border-[#1d263e] flex flex-col overflow-hidden">
    <div class="text-white px-5 py-4 flex items-center justify-between shrink-0" style="background:#0a1f44">
      <div>
        <div class="font-bold">Support chat</div>
        <div id="support-status"><span class="text-xs text-gray-400">Typically replies within a few hours</span></div>
      </div>
      <button onclick="toggleSupport(false)" class="p-2 hover:bg-[#151b2e]/10 rounded-lg" aria-label="Close chat">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div id="support-messages" class="flex-1 overflow-y-auto px-4 py-4">
      <div data-empty class="text-center text-sm text-gray-400 py-8">Loading…</div>
    </div>
    <div class="p-3 border-t border-[#1d263e] shrink-0">
      <div id="support-preview" class="hidden mb-2 relative inline-block">
        <img id="support-preview-img" class="w-20 h-20 rounded-xl object-cover border border-[#26304a]" alt="Attachment preview">
        <button id="support-preview-x" aria-label="Remove attachment"
          class="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-gray-800 text-white text-xs flex items-center justify-center">✕</button>
      </div>
      <div class="flex gap-2">
        <button id="support-attach" aria-label="Attach image"
          class="w-12 h-12 rounded-xl border border-[#26304a] text-gray-500 hover:bg-[#0d1120] active:scale-95 transition flex items-center justify-center shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20 12.5"/></svg>
        </button>
        <input id="support-file" type="file" accept="image/*" class="hidden">
        <input id="support-input" maxlength="2000" placeholder="Type your message…" autocomplete="off"
          class="flex-1 text-sm border border-[#26304a] rounded-xl px-4 py-3 bg-[#0d1120] focus:bg-[#151b2e] focus:outline-none focus:ring-2 focus:ring-brand-500/40">
        <button id="support-send" aria-label="Send"
          class="w-12 h-12 rounded-xl text-white hover:opacity-90 active:scale-95 transition flex items-center justify-center shrink-0" style="background:#f97316">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
        </button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(wrap);
  renderChannelChooser();
  document.getElementById('support-btn').addEventListener('click', onSupportBtnClick);
  document.getElementById('support-send').addEventListener('click', supportSend);
  document.getElementById('support-attach').addEventListener('click', () => document.getElementById('support-file').click());
  document.getElementById('support-file').addEventListener('change', (e) => supportHandleFile(e.target.files[0]));
  document.getElementById('support-preview-x').addEventListener('click', supportClearAttachment);
  document.getElementById('support-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); supportSend(); }
  });
  if (!(window.MDS && window.MDS.user)) {
    try {
      if (!localStorage.getItem('mds_support_name')) {
        setTimeout(() => {
          const n = prompt('What should we call you in the chat? (optional)');
          if (n && n.trim()) { try { localStorage.setItem('mds_support_name', n.trim().slice(0, 80)); } catch (_) {} }
        }, 1200);
      }
    } catch (_) {}
  }
}
