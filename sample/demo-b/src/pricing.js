"use strict";

const TAX_RATE = 0.0825;
const MARKUP = { default: 1.4, clearance: 1.1 };

function priceFor(item) {
  const markup = MARKUP[item.tier] || MARKUP.default;
  const base = item.cost * markup;
  return Math.round(base * (1 + TAX_RATE) * 100) / 100;
}

module.exports = { priceFor, TAX_RATE, MARKUP };
