#!/usr/bin/env node

const AITimeTrackingAgent = require('./ai-agent');

class AIAgentDaemon {
  constructor() {
    this.agent = new AITimeTrackingAgent();
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      console.log('AI Agent daemon is already running');
      return;
    }

    try {
      await this.agent.start();
      this.isRunning = true;
      
      const isTestMode = process.env.AI_AGENT_TEST_MODE === 'true';
      const isDryRun = process.env.AI_AGENT_DRY_RUN === 'true';
      
      if (isTestMode) {
        console.log('� AI Time Tracking Agent TEST MODE started');
        console.log('⚡ FAST INTERVALS: Monitor every 30s, Auto-log after 2min');
        console.log('🔍 ENHANCED LOGGING: Detailed error information');
        if (isDryRun) {
          console.log('🔒 DRY RUN: Will not actually log time to Tempo');
        } else {
          console.log('⚠️  LIVE MODE: Time WILL be logged to Tempo');
        }
        console.log('📝 Test logs at: ai-agent-test.log');
        console.log('💾 Test data at: ai-agent-test-data.json');
      } else {
        console.log('�🤖 AI Time Tracking Agent Daemon started');
        console.log('📊 Monitoring your work activity...');
        console.log('🕒 Auto-logging time to JIRA Tempo when confident');
        console.log('📝 Check logs at: ai-agent.log');
        console.log('💾 Data stored at: ai-agent-data.json');
      }
      
      console.log('\nPress Ctrl+C to stop the daemon\n');

      // Keep the process running
      this.setupMonitoring();
      
    } catch (error) {
      console.error('❌ Failed to start AI Agent daemon:', error.message);
      process.exit(1);
    }
  }

  setupMonitoring() {
    const isTestMode = process.env.AI_AGENT_TEST_MODE === 'true';
    const interval = isTestMode ? 2 * 60 * 1000 : 30 * 60 * 1000; // 2 minutes vs 30 minutes
    
    // Print status more frequently in test mode
    setInterval(async () => {
      const status = this.agent.getStatus();
      console.log(`\n📊 Status Update: ${new Date().toLocaleTimeString()}`);
      if (isTestMode) {
        console.log(`   🧪 TEST MODE - Dry Run: ${status.isDryRun ? 'YES' : 'NO'}`);
      }
      console.log(`   Current Session: ${status.currentSession ? 
        `${status.currentSession.duration} on ${status.currentSession.detectedIssue || 'Unknown'} (${status.currentSession.confidence}% confidence)` : 
        'No active session'}`);
      console.log(`   Total Sessions: ${status.totalSessions} | Logged: ${status.loggedSessions} | Pending: ${status.pendingSessions}`);
    }, interval);

    // Daily summary (or test summary)
    const summaryInterval = isTestMode ? 5 * 60 * 1000 : 24 * 60 * 60 * 1000; // 5 minutes vs 24 hours
    setInterval(async () => {
      await this.printDailySummary();
    }, summaryInterval);
  }

  async printDailySummary() {
    const sessions = await this.agent.getSessionHistory(1); // Last 1 day
    const totalTime = sessions.reduce((sum, session) => sum + session.duration, 0);
    const loggedTime = sessions
      .filter(session => this.agent.loggedSessions.has(session.id))
      .reduce((sum, session) => sum + session.duration, 0);

    console.log('\n📊 Daily Summary');
    console.log('================');
    console.log(`Total work time detected: ${this.agent.formatDuration(totalTime)}`);
    console.log(`Time auto-logged to JIRA: ${this.agent.formatDuration(loggedTime)}`);
    console.log(`Sessions today: ${sessions.length}`);
    console.log(`Pending review: ${sessions.filter(s => !this.agent.loggedSessions.has(s.id) && s.detectedIssue).length}`);
  }

  async stop() {
    if (!this.isRunning) {
      console.log('AI Agent daemon is not running');
      return;
    }

    console.log('\n🛑 Stopping AI Agent daemon...');
    await this.agent.stop();
    this.isRunning = false;
    console.log('✅ AI Agent daemon stopped');
  }
}

// CLI interface
const command = process.argv[2];
const daemon = new AIAgentDaemon();

switch (command) {
  case 'start':
    daemon.start();
    break;
    
  case 'stop':
    // For proper stop, you'd need IPC or PID file management
    console.log('To stop the daemon, use Ctrl+C in the running terminal');
    break;
    
  case 'status':
    // Quick status check
    const agent = new AITimeTrackingAgent();
    agent.loadData().then(() => {
      const status = agent.getStatus();
      console.log('\n📊 AI Agent Status');
      console.log('==================');
      console.log(`Running: ${status.isRunning ? '✅ Yes' : '❌ No'}`);
      if (status.isTestMode) {
        console.log(`Mode: 🧪 TEST MODE (Dry Run: ${status.isDryRun ? 'YES' : 'NO'})`);
        console.log(`Config: Monitor every ${status.config.monitoringInterval}s, Auto-log after ${status.config.autoLogThreshold}s`);
      } else {
        console.log(`Mode: 🚀 PRODUCTION MODE`);
        console.log(`Config: Monitor every ${status.config.monitoringInterval/60}min, Auto-log after ${status.config.autoLogThreshold/3600}h`);
      }
      console.log(`Total Sessions: ${status.totalSessions}`);
      console.log(`Logged Sessions: ${status.loggedSessions}`);
      console.log(`Pending Sessions: ${status.pendingSessions}`);
      console.log(`Assigned Issues: ${status.assignedIssues}`);
    });
    break;
    
  default:
    console.log(`
🤖 AI Time Tracking Agent Daemon

Usage: node ai-agent-daemon.js <command>

Commands:
  start     Start the AI agent daemon
  stop      Instructions to stop the daemon  
  status    Show current status

Examples:
  node ai-agent-daemon.js start
  node ai-agent-daemon.js status

The daemon will:
- Monitor your work activity in the background
- Detect which JIRA issues you're working on
- Automatically log time to Tempo when confident
- Save sessions for manual review when uncertain

Configuration is loaded from your .env file.
    `);
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await daemon.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await daemon.stop();
  process.exit(0);
});