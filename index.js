const axios = require('axios');
const { getJiraApi } = require('./atlassianProvider');
const cron = require('node-cron');

// Configuration
require('dotenv').config();
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const TEMPO_BASE_URL = process.env.TEMPO_BASE_URL;
// Legacy JIRA basic auth & direct Tempo token removed – OAuth required
const TEMPO_API_TOKEN = process.env.TEMPO_API_TOKEN; // optional; if missing we will fall back to Jira native worklog API
const TEMPO_ACCOUNT_ID = process.env.TEMPO_ACCOUNT_ID;

console.log('Configuration loaded:');
console.log('- JIRA Base URL:', JIRA_BASE_URL);
console.log('- TEMPO Base URL:', TEMPO_BASE_URL);
console.log('- USE_OAUTH:', process.env.USE_OAUTH === 'true' ? 'Enabled' : 'Disabled (REQUIRED)');
console.log('- TEMPO API Token:', TEMPO_API_TOKEN ? '✅ Present (Tempo logging)' : '⌛ Missing (will use Jira /worklog fallback)');
console.log('- TEMPO Account ID:', TEMPO_ACCOUNT_ID);

// Jira API accessor returns fresh client per call (OAuth aware)
async function jiraClient() {
  return await getJiraApi();
}

let tempoApi = null;
if (TEMPO_API_TOKEN) {
  tempoApi = axios.create({
    baseURL: TEMPO_BASE_URL,
    headers: {
      Authorization: `Bearer ${TEMPO_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// Fetch JIRA issues assigned to the user using JQL (recommended for automation)
async function fetchJiraIssues() {
  try {
    console.log('Fetching JIRA issues...');
  const jira = await jiraClient();
  const response = await jira.post('/rest/api/3/search/jql', {
      jql: 'assignee = currentUser() AND statusCategory != Done',
      fields: ['summary','key']
    });
    console.log(`Fetched ${response.data.issues?.length || 0} JIRA issues`);
    return response.data.issues || [];
  } catch (error) {
    console.error('Error fetching JIRA issues:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    return [];
  }
}

// Fetch JIRA issues where the user was mentioned in comments
async function fetchMentionedIssues() {
  try {
    console.log('Fetching JIRA issues where user was mentioned in comments...');
  const jira = await jiraClient();
  const response = await jira.post('/rest/api/3/search/jql', {
      jql: 'comment ~ currentUser() AND assignee != currentUser() AND statusCategory != Done',
      fields: ['summary','key','status']
    });
    console.log(`Fetched ${response.data.issues?.length || 0} issues where user was mentioned in comments`);
    return response.data.issues || [];
  } catch (error) {
    console.error('Error fetching mentioned issues:');
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    return [];
  }
}

// Get issue ID from issue key
async function getIssueId(issueKey) {
  try {
    console.log(`Fetching issue ID for ${issueKey}...`);
  const jira = await jiraClient();
  const response = await jira.get(`/rest/api/3/issue/${issueKey}`);
    console.log(`Found issue ID: ${response.data.id}`);
    return response.data.id;
  } catch (error) {
    console.error(`Error fetching issue ID for ${issueKey}:`, error.response?.data || error.message);
    return null;
  }
}

// Updated logTimeInTempo function to align with Tempo API v4 documentation
async function logTimeInTempo(issueKey, timeSpentSeconds, description) {
  try {
    // Get the issue ID first
    const issueId = await getIssueId(issueKey);
    
    if (!issueId) {
      console.error(`\n❌ Could not find issue ID for ${issueKey}`);
      return null;
    }
    
    console.log(`Logging time for issue ${issueKey} (ID: ${issueId}): ${timeSpentSeconds} seconds`);
    console.log(`- Description: ${description}`);
    console.log(`- Author Account ID: ${TEMPO_ACCOUNT_ID}`);
    
    const payload = {
      issueId,
      timeSpentSeconds,
      description,
      startDate: new Date().toISOString().split('T')[0], // Current date
      startTime: '09:00:00', // Default start time
      authorAccountId: TEMPO_ACCOUNT_ID, // From .env
    };
    
    console.log('Request payload:', JSON.stringify(payload, null, 2));
    
    if (tempoApi) {
      const response = await tempoApi.post('/worklogs', payload);
      console.log(`Success! Logged time (Tempo) for issue ${issueKey}:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } else {
      // Jira fallback
      const jira = await jiraClient();
      const wlResp = await jira.post(`/rest/api/3/issue/${issueKey}/worklog`, {
        comment: description,
        started: new Date().toISOString(),
        timeSpentSeconds
      });
      console.log(`Success! Logged time (Jira fallback) for issue ${issueKey}:`, JSON.stringify(wlResp.data, null, 2));
      return { ...wlResp.data, fallback: 'jira-worklog' };
    }
  } catch (error) {
    console.error(`Error logging time for issue ${issueKey}:`);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.error('No response received:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    return null;
  }
}

// Main function to automate Tempo filling
async function automateTempoFilling() {
  console.log('Starting JIRA Tempo automation...');
  const issues = await fetchJiraIssues(); // Use the correct JQL search endpoint

  for (const issue of issues) {
    const issueKey = issue.key;
    const description = issue.fields.summary;
    const timeSpentSeconds = 2; // Example: 1 hour per issue

    await logTimeInTempo(issueKey, timeSpentSeconds, description);
  }
  console.log('JIRA Tempo automation completed.');
}

// Run immediately when the script starts
console.log('Running automation immediately for testing...');
automateTempoFilling();

// Schedule the task to run every day at 6 PM
cron.schedule('0 18 * * *', () => {
  automateTempoFilling();
});

console.log('JIRA Tempo automation script is running...');

// Fetch issues using the JIRA Issue Picker endpoint (for UI-like search, not JQL)
// Pass a search string (e.g., part of an issue key or summary)
async function fetchJiraIssuePicker(searchString) {
  try {
  const jira = await jiraClient();
  const response = await jira.get('/rest/api/3/issue/picker', {
      params: { query: searchString },
      headers: {
        Accept: 'application/json',
      },
    });
    console.log(`Issue Picker Response: ${response.status} ${response.statusText}`);
    console.log(response.data);
    return response.data;
  } catch (err) {
    console.error('Error fetching from Issue Picker:', err.response?.data || err.message);
    return null;
  }
}

// Export functions for use in other modules
module.exports = {
  fetchJiraIssues,
  fetchMentionedIssues,
  getIssueId,
  logTimeInTempo,
  automateTempoFilling,
  fetchJiraIssuePicker
};
