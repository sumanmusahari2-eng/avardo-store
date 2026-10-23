// Runs everything that must happen once an order becomes paid, no matter how
// it got paid (gateway callback, admin mark-paid, or wallet covering the full
// total). Fire-and-forget by design: fulfilment records its own outcome on the
// order and must never break the payment flow, so callers attach .catch().
const { fulfilBusanOrder } = require('./busan-fulfil');
const { assignVoucherCodes } = require('./wallet');

function handleOrderPaid(db, orderId) {
  fulfilBusanOrder(db, orderId).catch((e) =>
    console.error('[busan]', e && e.message)
  );
  assignVoucherCodes(db, orderId).catch((e) =>
    console.error('[vouchers]', e && e.message)
  );
}

module.exports = { handleOrderPaid };
