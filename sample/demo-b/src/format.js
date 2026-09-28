"use strict";

function formatMoney(value) {
  return "$" + value.toFixed(2);
}


function formatSku(sku) {
  return sku.replace(/\s+/g, "-").toUpperCase();
}

module.exports = { formatMoney, formatSku };
