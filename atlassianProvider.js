// Atlassian provider abstraction.
// Preferred path: OAuth (USE_OAUTH=true) using 3LO PKCE tokens stored locally.
// Fallback: If USE_OAUTH is not enabled but legacy env vars JIRA_EMAIL + JIRA_API_TOKEN are present,
// we create a temporary basic-auth client (with a deprecation warning). This restores backward
// compatibility for users who haven't finished migrating yet while keeping OAuth as the default.
// To fully disable basic auth, set DISABLE_BASIC_AUTH_FALLBACK=true.

const axios = require('axios');
const { getValidAccessToken, loadTokens } = require('./auth/atlassianOAuth');

let jiraBaseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/+$/,'');

async function getJiraApi() {
  // Primary: OAuth
  if (process.env.USE_OAUTH === 'true') {
    const access = await getValidAccessToken();
    if (!access) {
      throw new Error('No valid OAuth access token. Visit /auth/atlassian/login to authenticate.');
    }
    return axios.create({
      baseURL: jiraBaseUrl,
      headers: {
        Authorization: `Bearer ${access}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
  }

  // Optional fallback (temporary) to ease migration if explicitly allowed or not disabled.
  if (process.env.DISABLE_BASIC_AUTH_FALLBACK === 'true') {
    throw new Error('OAuth required. Set USE_OAUTH=true and configure ATLASSIAN_CLIENT_ID & ATLASSIAN_REDIRECT_URI.');
  }

  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (email && token) {
    console.warn('[auth] ⚠️ Using BASIC auth fallback (enable OAuth with USE_OAUTH=true for long-term support)');
    return axios.create({
      baseURL: jiraBaseUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
  }

  throw new Error('No authentication configured. Either enable OAuth (USE_OAUTH=true + ATLASSIAN_CLIENT_ID + ATLASSIAN_REDIRECT_URI) or provide JIRA_EMAIL & JIRA_API_TOKEN for temporary basic auth.');
}

function oauthStatus() {
  const tokens = loadTokens();
  if (!tokens) return { authenticated: false };
  const { expires_in, obtained_at, scope } = tokens;
  const expiresAt = obtained_at + (expires_in * 1000);
  return {
    authenticated: true,
    scopes: scope ? scope.split(' ') : [],
    expiresAt,
    expiresInMs: expiresAt - Date.now()
  };
}

module.exports = {
  getJiraApi,
  oauthStatus
};
