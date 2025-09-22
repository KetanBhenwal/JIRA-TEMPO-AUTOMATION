// Tempo provider abstraction (skeleton) for future OAuth / proxy token management.
// Currently still relies on TEMPO_API_TOKEN. Roadmap:
// 1. Support exchanging Atlassian user identity for a short-lived Tempo token via custom proxy.
// 2. Add OAuth client credentials flow if/when Tempo exposes it for your account.
// 3. Centralize rate limiting & metrics similar to Jira provider.

const axios = require('axios');

let tempoBaseUrl = (process.env.TEMPO_BASE_URL || '').replace(/\/$/, '');

function getTempoApi() {
  const token = process.env.TEMPO_API_TOKEN;
  return axios.create({
    baseURL: tempoBaseUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });
}

module.exports = { getTempoApi };
