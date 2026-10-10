'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Local secrets live in .env (gitignored). Existing env vars win; tests never read it.
const envFile = path.join(__dirname, '..', '.env');
if (!process.env.NODE_TEST_CONTEXT && fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

const config = {
  port: Number(env.PORT || 3000),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
  approvalTtlMs: Number(env.APPROVAL_TTL_MS || 120_000),
  viasocket: {
    mode: env.VIASOCKET_MODE === 'live' ? 'live' : 'simulated',
    orgId: env.VIASOCKET_ORG_ID || '',
    projectId: env.VIASOCKET_PROJECT_ID || '',
    accessKey: env.VIASOCKET_EMBED_SECRET || env.VIASOCKET_ACCESS_KEY || '',
    webhookSecret: env.VIASOCKET_WEBHOOK_SECRET || '',
    embedScriptUrl: env.VIASOCKET_EMBED_SCRIPT_URL || 'https://embed.viasocket.com/prod-embedcomponent.js',
    retryAirtableUrl: env.VIASOCKET_RETRY_AIRTABLE_URL || '',
    retrySlackUrl: env.VIASOCKET_RETRY_SLACK_URL || '',
  },
};

config.viasocket.embedConfigured = !!(config.viasocket.orgId && config.viasocket.projectId && config.viasocket.accessKey);

module.exports = { config };
