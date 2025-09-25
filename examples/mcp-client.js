// Example MCP client interacting with mcpBridge.js via child process
// Usage: node examples/mcp-client.js


const { spawn } = require('child_process');
const colors = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m'
};
function logInfo(...args) {
  console.log(`${colors.cyan}[MCP-CLIENT][${new Date().toLocaleTimeString()}]${colors.reset}`, ...args);
}
function logSuccess(...args) {
  console.log(`${colors.green}[MCP-CLIENT][${new Date().toLocaleTimeString()}]${colors.reset}`, ...args);
}
function logWarn(...args) {
  console.warn(`${colors.yellow}[MCP-CLIENT][${new Date().toLocaleTimeString()}]${colors.reset}`, ...args);
}
function logError(...args) {
  console.error(`${colors.red}[MCP-CLIENT][${new Date().toLocaleTimeString()}]${colors.reset}`, ...args);
}

function call(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    logInfo(`→ [${id}] Request: ${method}${params ? ' ' + JSON.stringify(params) : ''}`);
    function onData(line) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === id) {
          proc.stdout.off('data', handler);
          const ms = Date.now() - start;
          if (msg.error) {
            logError(`← [${id}] Error: ${msg.error.message || 'Unknown MCP error'} (${ms}ms)`);
            return reject(new Error(msg.error.message || 'Unknown MCP error'));
          }
          logSuccess(`← [${id}] Response (${ms}ms):`, msg.result);
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
  logInfo('Spawning MCP bridge process...');
  const proc = spawn('node', ['mcpBridge.js']);
  proc.stderr.on('data', d => process.stderr.write(`${colors.magenta}[MCP-BRIDGE-STDERR]${colors.reset} ${d}`));
  // Wait a moment for ready line
  await new Promise(r => setTimeout(r, 300));

  try {
    const status = await call(proc, 1, 'agent.status');
    logInfo('Agent status:', status);
    const start = await call(proc, 2, 'agent.start');
    logInfo('Started:', start.running);
    // const sessions = await call(proc, 3, 'agent.sessions.list', { days: 1 });
    // logInfo('Sessions (last day):', sessions.length);
    const search = await call(proc, 4, 'jira.searchIssues', { jql: 'assignee = currentUser() ORDER BY updated DESC', maxResults: 5 });
    logInfo('Issue search keys:', (search.issues || []).map(i => i.key));
  } catch (e) {
    logError('MCP client error:', e.message);
  } finally {
    logWarn('Killing MCP bridge process.');
    proc.kill();
  }
}

run();
