// Minimal MCP/JSON-RPC style bridge for Atlassian + AI Agent interactions.
// Transport: stdin/stdout line-delimited JSON objects { id, method, params } -> { id, result } | { id, error }
// This is a lightweight implementation (not full MCP spec) enabling programmatic control.

const { getJiraApi } = require('./atlassianProvider');
const AITimeTrackingAgent = require('./ai-agent');
const { parseDailyNotes } = require('./llmParser');

// Logging utilities
const LOG_LEVEL = (process.env.MCP_LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
function log(level, msg, meta) {
	if (LEVELS[level] <= LEVELS[LOG_LEVEL]) {
		const rec = { ts: new Date().toISOString(), level, msg };
		if (meta) rec.meta = meta;
		process.stderr.write(JSON.stringify(rec) + '\n');
	}
}
function time(fnName) {
	const start = process.hrtime.bigint();
	return () => {
		const end = process.hrtime.bigint();
		return Number(end - start) / 1e6; // ms
	};
}

// Test mode (no Jira calls) for unit tests
const TEST_MODE = process.env.MCP_TEST_MODE === 'true';

// Singleton agent instance (separate from server.js) for CLI/MCP mode
const aiAgent = new AITimeTrackingAgent();
let agentRunning = false;

async function ensureAgentStarted() {
	if (!agentRunning) {
		log('debug', 'Starting agent (lazy)');
		await aiAgent.start();
		agentRunning = true;
	}
}

const methods = {
	async 'agent.start'() {
		if (!agentRunning) {
			await aiAgent.start();
			agentRunning = true;
		}
		return { running: true, status: aiAgent.getStatus() };
	},
	async 'agent.stop'() {
		if (agentRunning) {
			await aiAgent.stop();
			agentRunning = false;
		}
		return { running: false };
	},
	async 'agent.status'() {
		return { running: agentRunning, status: aiAgent.getStatus() };
	},
	async 'agent.sessions.list'(params = {}) {
		const days = params.days || 7;
		const sessions = await aiAgent.getSessionHistory(days);
		return sessions;
	},
	async 'agent.sessions.pending'() {
		return aiAgent.getPendingSessions();
	},
	async 'agent.sessions.approve'({ sessionId }) {
		if (!sessionId) throw new Error('sessionId required');
		const ok = await aiAgent.approveSession(sessionId);
		return { success: ok };
	},
	async 'agent.sessions.reject'({ sessionId }) {
		if (!sessionId) throw new Error('sessionId required');
		const ok = await aiAgent.rejectSession(sessionId);
		return { success: ok };
	},
	async 'agent.sessions.updateIssue'({ sessionId, issueKey }) {
		if (!sessionId || !issueKey) throw new Error('sessionId and issueKey required');
		const ok = await aiAgent.updateSessionIssue(sessionId, issueKey);
		return { success: ok };
	},
	async 'agent.dailyNotes.parse'({ date, notes }) {
		if (!date || !notes) throw new Error('date and notes required');
		// attempt grounding issues
		let issues = [];
		try {
			if (!TEST_MODE) {
				const jira = await getJiraApi();
				const resp = await jira.post('/rest/api/3/search/jql', {
					jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
					fields: ['summary','key'],
					maxResults: 50
				});
				issues = (resp.data.issues || []).map(i => ({ key: i.key, summary: i.fields.summary }));
			} else {
				issues = [ { key: 'TEST-1', summary: 'Mock issue summary' } ];
			}
		} catch (_) {}
		const parsed = await parseDailyNotes({ date, notes, issues });
		return parsed;
	},
	async 'jira.searchIssues'({ jql, fields = ['summary','key'], maxResults = 50 }) {
		if (!jql) throw new Error('jql required');
		if (TEST_MODE) {
			return { issues: [ { key: 'TEST-SEARCH-1', fields: { summary: 'Test search issue' } } ] };
		}
		const jira = await getJiraApi();
		const resp = await jira.post('/rest/api/3/search/jql', { jql, fields, maxResults });
		return resp.data;
	},
	async 'jira.issue.get'({ issueKey }) {
		if (!issueKey) throw new Error('issueKey required');
		if (TEST_MODE) {
			return { key: issueKey, fields: { summary: 'Mock Issue '+issueKey } };
		}
		const jira = await getJiraApi();
		const resp = await jira.get(`/rest/api/3/issue/${issueKey}`);
		return resp.data;
	}
};

function respond(obj) {
	process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(line) {
	let msg;
	try { msg = JSON.parse(line); } catch (e) {
		return respond({ id: null, error: { message: 'Invalid JSON', details: e.message } });
	}
	if (!msg || typeof msg !== 'object') {
		return respond({ id: null, error: { message: 'Invalid message shape' } });
	}
	const { id, method, params } = msg;
		if (!method || !methods[method]) {
			log('warn', 'Unknown method', { method });
			return respond({ id, error: { message: 'Unknown method', method } });
		}
		const stopTimer = time(method);
		try {
			if (method.startsWith('agent.') && method !== 'agent.status') {
				await ensureAgentStarted();
			}
			log('debug', 'Invoke', { method, params });
			const result = await methods[method](params || {});
			const dur = stopTimer();
			log('info', 'Success', { method, ms: dur });
			respond({ id, result, ms: dur });
		} catch (e) {
			const dur = stopTimer();
			log('error', 'Failure', { method, ms: dur, error: e.message });
			respond({ id, error: { message: e.message }, ms: dur });
		}
}

// Start reading stdin
if (require.main === module) {
	process.stdin.setEncoding('utf8');
	let buffer = '';
	process.stdin.on('data', chunk => {
		buffer += chunk;
		let idx;
		while ((idx = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (!line) continue;
			handle(line);
		}
	});
	process.stdin.on('end', () => process.exit(0));
	console.log(JSON.stringify({ ready: true, notice: 'MCP bridge ready; send JSON lines {id, method, params}', logLevel: LOG_LEVEL, testMode: TEST_MODE }));
}

module.exports = { methods };
