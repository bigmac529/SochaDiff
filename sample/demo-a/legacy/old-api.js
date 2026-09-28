// Deprecated v1 endpoints, removed in v2.
module.exports = function legacy(app) {
  app.get("/v1/items", (req, res) => res.redirect(301, "/api/items"));
};
