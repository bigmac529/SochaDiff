"use strict";

const express = require("express");
const { loadInventory, saveInventory } = require("./store");
const { priceFor } = require("./pricing");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static("public"));

function requireSku(req, res, next) {
  const sku = String(req.params.sku || "").trim();
  if (!sku) {
    res.status(400).json({ error: "Missing SKU" });
    return;
  }
  req.sku = sku.toUpperCase();
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get("/api/items", async (req, res) => {
  const items = await loadInventory();
  res.json(items);
});

app.get("/api/items/:sku", requireSku, async (req, res) => {
  const items = await loadInventory();
  const item = items.find((i) => i.sku === req.sku);
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ ...item, price: priceFor(item) });
});

app.post("/api/items/:sku/stock", requireSku, async (req, res) => {
  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta)) {
    res.status(400).json({ error: "delta must be a number" });
    return;
  }
  const items = await loadInventory();
  const item = items.find((i) => i.sku === req.sku);
  if (!item) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  item.stock += delta;
  await saveInventory(items);
  res.json(item);
});

app.delete("/api/items/:sku", requireSku, async (req, res) => {
  const items = await loadInventory();
  const next = items.filter((i) => i.sku !== req.sku);
  await saveInventory(next);
  res.status(204).end();
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal error" });
});

app.listen(PORT, () => {
  console.log(`Inventory service listening on ${PORT}`);
});
