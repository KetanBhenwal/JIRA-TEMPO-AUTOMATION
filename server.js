require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const AITimeTrackingAgent = require('./ai-agent');

// Configuration (normalize trailing slash to avoid double // in requests)
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || '').replace(/\/+$/,'');
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const TEMPO_BASE_URL = process.env.TEMPO_BASE_URL;
const TEMPO_API_TOKEN = process.env.TEMPO_API_TOKEN;
const TEMPO_ACCOUNT_ID = process.env.TEMPO_ACCOUNT_ID;

// Helper function to get all dates between start and end dates (inclusive)
function getDatesBetween(startDate, endDate) {
  const dates = [];
  const currentDate = new Date(startDate);
  const lastDate = new Date(endDate);
  
  // Add dates until we reach the end date
  while (currentDate <= lastDate) {
    dates.push(currentDate.toISOString().split('T')[0]);
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return dates;
}

// Create API clients
const jiraApi = axios.create({
  baseURL: JIRA_BASE_URL,
  headers: {
    Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

// Optional low-noise interceptor to surface auth failures once
let _jiraAuthWarned = false;
jiraApi.interceptors.response.use(r=>r, err => {
  if (err.response && err.response.status === 401 && !_jiraAuthWarned) {
    _jiraAuthWarned = true;
    console.warn('[JIRA AUTH] 401 Unauthorized from JIRA. Check JIRA_EMAIL, JIRA_API_TOKEN, and that the token has not been revoked.');
  }
  return Promise.reject(err);
});

const tempoApi = axios.create({
  baseURL: TEMPO_BASE_URL,
  headers: {
    Authorization: `Bearer ${TEMPO_API_TOKEN}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize AI Agent
const aiAgent = new AITimeTrackingAgent();
let isAiAgentRunning = false;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// API Routes

// JIRA current user info
app.get('/api/jira/me', async (req, res) => {
  try {
    const userResp = await jiraApi.get('/rest/api/3/myself');
    // Try fetching groups (separate endpoint) - may require proper scopes
    let groups = [];
    try {
      const groupsResp = await jiraApi.get('/rest/api/3/group/browse', { params: { maxResults: 50 } });
      groups = (groupsResp.data?.groups || []).map(g => g.name).slice(0,50);
    } catch (e) {
      // Non-fatal; log silently if verbose
      if (process.env.AI_AGENT_VERBOSE_LOG === 'true') {
        console.warn('[jira:groups] fetch failed:', e.response?.status || e.message);
      }
    }
    const d = userResp.data || {};
    const safe = {
      accountId: d.accountId || d.account?.accountId || null,
      displayName: d.displayName || null,
      emailAddress: d.emailAddress || null, // may be null if privacy settings restrict
      timeZone: d.timeZone || null,
      locale: d.locale || null,
      groups,
      rawAvatarUrls: d.avatarUrls || null
    };
    res.json(safe);
  } catch (error) {
    const status = error.response?.status || 500;
    const detailsRaw = error.response?.data?.errorMessages || error.response?.data || undefined;
    const details = typeof detailsRaw === 'string' ? detailsRaw : detailsRaw?.errorMessages || detailsRaw;
    if (process.env.AI_AGENT_VERBOSE_LOG === 'true') {
      console.warn('[jira:me] failure', { status, details: detailsRaw });
    }
    res.status(status).json({
      error: 'Failed to fetch JIRA user',
      status,
      message: error.message,
      details,
      hint: status === 401 ? 'Verify JIRA_BASE_URL (no trailing slash), JIRA_EMAIL, JIRA_API_TOKEN. Create new token at id.atlassian.com if uncertain.' : undefined
    });
  }
});

// Simple health/status probe
app.get('/api/health', async (req, res) => {
  const started = !!aiAgent;
  let jiraAuth = 'unknown';
  if (process.env.DISABLE_JIRA_HEALTH !== 'true') {
    try {
      await jiraApi.get('/rest/api/3/myself');
      jiraAuth = 'ok';
    } catch (e) {
      jiraAuth = 'fail';
    }
  }
  res.json({
    status: 'ok',
    serverPort: PORT,
    jiraBase: JIRA_BASE_URL,
    jiraAuth,
    aiAgentRunning: isAiAgentRunning
  });
});

// AI Agent status & metrics
app.get('/api/ai-agent/status', (req, res) => {
  try {
    if (!isAiAgentRunning) {
      return res.json({ running: false, message: 'AI Agent not started' });
    }
    const status = aiAgent.getStatus();
    res.json({ running: true, ...status });
  } catch (err) {
    console.error('Error getting AI agent status:', err.message);
    res.status(500).json({ error: 'Failed to retrieve status', details: err.message });
  }
});

// Recent activities (sessions) enriched with issue key (meeting sessions mapped to default issue)
app.get('/api/ai-agent/activities', async (req, res) => {
  try {
    if (!isAiAgentRunning) {
      return res.json([]);
    }
    // By default last 1 day unless specified
    const days = parseInt(req.query.days || '1', 10);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions = aiAgent.sessions.filter(s => s.startTime >= cutoff);
    const activities = sessions.map(s => {
      const activityType = aiAgent.detectActivityType(s);
      const isMeeting = activityType.isMeetingActivity;
  const defaultMeetingIssue = (process.env.AI_AGENT_DEFAULT_MEETING_ISSUE || '').trim() || null;
  const issueKey = isMeeting ? defaultMeetingIssue : (s.detectedIssue || null);
      return {
        id: s.id,
        startTime: s.startTime,
        endTime: s.endTime || (s.startTime + s.duration),
        durationMs: s.duration,
        durationFormatted: aiAgent.formatDuration(s.duration),
        issueKey,
        isMeeting,
        meetingType: activityType.meetingType,
        activityLabel: isMeeting ? (activityType.description) : (s.detectedIssue || 'Development'),
        confidence: s.confidence,
        applications: s.applications.slice(0,3),
      };
    });
    // Sort newest first
    activities.sort((a,b) => b.startTime - a.startTime);
    res.json(activities);
  } catch (err) {
    console.error('Error fetching activities:', err);
    res.status(500).json({ error: 'Failed to fetch activities', details: err.message });
  }
});

// Get issues assigned to current user
app.get('/api/issues', async (req, res) => {
  try {
    // Migrated to POST /rest/api/3/search/jql per Atlassian CHANGE-2046
    const response = await jiraApi.post('/rest/api/3/search/jql', {
      jql: 'assignee = currentUser() ORDER BY updated DESC',
      fields: ['id','key','summary','status','updated','timetracking','timespent','timeoriginalestimate','timeestimate'],
      maxResults: 50
    });
    
    const issues = response.data.issues || [];
    
    // Helper function to format time from seconds
    const formatTime = (seconds) => {
      if (!seconds) return null;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    };
    
    // Format issues for frontend
    const formattedIssues = issues.map(issue => {
      const timetracking = issue.fields.timetracking || {};
      return {
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name || 'Unknown',
        updated: issue.fields.updated,
        timeSpent: formatTime(timetracking.timeSpentSeconds || issue.fields.timespent),
        originalEstimate: formatTime(timetracking.originalEstimateSeconds || issue.fields.timeoriginalestimate),
        remainingEstimate: formatTime(timetracking.remainingEstimateSeconds || issue.fields.timeestimate)
      };
    });
    
    res.json(formattedIssues);
  } catch (error) {
    console.error('Error fetching issues:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch issues', 
      details: error.response?.data || error.message
    });
  }
});

// Search for issues by query
app.get('/api/search-issues', async (req, res) => {
  try {
    const { query } = req.query;
    
    if (!query || query.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters long' });
    }
    
    // Check if query looks like a JIRA key (format: ABC-123)
    const isJiraKey = /^[A-Z]+-\d+$/i.test(query.trim());
    
    if (isJiraKey) {
      console.log(`Detected JIRA key pattern: ${query}, attempting direct lookup`);
      try {
        // Try direct lookup first for exact JIRA keys
        const directResponse = await jiraApi.get(`/rest/api/3/issue/${query.trim()}`, {
          params: {
            fields: 'id,key,summary,status,updated,timetracking,timespent,timeoriginalestimate,timeestimate'
          }
        });
        
        // Helper function to format time from seconds
        const formatTime = (seconds) => {
          if (!seconds) return null;
          const hours = Math.floor(seconds / 3600);
          const minutes = Math.floor((seconds % 3600) / 60);
          return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        };
        
        const issue = directResponse.data;
        const timetracking = issue.fields.timetracking || {};
        
        const formattedIssue = {
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name || 'Unknown',
          updated: issue.fields.updated,
          source: 'direct-lookup',
          timeSpent: formatTime(timetracking.timeSpentSeconds || issue.fields.timespent),
          originalEstimate: formatTime(timetracking.originalEstimateSeconds || issue.fields.timeoriginalestimate),
          remainingEstimate: formatTime(timetracking.remainingEstimateSeconds || issue.fields.timeestimate)
        };
        
        console.log(`Direct lookup successful for ${query}`);
        return res.json([formattedIssue]);
      } catch (directError) {
        console.log(`Direct lookup failed for ${query}, falling back to search`);
        // If direct lookup fails, continue to JQL search
      }
    }
    
    // Build JQL query - search in summary and description using text search
    const jqlQuery = `(summary ~ "${query}" OR description ~ "${query}") ORDER BY updated DESC`;
    
    const response = await jiraApi.post('/rest/api/3/search/jql', {
      jql: jqlQuery,
      fields: ['id','key','summary','status','updated','timetracking','timespent','timeoriginalestimate','timeestimate'],
      maxResults: 50
    });
    
    const issues = response.data.issues || [];
    
    // Helper function to format time from seconds
    const formatTime = (seconds) => {
      if (!seconds) return null;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    };
    
    // Format issues for frontend with source indicator
    const formattedIssues = issues.map(issue => {
      const timetracking = issue.fields.timetracking || {};
      return {
        id: issue.id,
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status?.name || 'Unknown',
        updated: issue.fields.updated,
        source: 'api',
        timeSpent: formatTime(timetracking.timeSpentSeconds || issue.fields.timespent),
        originalEstimate: formatTime(timetracking.originalEstimateSeconds || issue.fields.timeoriginalestimate),
        remainingEstimate: formatTime(timetracking.remainingEstimateSeconds || issue.fields.timeestimate)
      };
    });
    
    res.json(formattedIssues);
  } catch (error) {
    console.error('Error searching issues:', error.response?.data || error.message);
    
    // If the JQL query fails, try a simpler approach
    try {
      const { query } = req.query;
      
      // Try a simpler query that searches only in summary and description
      const fallbackJqlQuery = `(summary ~ "${query}" OR description ~ "${query}") ORDER BY updated DESC`;
      
      const response = await jiraApi.post('/rest/api/3/search/jql', {
        jql: fallbackJqlQuery,
        fields: ['id','key','summary','status','updated','timetracking','timespent','timeoriginalestimate','timeestimate'],
        maxResults: 50
      });
      
      const issues = response.data.issues || [];
      
      // Helper function to format time from seconds
      const formatTime = (seconds) => {
        if (!seconds) return null;
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      };
      
      // Format issues for frontend with source indicator
      const formattedIssues = issues.map(issue => {
        const timetracking = issue.fields.timetracking || {};
        return {
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          status: issue.fields.status?.name || 'Unknown',
          updated: issue.fields.updated,
          source: 'api',
          timeSpent: formatTime(timetracking.timeSpentSeconds || issue.fields.timespent),
          originalEstimate: formatTime(timetracking.originalEstimateSeconds || issue.fields.timeoriginalestimate),
          remainingEstimate: formatTime(timetracking.remainingEstimateSeconds || issue.fields.timeestimate)
        };
      });
      
      res.json(formattedIssues);
    } catch (fallbackError) {
      console.error('Fallback search also failed:', fallbackError.response?.data || fallbackError.message);
      res.status(500).json({ 
        error: 'Failed to search issues', 
        details: fallbackError.response?.data || fallbackError.message
      });
    }
  }
});

// Get issues where the current user was mentioned in comments
app.get('/api/mentioned-issues', async (req, res) => {
  try {
    // Fetch issues where the current user was mentioned in comments but not assigned
    const response = await jiraApi.post('/rest/api/3/search/jql', {
      jql: 'comment ~ currentUser() AND assignee != currentUser() ORDER BY updated DESC',
      fields: ['id','key','summary','status','updated'],
      maxResults: 50
    });
    
    const issues = response.data.issues || [];
    
    // Format issues for frontend
    const formattedIssues = issues.map(issue => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status?.name || 'Unknown',
      updated: issue.fields.updated
    }));
    
    res.json(formattedIssues);
  } catch (error) {
    console.error('Error fetching mentioned issues:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch mentioned issues', 
      details: error.response?.data || error.message
    });
  }
});

// Get issue details by key
app.get('/api/issue/:issueKey', async (req, res) => {
  try {
    const { issueKey } = req.params;
    const response = await jiraApi.get(`/rest/api/3/issue/${issueKey}`);
    
    res.json({
      id: response.data.id,
      key: response.data.key,
      summary: response.data.fields.summary,
      status: response.data.fields.status?.name || 'Unknown'
    });
  } catch (error) {
    console.error('Error fetching issue:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch issue', 
      details: error.response?.data || error.message
    });
  }
});

// Get time tracking information for an issue
app.get('/api/issue/:issueKey/timetracking', async (req, res) => {
  try {
    const { issueKey } = req.params;
    
    // Get issue details including time tracking fields
    const response = await jiraApi.get(`/rest/api/3/issue/${issueKey}`, {
      params: {
        fields: 'timetracking,timespent,timeoriginalestimate,timeestimate,aggregatetimeoriginalestimate,aggregatetimespent,aggregatetimeestimate'
      }
    });
    
    const timetracking = response.data.fields.timetracking || {};
    
    // Convert seconds to hours and minutes for display
    const formatTime = (seconds) => {
      if (!seconds) return null;
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    };
    
    const timeData = {
      originalEstimate: formatTime(timetracking.originalEstimateSeconds) || formatTime(response.data.fields.timeoriginalestimate),
      remainingEstimate: formatTime(timetracking.remainingEstimateSeconds) || formatTime(response.data.fields.timeestimate),
      timeSpent: formatTime(timetracking.timeSpentSeconds) || formatTime(response.data.fields.timespent),
      // Aggregate time tracking (includes sub-tasks)
      aggregateOriginalEstimate: formatTime(response.data.fields.aggregatetimeoriginalestimate),
      aggregateTimeSpent: formatTime(response.data.fields.aggregatetimespent),
      aggregateRemainingEstimate: formatTime(response.data.fields.aggregatetimeestimate),
      // Raw values for calculations
      raw: {
        originalEstimateSeconds: timetracking.originalEstimateSeconds || response.data.fields.timeoriginalestimate,
        remainingEstimateSeconds: timetracking.remainingEstimateSeconds || response.data.fields.timeestimate,
        timeSpentSeconds: timetracking.timeSpentSeconds || response.data.fields.timespent,
        aggregateOriginalEstimateSeconds: response.data.fields.aggregatetimeoriginalestimate,
        aggregateTimeSpentSeconds: response.data.fields.aggregatetimespent,
        aggregateRemainingEstimateSeconds: response.data.fields.aggregatetimeestimate
      }
    };
    
    res.json(timeData);
  } catch (error) {
    console.error('Error fetching time tracking:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch time tracking information', 
      details: error.response?.data || error.message
    });
  }
});

// Log time to Tempo
app.post('/api/log-time', async (req, res) => {
  try {
    const { issueId, timeSpentSeconds, description, startDate, endDate, startTime, attributes } = req.body;
    
    if (!issueId || !timeSpentSeconds || !description || !startDate || !startTime) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Ensure time format is HH:MM:SS
    let formattedStartTime = startTime;
    if (formattedStartTime && formattedStartTime.split(':').length === 2) {
      formattedStartTime = `${formattedStartTime}:00`;
    }
    
    // Process submitted attributes
    let workAttributes = [];
    
    // If attributes are provided in the request, use them
    if (Array.isArray(attributes) && attributes.length > 0) {
      workAttributes = attributes;
    }

    // Handle date range if endDate is provided
    if (endDate && endDate !== startDate) {
      // Multiple days logging
      const results = [];
      const dates = getDatesBetween(startDate, endDate);
      
      console.log(`Logging time for ${dates.length} days between ${startDate} and ${endDate}`);
      
      for (const date of dates) {
        // Create payload for Tempo API for each date
        const payload = {
          attributes: workAttributes,
          authorAccountId: TEMPO_ACCOUNT_ID,
          billableSeconds: timeSpentSeconds,
          description,
          issueId: parseInt(issueId),
          startDate: date,
          startTime: formattedStartTime,
          timeSpentSeconds
        };
        
        console.log(`Logging time for date: ${date}`);
        
        try {
          const response = await tempoApi.post('/worklogs', payload);
          results.push({
            date,
            success: true,
            worklogId: response.data.id || response.data.tempoWorklogId
          });
        } catch (err) {
          console.error(`Error logging time for date ${date}:`, err.response?.data || err.message);
          results.push({
            date,
            success: false,
            error: err.response?.data?.errors?.[0]?.message || err.message
          });
        }
      }
      
      // Check if all entries were successful or if there were any failures
      const allSuccess = results.every(result => result.success);
      const successCount = results.filter(result => result.success).length;
      
      if (allSuccess) {
        res.json({
          success: true,
          message: `Time logged successfully for all ${dates.length} days`,
          results
        });
      } else {
        res.status(207).json({
          success: false,
          message: `Time logged for ${successCount} out of ${dates.length} days`,
          results
        });
      }
    } else {
      // Single day logging (original functionality)
      const payload = {
        attributes: workAttributes,
        authorAccountId: TEMPO_ACCOUNT_ID,
        billableSeconds: timeSpentSeconds,
        description,
        issueId: parseInt(issueId),
        startDate,
        startTime: formattedStartTime,
        timeSpentSeconds
      };
      
      console.log('Logging time with payload:', JSON.stringify(payload, null, 2));
      
      const response = await tempoApi.post('/worklogs', payload);
      
      res.json({
        success: true,
        message: 'Time logged successfully',
        worklogId: response.data.id || response.data.tempoWorklogId
      });
    }
  } catch (error) {
    console.error('Error logging time:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to log time', 
      message: error.response?.data?.errors?.[0]?.message || error.message,
      details: error.response?.data || error.message
    });
  }
});

// Get user info
app.get('/api/user', async (req, res) => {
  try {
    const response = await jiraApi.get('/rest/api/3/myself');
    
    res.json({
      displayName: response.data.displayName,
      email: response.data.emailAddress,
      accountId: response.data.accountId,
      timeZone: response.data.timeZone
    });
  } catch (error) {
    console.error('Error fetching user:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch user', 
      details: error.response?.data || error.message
    });
  }
});

// Get Tempo work attributes
app.get('/api/tempo/work-attributes', async (req, res) => {
  try {
    console.log('Fetching all work attributes from Tempo API');
    
    // For testing, first check if we have the sample data provided earlier
    const sampleData = [
      {
        "id": 2,
        "key": "_TimeCategory_",
        "name": "Time Type",
        "type": {
          "name": "Static List",
          "value": "STATIC_LIST",
          "systemType": false
        },
        "externalUrl": null,
        "required": true,
        "urlVerified": null,
        "sequence": 0,
        "staticListValues": [
          { "id": 2, "name": "Capacity Planning", "value": "CapacityPlanning", "removed": false, "sequence": 0, "workAttributeId": 2 },
          { "id": 4, "name": "Execution", "value": "Execution", "removed": false, "sequence": 1, "workAttributeId": 2 },
          // More values here...
        ]
      },
      {
        "id": 153,
        "key": "_TechnologyTimeType_",
        "name": "Technology Time Type",
        "type": {
          "name": "Static List",
          "value": "STATIC_LIST",
          "systemType": false
        },
        "externalUrl": null,
        "required": false,
        "urlVerified": null,
        "sequence": 2,
        "staticListValues": [
          { "id": 688, "name": "Capitalizable_Environment_Setup", "value": "CapitalizableEnvironmentSetup", "removed": false, "sequence": 0, "workAttributeId": 153 },
          { "id": 689, "name": "Capitalizable_Sprint_Planning", "value": "CapitalizableSprintPlanning", "removed": false, "sequence": 1, "workAttributeId": 153 },
          // More values here...
        ]
      }
    ];
    
    // Make request to Tempo API to get all work attributes
    const response = await tempoApi.get('/work-attributes', {
      headers: {
        'Authorization': `Bearer ${TEMPO_API_TOKEN}`,
        'Accept': 'application/json'
      }
    });
    
    console.log(`Received work attributes. Data type: ${Array.isArray(response.data) ? 'Array' : typeof response.data}, Length: ${Array.isArray(response.data) ? response.data.length : 'N/A'}`);
    
    // Log the raw response data for debugging
    console.log('Raw response data:', JSON.stringify(response.data).substring(0, 500) + '...');
    
    // Use the response data if available, otherwise use sample data
    const data = response.data && response.data.results ? response.data.results : sampleData;
    
    console.log('Using data:', Array.isArray(data) ? `Array with ${data.length} items` : typeof data);
    
    // Return the work attributes in a structured format that's easier for the frontend to use
    if (Array.isArray(data)) {
      // Create a map of attributes by key for easier frontend usage
      const attributesMap = {};
      
      data.forEach(attr => {
        console.log('attr', attr);
        
        // Extract values from the response, which might be in different formats
        let attributeValues = [];
        
        if (Array.isArray(attr.values) && attr.names) {
          // Format from actual API response - values is an array of strings with a names object
          attributeValues = attr.values.map((value, index) => ({
            id: index,
            name: attr.names[value] || value,
            value: value
          }));
        } else if (Array.isArray(attr.values)) {
          // Format from actual API response - values is an array of strings without names
          attributeValues = attr.values.map((value, index) => ({
            id: index,
            name: value,
            value: value
          }));
        } else if (Array.isArray(attr.staticListValues)) {
          // Format from sample data
          attributeValues = attr.staticListValues.map(value => ({
            id: value.id,
            name: value.name,
            value: value.value || value.name
          }));
        } else if (typeof attr.values === 'string') {
          // If values is a comma-separated string
          attributeValues = attr.values.split(',').map((value, index) => ({
            id: index,
            name: value.trim(),
            value: value.trim()
          }));
        }
        
        attributesMap[attr.key] = {
          id: attr.id || 0,
          key: attr.key,
          name: attr.name,
          required: attr.required || false,
          type: attr.type?.value || attr.type,
          values: attributeValues
        };
        
        console.log(`Processed attribute ${attr.key}: ${attr.name} with ${attributeValues.length} values`);
      });
      
      res.json(attributesMap);
    } else {
      res.json(data);
    }
  } catch (error) {
    console.error('Error fetching work attributes:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch work attributes', 
      details: error.response?.data || error.message
    });
  }
});

// Get specific Tempo work attribute with all values
app.get('/api/tempo/work-attributes/:attributeKey', async (req, res) => {
  try {
    const { attributeKey } = req.params;
    
    console.log(`Fetching attribute with key: ${attributeKey}`);
    
    // Make request to Tempo API to get the specific work attribute
    const response = await axios.get(`${TEMPO_BASE_URL}/work-attributes/${attributeKey}`, {
      headers: {
        'Authorization': `Bearer ${TEMPO_API_TOKEN}`,
        'Accept': 'application/json'
      }
    });
    
    // Return the work attribute with all its details
    res.json(response.data);
  } catch (error) {
    console.error(`Error fetching attribute ${req.params.attributeKey}:`, error.response?.data || error.message);
    res.status(500).json({ 
      error: `Failed to fetch attribute ${req.params.attributeKey}`, 
      details: error.response?.data || error.message
    });
  }
});

// Get meetings from Tempo calendar/schedule - similar to JIRA Tempo page
app.get('/api/meetings', async (req, res) => {
  try {
    const { from, to } = req.query;
    
    // Default to current week if no dates provided
    const fromDate = from || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];
    
    console.log(`Fetching meetings from Tempo calendar for ${fromDate} to ${toDate}`);
    console.log(`Using TEMPO_ACCOUNT_ID: ${TEMPO_ACCOUNT_ID}`);
    console.log(`Using JIRA_EMAIL: ${JIRA_EMAIL}`);
    
    let meetings = [];
    let totalMeetings = 0;
    let totalMeetingTime = 0;
    
    try {
      // Try to fetch from Tempo's calendar/schedule API endpoints
      console.log('Attempting to fetch from Tempo calendar API...');
      
      // First try the calendar events endpoint
      const calendarResponse = await tempoApi.get('/calendar/events', {
        params: {
          from: fromDate,
          to: toDate,
          user: TEMPO_ACCOUNT_ID
        }
      });
      
      if (calendarResponse.data && calendarResponse.data.results) {
        meetings = calendarResponse.data.results
          .filter(event => {
            // Only include meetings where you are an attendee or organizer
            const isOrganizer = event.organizer?.accountId === TEMPO_ACCOUNT_ID;
            const isAttendee = event.attendees?.some(attendee => 
              attendee.accountId === TEMPO_ACCOUNT_ID || 
              attendee.emailAddress === JIRA_EMAIL
            );
            return isOrganizer || isAttendee;
          })
          .map(event => {
            const startDateTime = new Date(event.start);
            const endDateTime = new Date(event.end);
            const durationSeconds = Math.round((endDateTime - startDateTime) / 1000);
            
            const formatTime = (seconds) => {
              const hours = Math.floor(seconds / 3600);
              const minutes = Math.floor((seconds % 3600) / 60);
              return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
            };
            
            return {
              id: event.id,
              issueKey: event.issue?.key || 'MEETING',
              issueSummary: event.issue?.summary || 'Calendar Event',
              description: event.title || event.summary || 'Meeting',
              date: startDateTime.toISOString().split('T')[0],
              startTime: startDateTime.toTimeString().split(' ')[0],
              endTime: endDateTime.toTimeString().split(' ')[0],
              duration: formatTime(durationSeconds),
              durationSeconds: durationSeconds,
              author: event.organizer?.displayName || 'You',
              type: 'calendar',
              location: event.location || null,
              attendees: event.attendees?.map(a => a.displayName || a.emailAddress).join(', ') || '',
              isOrganizer: event.organizer?.accountId === TEMPO_ACCOUNT_ID
            };
          });
        
        console.log(`Found ${meetings.length} calendar events where you are invited/organizing`);
      }
    } catch (calendarError) {
      console.log('Calendar API not available:', calendarError.response?.status, calendarError.response?.statusText);
      console.log('Calendar API error details:', calendarError.response?.data);
      console.log('Trying Microsoft Teams integration...');
      
      // Try to get meetings from Microsoft Teams integration
      try {
        console.log('Attempting to fetch meetings from Microsoft Teams integration...');
        
        // Try Microsoft Teams plugin calendar endpoint
        const teamsResponse = await jiraApi.get('/rest/plugins/1.0/msteams-jira/calendar/events', {
          params: {
            from: fromDate,
            to: toDate
          }
        });
        
        if (teamsResponse.data && teamsResponse.data.events) {
          const teamsMeetings = teamsResponse.data.events
            .filter(event => {
              // Only include meetings where you are an attendee or organizer
              const isOrganizer = event.organizer?.emailAddress?.address === JIRA_EMAIL;
              const isAttendee = event.attendees?.some(attendee => 
                attendee.emailAddress?.address === JIRA_EMAIL
              );
              return isOrganizer || isAttendee;
            })
            .map(event => {
              const startDateTime = new Date(event.start);
              const endDateTime = new Date(event.end || event.start);
              const durationSeconds = Math.round((endDateTime - startDateTime) / 1000) || 3600; // Default 1 hour
              
              const formatTime = (seconds) => {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
              };
              
              return {
                id: event.id || `teams-${Date.now()}`,
                issueKey: 'TEAMS',
                issueSummary: 'Microsoft Teams Meeting',
                description: event.subject || event.title || 'Teams Meeting',
                date: startDateTime.toISOString().split('T')[0],
                startTime: startDateTime.toTimeString().split(' ')[0],
                endTime: endDateTime.toTimeString().split(' ')[0],
                duration: formatTime(durationSeconds),
                durationSeconds: durationSeconds,
                author: event.organizer?.emailAddress?.name || 'You',
                type: 'teams',
                location: event.location?.displayName || 'Microsoft Teams',
                attendees: event.attendees?.map(a => a.emailAddress?.name).join(', ') || '',
                isOrganizer: event.organizer?.emailAddress?.address === JIRA_EMAIL
              };
            });
          
          meetings = meetings.concat(teamsMeetings);
          console.log(`Found ${teamsMeetings.length} Microsoft Teams meetings where you are invited/organizing`);
        }
      } catch (teamsError) {
        console.log('Microsoft Teams calendar not accessible:', teamsError.message);
        
        // Try alternative Microsoft Graph API approach through the plugin
        try {
          console.log('Trying Microsoft Graph API through Teams plugin...');
          
          const graphResponse = await jiraApi.get('/rest/plugins/1.0/msteams-jira/graph/me/calendar/events', {
            params: {
              startDateTime: `${fromDate}T00:00:00.000Z`,
              endDateTime: `${toDate}T23:59:59.999Z`
            }
          });
          
          if (graphResponse.data && graphResponse.data.value) {
            const graphMeetings = graphResponse.data.value
              .filter(event => {
                // Only include meetings where you are an attendee or organizer
                const isOrganizer = event.organizer?.emailAddress?.address === JIRA_EMAIL;
                const isAttendee = event.attendees?.some(attendee => 
                  attendee.emailAddress?.address === JIRA_EMAIL
                );
                return isOrganizer || isAttendee;
              })
              .map(event => {
                const startDateTime = new Date(event.start.dateTime);
                const endDateTime = new Date(event.end.dateTime);
                const durationSeconds = Math.round((endDateTime - startDateTime) / 1000);
                
                const formatTime = (seconds) => {
                  const hours = Math.floor(seconds / 3600);
                  const minutes = Math.floor((seconds % 3600) / 60);
                  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                };
                
                return {
                  id: event.id,
                  issueKey: 'OUTLOOK',
                  issueSummary: 'Outlook Calendar Event',
                  description: event.subject || 'Meeting',
                  date: startDateTime.toISOString().split('T')[0],
                  startTime: startDateTime.toTimeString().split(' ')[0],
                  endTime: endDateTime.toTimeString().split(' ')[0],
                  duration: formatTime(durationSeconds),
                  durationSeconds: durationSeconds,
                  author: event.organizer?.emailAddress?.name || 'You',
                  type: 'outlook',
                  location: event.location?.displayName || (event.onlineMeeting?.joinUrl ? 'Online Meeting' : ''),
                  attendees: event.attendees?.map(a => a.emailAddress?.name).join(', ') || '',
                  isOrganizer: event.organizer?.emailAddress?.address === JIRA_EMAIL
                };
              });
            
            meetings = meetings.concat(graphMeetings);
            console.log(`Found ${graphMeetings.length} Outlook calendar events where you are invited/organizing`);
          }
        } catch (graphError) {
          console.log('Microsoft Graph API also not accessible:', graphError.message);
        }
      }
      
      try {
        // Try Tempo's schedule API
        console.log('Attempting to fetch from Tempo schedule API...');
        
        const scheduleResponse = await tempoApi.get('/schedule', {
          params: {
            from: fromDate,
            to: toDate,
            worker: TEMPO_ACCOUNT_ID
          }
        });
        
        if (scheduleResponse.data && scheduleResponse.data.results) {
          const tempoMeetings = scheduleResponse.data.results
            .filter(item => item.type === 'meeting' || item.type === 'event')
            .map(event => {
              const startDateTime = new Date(`${event.date}T${event.startTime || '09:00:00'}`);
              const durationSeconds = event.durationSeconds || 3600; // Default 1 hour
              const endDateTime = new Date(startDateTime.getTime() + (durationSeconds * 1000));
              
              const formatTime = (seconds) => {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
              };
              
              return {
                id: event.id,
                issueKey: 'MEETING',
                issueSummary: 'Scheduled Meeting',
                description: event.description || event.title || 'Meeting',
                date: event.date,
                startTime: event.startTime || '09:00:00',
                endTime: endDateTime.toTimeString().split(' ')[0],
                duration: formatTime(durationSeconds),
                durationSeconds: durationSeconds,
                author: 'You',
                type: 'tempo-schedule',
                location: event.location || '',
                attendees: event.attendees || ''
              };
            });
          
          meetings = meetings.concat(tempoMeetings);
          console.log(`Found ${tempoMeetings.length} Tempo scheduled meetings`);
        }
      } catch (scheduleError) {
        console.log('Schedule API not available, trying worklog-based approach...');
        
        // Enhanced worklog-based meeting detection - this should work with existing Tempo data
        try {
          console.log('Fetching ALL worklogs for your account to identify meetings...');
          
          const worklogResponse = await tempoApi.get('/worklogs', {
            params: {
              from: fromDate,
              to: toDate,
              worker: [TEMPO_ACCOUNT_ID]
            }
          });
          
          console.log('Worklog API response status:', worklogResponse.status);
          const worklogs = worklogResponse.data.results || [];
          console.log(`Total worklogs found: ${worklogs.length}`);
          
          // Enhanced meeting keywords - more comprehensive list
          const meetingKeywords = [
            'meeting', 'standup', 'demo', 'retrospective', 'planning', 'sync',
            'call', 'review', 'ceremony', 'discussion', 'session', 'sprint',
            'scrum', 'grooming', 'refinement', 'huddle', 'catchup', 'check-in',
            'interview', 'presentation', 'walkthrough', 'training', 'workshop',
            'meetings', 'standups', 'demos', 'ceremonies', 'discussions',
            'daily', 'weekly', 'monthly', 'quarterly', 'team', 'one-on-one',
            'sync-up', 'check-in', 'touchbase', 'collaboration', 'brainstorm'
          ];
          
          // Also check for common meeting patterns in issue keys or summaries
          const meetingPatterns = [
            /standup/i, /meeting/i, /demo/i, /retro/i, /planning/i,
            /sync/i, /review/i, /ceremony/i, /scrum/i, /daily/i
          ];
          
          const foundMeetings = worklogs
            .filter(worklog => {
              // Check if worklog belongs to your account
              const isYourWorklog = worklog.author?.accountId === TEMPO_ACCOUNT_ID;
              
              // Check description for meeting keywords
              const description = (worklog.description || '').toLowerCase();
              const hasKeywordInDescription = meetingKeywords.some(keyword => description.includes(keyword));
              
              // Check issue summary for meeting patterns
              const issueSummary = (worklog.issue?.summary || '').toLowerCase();
              const hasPatternInSummary = meetingPatterns.some(pattern => pattern.test(issueSummary));
              
              // Check if the worklog is for a specific type of issue that's typically meetings
              const issueKey = worklog.issue?.key || '';
              const isIssueTypicallyMeeting = hasPatternInSummary || hasKeywordInDescription;
              
              console.log(`Worklog ${worklog.tempoWorklogId || worklog.id}: author=${worklog.author?.accountId}, expected=${TEMPO_ACCOUNT_ID}, isYour=${isYourWorklog}, hasKeyword=${hasKeywordInDescription}, hasPattern=${hasPatternInSummary}, desc="${description.substring(0, 50)}", issue="${issueSummary.substring(0, 50)}"`);
              
              return isYourWorklog && (hasKeywordInDescription || hasPatternInSummary);
            })
            .map(worklog => {
              const formatTime = (seconds) => {
                const hours = Math.floor(seconds / 3600);
                const minutes = Math.floor((seconds % 3600) / 60);
                return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
              };
              
              const startDateTime = new Date(`${worklog.startDate}T${worklog.startTime}`);
              const endDateTime = new Date(startDateTime.getTime() + (worklog.timeSpentSeconds * 1000));
              
              return {
                id: worklog.tempoWorklogId || worklog.id,
                issueKey: worklog.issue?.key || 'MEETING',
                issueSummary: worklog.issue?.summary || 'Meeting from Worklog',
                description: worklog.description,
                date: worklog.startDate,
                startTime: worklog.startTime,
                endTime: endDateTime.toTimeString().split(' ')[0],
                duration: formatTime(worklog.timeSpentSeconds),
                durationSeconds: worklog.timeSpentSeconds,
                author: worklog.author?.displayName || 'You',
                type: 'worklog',
                source: 'tempo-worklog'
              };
            });
          
          meetings = meetings.concat(foundMeetings);
          console.log(`Found ${foundMeetings.length} meeting-like worklogs for your account from ${worklogs.length} total worklogs`);
        } catch (worklogError) {
          console.log('All API attempts failed, returning empty results');
          meetings = [];
        }
      }
    }
    
    console.log(`Total meetings found for your account: ${meetings.length}`);
    
    // Calculate summary statistics
    totalMeetings = meetings.length;
    totalMeetingTime = meetings.reduce((total, meeting) => total + meeting.durationSeconds, 0);
    
    // Sort meetings by date and time (most recent first)
    meetings.sort((a, b) => {
      const dateA = new Date(`${a.date}T${a.startTime}`);
      const dateB = new Date(`${b.date}T${b.startTime}`);
      return dateB - dateA;
    });
    
    console.log(`Returning ${meetings.length} meetings for ${JIRA_EMAIL} (${TEMPO_ACCOUNT_ID})`);
    console.log(`Total meetings time: ${Math.round(totalMeetingTime / 3600)}h ${Math.round((totalMeetingTime % 3600) / 60)}m`);
    
    res.json({
      meetings,
      summary: {
        totalMeetings,
        totalMeetingTime,
        dateRange: {
          from: fromDate,
          to: toDate
        },
        accountEmail: JIRA_EMAIL,
        accountId: TEMPO_ACCOUNT_ID
      }
    });
  } catch (error) {
    console.error('Error fetching meetings:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch meetings', 
      details: error.response?.data || error.message
    });
  }
});

// Get calendar events from JIRA (if available) - alternative source for meetings
app.get('/api/calendar-events', async (req, res) => {
  try {
    const { from, to } = req.query;
    
    // Default to current week if no dates provided
    const fromDate = from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];
    
    console.log(`Fetching calendar events from JIRA for ${fromDate} to ${toDate}`);
    
    let events = [];
    
    try {
      // Try JIRA's calendar API
      const response = await jiraApi.get('/rest/api/3/calendar', {
        params: {
          startDate: fromDate,
          endDate: toDate
        }
      });
      
      events = response.data.events || [];
      console.log(`Found ${events.length} calendar events from JIRA`);
    } catch (calendarError) {
      console.log('JIRA calendar API not available, trying alternative endpoints...');
      
      try {
        // Try to fetch meetings from JIRA's activity streams
        const activityResponse = await jiraApi.get('/rest/api/3/events', {
          params: {
            startDate: fromDate,
            endDate: toDate
          }
        });
        
        events = activityResponse.data || [];
        console.log(`Found ${events.length} events from JIRA activity streams`);
      } catch (activityError) {
        console.log('JIRA activity streams not available either');
        
        try {
          // Try to get meeting information from issue comments or descriptions
          const searchResponse = await jiraApi.get('/rest/api/3/search', {
            params: {
              jql: `assignee = currentUser() AND (summary ~ "meeting" OR summary ~ "standup" OR summary ~ "demo" OR summary ~ "sync" OR summary ~ "review") AND updated >= "${fromDate}" ORDER BY updated DESC`,
              fields: 'id,key,summary,status,updated,description',
              maxResults: 50
            }
          });
          
          const issues = searchResponse.data.issues || [];
          events = issues.map(issue => ({
            id: issue.id,
            title: issue.fields.summary,
            description: issue.fields.description || '',
            issueKey: issue.key,
            date: issue.fields.updated.split('T')[0],
            type: 'issue'
          }));
          
          console.log(`Found ${events.length} meeting-related issues from JIRA`);
        } catch (searchError) {
          console.log('All JIRA meeting sources failed, returning empty result');
          events = [];
        }
      }
    }
    
    res.json({
      events,
      summary: {
        totalEvents: events.length,
        source: 'jira',
        dateRange: {
          from: fromDate,
          to: toDate
        }
      }
    });
    } catch (error) {
    console.error('Error fetching calendar events:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch calendar events', 
      details: error.response?.data || error.message
    });
  }
});

// Debug endpoint to test what worklog data is available
app.get('/api/debug/worklogs', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];
    
    console.log(`Debug: Fetching worklogs from ${fromDate} to ${toDate} for account ${TEMPO_ACCOUNT_ID}`);
    
    const worklogResponse = await tempoApi.get('/worklogs', {
      params: {
        from: fromDate,
        to: toDate,
        worker: [TEMPO_ACCOUNT_ID]
      }
    });
    
    const worklogs = worklogResponse.data.results || [];
    
    console.log(`Debug: Found ${worklogs.length} total worklogs`);
    
    // Return detailed information about each worklog
    const debugInfo = worklogs.map(worklog => ({
      id: worklog.tempoWorklogId || worklog.id,
      issueKey: worklog.issue?.key,
      issueSummary: worklog.issue?.summary,
      description: worklog.description,
      author: {
        accountId: worklog.author?.accountId,
        displayName: worklog.author?.displayName
      },
      date: worklog.startDate,
      startTime: worklog.startTime,
      timeSpentSeconds: worklog.timeSpentSeconds,
      isYourWorklog: worklog.author?.accountId === TEMPO_ACCOUNT_ID
    }));
    
    res.json({
      totalWorklogs: worklogs.length,
      yourWorklogs: debugInfo.filter(w => w.isYourWorklog).length,
      dateRange: { from: fromDate, to: toDate },
      accountId: TEMPO_ACCOUNT_ID,
      worklogs: debugInfo
    });
  } catch (error) {
    console.error('Debug endpoint error:', error.response?.data || error.message);
    res.status(500).json({ 
      error: 'Failed to fetch debug worklogs', 
      details: error.response?.data || error.message
    });
  }
});

// AI Agent API Routes

// Start AI agent
app.post('/api/ai-agent/start', async (req, res) => {
  try {
    if (isAiAgentRunning) {
      return res.status(400).json({ error: 'AI agent is already running' });
    }
    
    await aiAgent.start();
    isAiAgentRunning = true;
    
    res.json({ 
      success: true, 
      message: 'AI Time Tracking Agent started successfully',
      status: aiAgent.getStatus()
    });
  } catch (error) {
    console.error('Error starting AI agent:', error);
    res.status(500).json({ 
      error: 'Failed to start AI agent', 
      details: error.message 
    });
  }
});

// Stop AI agent
app.post('/api/ai-agent/stop', async (req, res) => {
  try {
    if (!isAiAgentRunning) {
      return res.status(400).json({ error: 'AI agent is not running' });
    }
    
    await aiAgent.stop();
    isAiAgentRunning = false;
    
    res.json({ 
      success: true, 
      message: 'AI Time Tracking Agent stopped successfully'
    });
  } catch (error) {
    console.error('Error stopping AI agent:', error);
    res.status(500).json({ 
      error: 'Failed to stop AI agent', 
      details: error.message 
    });
  }
});

// Get AI agent status
app.get('/api/ai-agent/status', (req, res) => {
  try {
    const status = aiAgent.getStatus();
    res.json({
      ...status,
      isRunning: isAiAgentRunning
    });
  } catch (error) {
    console.error('Error getting AI agent status:', error);
    res.status(500).json({ 
      error: 'Failed to get AI agent status', 
      details: error.message 
    });
  }
});

// Get session history
app.get('/api/ai-agent/sessions', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const sessions = await aiAgent.getSessionHistory(days);
    
    // Format sessions for display
    const formattedSessions = sessions.map(session => ({
      id: session.id,
      startTime: new Date(session.startTime).toISOString(),
      endTime: session.endTime ? new Date(session.endTime).toISOString() : null,
      duration: session.duration,
      formattedDuration: aiAgent.formatDuration(session.duration),
      detectedIssue: session.detectedIssue,
      confidence: session.confidence,
      isLogged: aiAgent.loggedSessions.has(session.id),
      applications: session.applications,
      windowTitles: session.windowTitles,
      directories: session.directories,
      gitBranches: session.gitBranches
    }));
    
    res.json(formattedSessions);
  } catch (error) {
    console.error('Error getting session history:', error);
    res.status(500).json({ 
      error: 'Failed to get session history', 
      details: error.message 
    });
  }
});

// Get pending sessions that need review
app.get('/api/ai-agent/pending', async (req, res) => {
  try {
    const pendingSessions = await aiAgent.getPendingSessions();
    
    const formattedSessions = pendingSessions.map(session => ({
      id: session.id,
      startTime: new Date(session.startTime).toISOString(),
      endTime: session.endTime ? new Date(session.endTime).toISOString() : null,
      duration: session.duration,
      formattedDuration: aiAgent.formatDuration(session.duration),
      detectedIssue: session.detectedIssue,
      confidence: session.confidence,
      applications: session.applications,
      windowTitles: session.windowTitles.slice(0, 3), // Limit for display
      directories: session.directories,
      gitBranches: session.gitBranches
    }));
    
    res.json(formattedSessions);
  } catch (error) {
    console.error('Error getting pending sessions:', error);
    res.status(500).json({ 
      error: 'Failed to get pending sessions', 
      details: error.message 
    });
  }
});

// Approve a session for logging
app.post('/api/ai-agent/sessions/:sessionId/approve', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = await aiAgent.approveSession(sessionId);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Session approved and logged to Tempo successfully' 
      });
    } else {
      res.status(404).json({ 
        error: 'Session not found or already processed' 
      });
    }
  } catch (error) {
    console.error('Error approving session:', error);
    res.status(500).json({ 
      error: 'Failed to approve session', 
      details: error.message 
    });
  }
});

// Reject a session
app.post('/api/ai-agent/sessions/:sessionId/reject', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const success = await aiAgent.rejectSession(sessionId);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Session rejected successfully' 
      });
    } else {
      res.status(404).json({ 
        error: 'Session not found' 
      });
    }
  } catch (error) {
    console.error('Error rejecting session:', error);
    res.status(500).json({ 
      error: 'Failed to reject session', 
      details: error.message 
    });
  }
});

// Update session issue assignment
app.put('/api/ai-agent/sessions/:sessionId/issue', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { issueKey } = req.body;
    
    if (!issueKey) {
      return res.status(400).json({ error: 'Issue key is required' });
    }
    
    const success = await aiAgent.updateSessionIssue(sessionId, issueKey);
    
    if (success) {
      res.json({ 
        success: true, 
        message: 'Session issue updated successfully' 
      });
    } else {
      res.status(404).json({ 
        error: 'Session not found' 
      });
    }
  } catch (error) {
    console.error('Error updating session issue:', error);
    res.status(500).json({ 
      error: 'Failed to update session issue', 
      details: error.message 
    });
  }
});

// Parse daily free-form notes with LLM and log time blocks
app.post('/api/ai/log-daily-notes', async (req, res) => {
  try {
    if (!isAiAgentRunning) {
      return res.status(400).json({ error: 'AI agent not running' });
    }
    const { date, notes } = req.body;
    if (!date || !notes) {
      return res.status(400).json({ error: 'date and notes are required' });
    }
    const { parseDailyNotes } = require('./llmParser');
    // Fetch issues to ground the model
    let issues = [];
    try {
      const response = await jiraApi.post('/rest/api/3/search/jql', {
        jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
        fields: ['summary','key'],
        maxResults: 50
      });
      issues = (response.data.issues || []).map(i => ({ key: i.key, summary: i.fields.summary }));
    } catch (_) {}
    const parsed = await parseDailyNotes({ date, notes, issues });
    const logResult = await aiAgent.logDailyBlocks(parsed);
    res.json({ parsed, logResult });
  } catch (error) {
    console.error('Error parsing daily notes:', error);
    res.status(500).json({ error: 'Failed to process daily notes', details: error.message });
  }
});

// Get AI agent configuration
app.get('/api/ai-agent/config', (req, res) => {
  const cfg = aiAgent.effectiveConfig;
  // Frontend expects minute values under keys WITHOUT the Ms suffix. Provide both for backward compatibility.
  const toMinutes = (ms) => Math.round(ms / 60000);
  res.json({
    // New preferred keys (minutes)
    monitoringInterval: toMinutes(cfg.monitoringInterval),
    workSessionThreshold: toMinutes(cfg.workSessionThreshold),
    autoLogThreshold: toMinutes(cfg.autoLogThreshold),
    maxSessionDuration: toMinutes(cfg.maxSessionDuration),
    workHoursStart: cfg.workHoursStart,
    workHoursEnd: cfg.workHoursEnd,
    // Legacy keys (raw ms) kept in case any consumer still references them
    monitoringIntervalMs: cfg.monitoringInterval,
    workSessionThresholdMs: cfg.workSessionThreshold,
    autoLogThresholdMs: cfg.autoLogThreshold,
    maxSessionDurationMs: cfg.maxSessionDuration
  });
});

// Runtime config endpoints
app.get('/api/ai-agent/runtime-config', (req,res)=>{
  res.json({ overrides: require('fs').existsSync('user-config.json') ? JSON.parse(require('fs').readFileSync('user-config.json','utf-8')) : {}, effective: aiAgent.effectiveConfig });
});

app.put('/api/ai-agent/runtime-config', (req,res)=>{
  try {
    const body = req.body || {};
    const numericFields = ['monitoringInterval','workSessionThreshold','autoLogThreshold','maxSessionDuration'];
    numericFields.forEach(f=>{ if (body[f] && typeof body[f]==='number' && body[f] < 1000) { // treat as minutes if too small
      body[f] = body[f] * 60 * 1000; }
    });
    const updated = aiAgent.updateRuntimeConfig(body);
    res.json({ success:true, effective: updated });
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/ai-agent/runtime-config', (req,res)=>{
  const cleared = aiAgent.clearRuntimeConfig();
  res.json({ success:true, effective: cleared });
});

// Serve the frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  const baseUrl = `http://localhost:${PORT}`;
  console.log(`🚀 JIRA Tempo Time Logger server running on port ${PORT}`);
  console.log(`Open your browser and go to ${baseUrl}\n  Main: ${baseUrl}\n  AI Agent Dashboard: ${baseUrl}/ai-agent.html`);
});
