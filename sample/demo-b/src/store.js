"use strict";

const fs = require("fs/promises");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "inventory.json");

async function loadInventory() {
  return JSON.parse(await fs.readFile(FILE, "utf8"));
}

async function saveInventory(items) {
  await fs.writeFile(FILE, JSON.stringify(items, null, 2));
}

module.exports = { loadInventory, saveInventory };
