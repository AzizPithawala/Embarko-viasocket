'use strict';

const path = require('node:path');
const express = require('express');
const { config } = require('./src/config');
const db = require('./src/db');

function createApp() {
  db.open();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use('/api', require('./src/routes/api'));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });
  return app;
}

if (require.main === module) {
  createApp().listen(config.port, '0.0.0.0', () => {
    console.log(`OrderPilot listening on :${config.port} (viaSocket mode: ${config.viasocket.mode})`);
  });
}

module.exports = { createApp };
