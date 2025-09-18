// Quick test harness for Microsoft Teams meeting detection logic
// This does not actually invoke AppleScript; it simulates session objects
// and calls detectActivityType + calculateConfidence similarly to runtime.

const AITimeTrackingAgent = require('./ai-agent');

async function run() {
  const agent = new AITimeTrackingAgent();
  // Force test mode style assumptions without relying on env
  agent.isRunning = true;

  function mockSession(appName, windowTitles) {
    return {
      id: 'mock',
      startTime: Date.now() - 5 * 60 * 1000,
      endTime: Date.now(),
      duration: 5 * 60 * 1000,
      detectedIssue: null,
      applications: new Set([appName]),
      windowTitles: new Set(windowTitles),
      directories: new Set(['/Users/test/Projects/demo']),
      gitBranches: new Set(),
      confidence: 0
    };
  }

  const samples = [
    mockSession('Microsoft Teams', ['Weekly Sync Meeting']),
    mockSession('Teams', ['Daily Standup']),
    mockSession('MSTeams', ['Sprint Planning - Q3 Goals']),
    mockSession('Google Chrome', ['Teams Call - Architecture Discussion']),
    mockSession('Zoom', ['Sprint Retro']),
    mockSession('Visual Studio Code', ['README.md - Code Review Meeting']),
  ];

  for (const s of samples) {
    const activityType = agent.detectActivityType(s);
    s.confidence = agent.calculateConfidence({
      applications: { active: [...s.applications][0], running: [...s.applications] },
      windowTitles: [...s.windowTitles][0],
      currentDirectory: '/Users/test/Projects/demo',
      gitBranch: null
    });
    console.log('\n--- Sample ---');
    console.log('Primary App:', [...s.applications][0]);
    console.log('Window Title(s):', [...s.windowTitles].join(' | '));
    console.log('Detected Activity:', activityType);
    console.log('Confidence:', s.confidence + '%');
  }
}

run().catch(e => { console.error(e); process.exit(1); });
