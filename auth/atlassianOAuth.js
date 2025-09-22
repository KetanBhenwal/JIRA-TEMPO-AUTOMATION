// Atlassian OAuth 2.0 (3LO with PKCE) helper
// Docs: https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
// This module implements a lightweight PKCE flow for local development.
// It stores tokens in .atlassian-tokens.json (unencrypted) – advise securing the file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const TOKEN_FILE = path.join(process.cwd(), '.atlassian-tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('[oauth] Failed to load token file:', e.message);
  }
  return null;
}

function saveTokens(tokens) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  } catch (e) {
    console.warn('[oauth] Failed to save token file:', e.message);
  }
}

function isExpired(tokens) {
  if (!tokens || !tokens.obtained_at || !tokens.expires_in) return true;
  const expiry = tokens.obtained_at + (tokens.expires_in - 60) * 1000; // refresh 1m early
  return Date.now() >= expiry;
}

function generateVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateChallenge(verifier) {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function getConfig() {
  const {
    ATLASSIAN_CLIENT_ID,
    ATLASSIAN_REDIRECT_URI,
    ATLASSIAN_SCOPES = 'read:jira-user read:jira-work write:jira-work offline_access'
  } = process.env;
  if (!ATLASSIAN_CLIENT_ID || !ATLASSIAN_REDIRECT_URI) {
    throw new Error('Missing ATLASSIAN_CLIENT_ID or ATLASSIAN_REDIRECT_URI');
  }
  return { ATLASSIAN_CLIENT_ID, ATLASSIAN_REDIRECT_URI, ATLASSIAN_SCOPES };
}

function buildAuthUrl(state) {
  const { ATLASSIAN_CLIENT_ID, ATLASSIAN_REDIRECT_URI, ATLASSIAN_SCOPES } = getConfig();
  const verifier = generateVerifier();
  const challenge = generateChallenge(verifier);
  const url = new URL('https://auth.atlassian.com/authorize');
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', ATLASSIAN_CLIENT_ID);
  url.searchParams.set('scope', ATLASSIAN_SCOPES);
  url.searchParams.set('redirect_uri', ATLASSIAN_REDIRECT_URI);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Store transient verifier in memory map keyed by state (fallback simple global)
  pkceStore[state] = { verifier, created: Date.now() };
  return { url: url.toString(), verifier }; // verifier kept for debug only
}

const pkceStore = {}; // state -> { verifier }

async function exchangeCode(code, state) {
  const { ATLASSIAN_CLIENT_ID, ATLASSIAN_REDIRECT_URI } = getConfig();
  const pk = pkceStore[state];
  if (!pk) throw new Error('Invalid or expired state (PKCE verifier missing)');
  const body = {
    grant_type: 'authorization_code',
    client_id: ATLASSIAN_CLIENT_ID,
    code,
    redirect_uri: ATLASSIAN_REDIRECT_URI,
    code_verifier: pk.verifier
  };
  const resp = await axios.post('https://auth.atlassian.com/oauth/token', body, {
    headers: { 'Content-Type': 'application/json' }
  });
  const tokens = { ...resp.data, obtained_at: Date.now() };
  saveTokens(tokens);
  cleanState(state);
  return tokens;
}

async function refreshTokens() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('No refresh token stored');
  const { ATLASSIAN_CLIENT_ID } = getConfig();
  const body = {
    grant_type: 'refresh_token',
    client_id: ATLASSIAN_CLIENT_ID,
    refresh_token: tokens.refresh_token
  };
  const resp = await axios.post('https://auth.atlassian.com/oauth/token', body, {
    headers: { 'Content-Type': 'application/json' }
  });
  const updated = { ...resp.data, obtained_at: Date.now() };
  saveTokens(updated);
  return updated;
}

function cleanState(state) {
  try { delete pkceStore[state]; } catch(_) {}
}

async function getValidAccessToken() {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (isExpired(tokens)) {
    try {
      tokens = await refreshTokens();
    } catch (e) {
      console.warn('[oauth] Refresh failed:', e.message);
      return null;
    }
  }
  return tokens.access_token;
}

module.exports = {
  buildAuthUrl,
  exchangeCode,
  getValidAccessToken,
  loadTokens,
  isExpired,
  refreshTokens
};
