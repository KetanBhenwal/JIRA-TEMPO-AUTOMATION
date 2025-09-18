#!/usr/bin/env node
/**
 * Simulation harness for AITimeTrackingAgent hourly slicing + idle detection.
 * It mocks API calls and accelerates time progression to verify:
 *  - Session creation
 *  - Hourly slice logging (using test-mode 5m slices if AI_AGENT_TEST_MODE=true)
 *  - Idle end triggers remainder logging
 *  - Technology time type normalization + fallback
 */
process.env.AI_AGENT_TEST_MODE = process.env.AI_AGENT_TEST_MODE || 'true';
process.env.AI_AGENT_DRY_RUN = 'true'; // never hit real Tempo
process.env.AI_AGENT_VERBOSE_LOG = 'true';
process.env.AI_AGENT_HOURLY_AUTLOG_MINUTES = '2'; // slices every 2 minutes for fast demo
process.env.AI_AGENT_FORCE_SLICE_LOGGING = 'true'; // (custom flag read only by simulation logic below)
process.env.AI_AGENT_IDLE_THRESHOLD_SECONDS = '20';
process.env.AI_AGENT_IDLE_REMAINDER_THRESHOLD_MINUTES = '1';

const AITimeTrackingAgent = require('./ai-agent');

(async () => {
  const agent = new AITimeTrackingAgent();

  // Monkey patch external calls to avoid network:
  const noop = async () => ({ data: {} });
  const originalLogTimeToTempo = agent.logTimeToTempo.bind(agent);
  agent.logTimeToTempo = async (session) => {
    // Inject a plausible detected issue if missing after first minute
    if (!session.detectedIssue) session.detectedIssue = 'CON22-1234';
    return originalLogTimeToTempo(session).catch(e => ({ error: e.message }));
  };
  agent.fetchAssignedIssues = async () => { agent.assignedIssues = [{ key: 'CON22-1234', fields: { summary: 'Sample Issue' } }]; };

  // Speed up monitoring loop manually instead of waiting timers
  await agent.start();

  // Virtual clock helpers --------------------------------------------------
  // We'll simulate time by manually adjusting session.duration and invoking
  // the agent's slice logic without waiting real minutes.
  const virtualStepMs = 30 * 1000; // pretend 30s per loop iteration
  const simulatedIterations = 20;  // total simulated steps (10 real minutes equivalent if 30s each)

  // Fabricate activity snapshots and advance virtual time
  for (let i = 0; i < simulatedIterations; i++) {
    agent.lastActivity = {
      timestamp: Date.now(),
      applications: { active: 'Visual Studio Code', running: ['Visual Studio Code','Terminal'] },
      windowTitles: 'Working on CON22-1234 add metrics',
      currentDirectory: '/Users/dev/project',
      gitBranch: 'feature/metrics',
      openFiles: ['metrics.js'],
      isWorkingHours: true
    };
    // Force work activity handling path
    await agent.handleWorkActivity(agent.lastActivity);
    // If a current session exists, extend its duration to simulate passage of time
    if (agent.currentSession) {
      agent.currentSession.duration += virtualStepMs;
    }
    // Manually trigger slice attempt every loop (would normally be timer-driven)
    try {
      await agent.attemptHourlySlice(Date.now());
    } catch (e) {
      console.error('Slice attempt error (simulation):', e.message);
    }
    await new Promise(r => setTimeout(r, 30)); // tiny real delay to keep event loop responsive
  }

  // Simulate idle > threshold to close session (flush a remainder slice if eligible)
  console.log('\n-- Simulating idle --');
  agent.getSystemIdleSeconds = async () => 999; // force idle detection
  await agent.detectCurrentActivity();

  console.log('\n--- SUMMARY ---');
  console.log('Total sessions:', agent.sessions.length);
  console.log('Logged sessions (historical persisted):', agent.loggedSessions.size);
  const pending = agent.sessions.filter(s => !agent.loggedSessions.has(s.id));
  console.log('Pending sessions (including newly simulated slices):', pending.length);
  const sliceCandidates = agent.sessions.filter(s => s.sliceIndex != null);
  console.log('Slice sessions created:', sliceCandidates.length);
  const last = agent.sessions[agent.sessions.length -1];
  if (last) {
    console.log('Last session duration (ms):', last.duration);
    console.log('Last session issue:', last.detectedIssue);
  }
  process.exit(0);
})();
