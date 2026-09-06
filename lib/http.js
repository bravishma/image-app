'use strict';
/** Shared JSON responder for the auth endpoints. */
function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}
module.exports = { json };
