"use strict";

const retiredWrites = new Set([
  "/api/start", "/api/start-all", "/api/account/create", "/api/config",
  "/api/v4/accounts", "/api/v4/config", "/api/v4/shadow", "/api/v4/migrate",
  "/api/compound/start", "/api/compound/create", "/api/compound/config",
  "/api/trend-only/config", "/api/trend-only/short-term/config", "/api/trend-only/confirm"
]);
function retiredRoute(method, pathname) {
  return pathname.startsWith("/api/v5/") || method === "POST" && retiredWrites.has(pathname);
}
function hasTrendWork(state = {}) {
  if (state.position || state.pendingOrder) return true;
  return Object.values(state.shortTermBooks || {}).some(book => book.position || book.pendingOrder) ||
    Object.values(state.shadowBooks || {}).some(group => Object.values(group.books || {}).some(book => book.position || book.pendingOrder));
}
module.exports = {retiredRoute, hasTrendWork};
