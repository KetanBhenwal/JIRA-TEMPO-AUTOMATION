// Example MCP client interacting with mcpBridge.js via child process
// Usage: node examples/mcp-client.js

const { spawn } = require('child_process');

function call(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    function onData(line) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) {
          proc.stdout.off('data', handler);
          if (msg.error) return reject(new Error(msg.error.message || 'Unknown MCP error'));
          resolve(msg.result);
        }
      } catch (_) {}
    }
    const handler = (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(l => l.trim() && onData(l.trim()));
    };
    proc.stdout.on('data', handler);
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

async function run() {
  const proc = spawn('node', ['mcpBridge.js']);
  proc.stderr.on('data', d => process.stderr.write(d));
  // Wait a moment for ready line
  await new Promise(r => setTimeout(r, 300));

  try {
    const status = await call(proc, 1, 'agent.status');
    console.log('Agent status:', status);
    const start = await call(proc, 2, 'agent.start');
    console.log('Started:', start.running);
    const sessions = await call(proc, 3, 'agent.sessions.list', { days: 1 });
    console.log('Sessions (last day):', sessions.length);
    const search = await call(proc, 4, 'jira.searchIssues', { jql: 'assignee = currentUser() ORDER BY updated DESC', maxResults: 5 });
    console.log('Issue search keys:', (search.issues || []).map(i => i.key));
  } catch (e) {
    console.error('MCP client error:', e.message);
  } finally {
    proc.kill();
  }
}

run();
