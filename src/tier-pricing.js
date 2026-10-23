// Tier pricing for the 3-role system: admin, silver, customer.
// (Gold tier removed 2026-10-07; all gold accounts migrated to silver.)
// Silver is the reseller tier, customer pays regular.
// Fallback: silver with no price set uses the regular price.
const USD_RATE = 103;
const toUsd = (inr) => Math.round((Number(inr) / USD_RATE) * 100) / 100;

function tierOf(role) {
  if (role === 'admin' || role === 'silver') return 'silver';
  return 'customer';
}

// Unit price of a product/variant row for a tier in the requested currency.
// USD: use the admin-set USD tier price when present, else the base USD price,
// else convert the tier's INR price at the fixed store rate.
function priceInCurrency(row, tier, currency) {
  const t = tier === 'silver' ? 'silver' : 'customer';
  const inr = t === 'silver'
    ? row.price_silver ?? row.price_regular
    : row.price_regular;
  if (currency !== 'USD') return Number(inr);
  const usd = t === 'silver' ? row.price_usd_silver : null;
  if (usd != null) return Number(usd);
  if (row.price_usd != null) return Number(row.price_usd);
  return toUsd(inr);
}

module.exports = { tierOf, priceInCurrency, toUsd, USD_RATE };
