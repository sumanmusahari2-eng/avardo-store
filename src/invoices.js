// Invoice system: sequential invoice numbers, seller settings, payload assembly.
// Invoices are issued lazily on first view, only for paid/delivered orders.
// Invoice numbers look like INV-2026-000042 (prefix + year + zero-padded id).
// NOTE: these are purchase receipts, not GST tax invoices — no tax lines are rendered.
'use strict';

const ELIGIBLE_STATUSES = new Set(['paid', 'delivered']);

async function getSetting(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value) : '';
  } catch (e) {
    return '';
  }
}

async function getSellerInfo(db) {
  const [prefix, name, address, phone, email, notes, siteName, supportEmail] = await Promise.all([
    getSetting(db, 'invoice_prefix'),
    getSetting(db, 'invoice_seller_name'),
    getSetting(db, 'invoice_seller_address'),
    getSetting(db, 'invoice_seller_phone'),
    getSetting(db, 'invoice_seller_email'),
    getSetting(db, 'invoice_notes'),
    getSetting(db, 'site_name'),
    getSetting(db, 'support_email'),
  ]);
  return {
    prefix: (prefix || 'INV').trim() || 'INV',
    name: (name || '').trim() || (siteName || '').trim() || 'Store',
    address: (address || '').trim(),
    phone: (phone || '').trim(),
    email: (email || '').trim() || (supportEmail || '').trim(),
    notes: (notes || '').trim() || 'Thank you for your purchase.',
  };
}

function formatInvoiceNo(prefix, id) {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(id).padStart(6, '0')}`;
}

// Returns the invoice row for an order, creating it if needed.
// Throws {statusCode} when the order is not eligible.
async function getOrCreateInvoice(db, order) {
  if (!ELIGIBLE_STATUSES.has(String(order.status))) {
    const err = new Error('Invoice is available once the order is paid.');
    err.statusCode = 409;
    throw err;
  }
  let row = await db.prepare('SELECT id, invoice_no, created_at FROM invoices WHERE order_id = ?').get(order.id);
  if (row) return row;
  const seller = await getSellerInfo(db);
  const ins = await db.prepare(
    'INSERT INTO invoices (order_id, invoice_no) VALUES (?, ?) ON CONFLICT (order_id) DO NOTHING'
  ).run(order.id, 'PENDING');
  if (ins && ins.lastInsertRowid) {
    const invoiceNo = formatInvoiceNo(seller.prefix, ins.lastInsertRowid);
    await db.prepare('UPDATE invoices SET invoice_no = ? WHERE id = ?').run(invoiceNo, ins.lastInsertRowid);
    row = await db.prepare('SELECT id, invoice_no, created_at FROM invoices WHERE id = ?').get(ins.lastInsertRowid);
  } else {
    // Lost a race with another request — read the winner's row.
    row = await db.prepare('SELECT id, invoice_no, created_at FROM invoices WHERE order_id = ?').get(order.id);
  }
  if (!row) {
    const err = new Error('Could not generate invoice.');
    err.statusCode = 500;
    throw err;
  }
  return row;
}

// Full payload for rendering the invoice document.
async function buildInvoicePayload(db, orderId) {
  const order = await db.prepare(
    'SELECT o.*, u.name AS user_name, u.email AS user_email FROM orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?'
  ).get(orderId);
  if (!order) {
    const err = new Error('Order not found.');
    err.statusCode = 404;
    throw err;
  }
  const invoice = await getOrCreateInvoice(db, order);
  let rawItems = [];
  try { rawItems = JSON.parse(order.items) || []; } catch (e) { /* keep empty */ }
  const seller = await getSellerInfo(db);
  const items = rawItems.map((it) => ({
    name: it.name || 'Item',
    variant: it.variant_name || '',
    qty: Number(it.qty) || 1,
    unit_price: Number(it.unit_price) || 0,
    line_total: Math.round((Number(it.qty) || 1) * (Number(it.unit_price) || 0) * 100) / 100,
  }));
  return {
    invoice_no: invoice.invoice_no,
    issued_at: invoice.created_at,
    order_id: order.id,
    order_date: order.created_at,
    status: order.status,
    currency: order.currency || 'INR',
    seller,
    buyer: { name: order.user_name || '', email: order.user_email || '' },
    items,
    subtotal: order.subtotal != null ? Number(order.subtotal) : null,
    discount: Number(order.discount) || 0,
    coupon_code: order.coupon_code || null,
    wallet_applied: Number(order.wallet_applied) || 0,
    total: Number(order.total) || 0,
    payment_note: order.payment_note || '',
  };
}

module.exports = { getSellerInfo, getOrCreateInvoice, buildInvoicePayload, ELIGIBLE_STATUSES };
