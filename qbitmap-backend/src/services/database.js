// Proxy: redirects to modular db/index.js
// All 18+ route files import this path — keeping it avoids mass path changes
module.exports = require('./db');
