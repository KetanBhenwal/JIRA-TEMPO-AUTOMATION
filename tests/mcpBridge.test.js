const { spawn } = require('child_process');

function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    function handle(data) {
      data.toString().split('\n').forEach(line => {
        if (!line.trim()) return;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout.off('data', handle);
            if (msg.error) return reject(new Error(msg.error.message));
            resolve(msg.result);
          }
        } catch (_) {}
      });
    }
    proc.stdout.on('data', handle);
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

describe('MCP Bridge (TEST_MODE)', () => {
  let proc;
  beforeAll(done => {
    proc = spawn('node', ['mcpBridge.js'], { env: { ...process.env, MCP_TEST_MODE: 'true', MCP_LOG_LEVEL: 'error' } });
    proc.stdout.once('data', () => done());
  });
  afterAll(() => proc.kill());

  test('agent.status returns running flag (may be false initially)', async () => {
    const status = await rpc(proc, 1, 'agent.status');
    expect(status).toHaveProperty('running');
  });

  test('agent.start transitions to running', async () => {
    const result = await rpc(proc, 2, 'agent.start');
    expect(result.running).toBe(true);
  });

  test('jira.searchIssues returns mock issue list in test mode', async () => {
    const result = await rpc(proc, 3, 'jira.searchIssues', { jql: 'assignee = currentUser()' });
    expect(Array.isArray(result.issues)).toBe(true);
    expect(result.issues[0].key).toMatch(/TEST-SEARCH/);
  });

  test('jira.issue.get returns mock issue', async () => {
    const issue = await rpc(proc, 4, 'jira.issue.get', { issueKey: 'ABC-1' });
    expect(issue.key).toBe('ABC-1');
  });

  test('agent.sessions.list returns an array', async () => {
    const sessions = await rpc(proc, 5, 'agent.sessions.list', { days: 1 });
    expect(Array.isArray(sessions)).toBe(true);
  });
});
