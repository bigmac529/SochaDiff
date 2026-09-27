"use strict";

const TAX_RATE = 0.07;

function priceFor(item) {
  const base = item.cost * 1.4;
  return Math.round(base * (1 + TAX_RATE) * 100) / 100;
}

module.exports = { priceFor, TAX_RATE };
