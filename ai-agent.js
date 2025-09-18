const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

// Platform flags
const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

require('dotenv').config();

// Configuration
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const TEMPO_BASE_URL = process.env.TEMPO_BASE_URL;
const TEMPO_API_TOKEN = process.env.TEMPO_API_TOKEN;
const TEMPO_ACCOUNT_ID = process.env.TEMPO_ACCOUNT_ID;

// AI Agent configuration
const AI_AGENT_CONFIG = {
  monitoringInterval: 5 * 60 * 1000, // 5 minutes
  workSessionThreshold: 15 * 60 * 1000, // 15 minutes minimum for a work session
  autoLogThreshold: 1 * 60 * 60 * 1000, // Auto-log after 1 hour of detected work
  maxSessionDuration: 8 * 60 * 60 * 1000, // 8 hours max session
  dataFile: path.join(__dirname, 'ai-agent-data.json'),
  logFile: path.join(__dirname, 'ai-agent.log'),
  workHoursStart: 11, // 11 AM
  workHoursEnd: 20, // 8 PM
  defaultMeetingIssue: 'CON22-2208', // Default issue for Microsoft Teams calls and adhoc meetings
  activeWindowSamplingInterval: 60/2 * 1000, // 30s lightweight foreground window sampling
  enableActiveWindowSampler: true, // Feature flag for new sampler
  runningAppsRefreshInterval: 5 * 60 * 1000, // cache running visible apps for 5m
  enableMeetingMetrics: true, // collect meeting vs dev session metrics
  maxConcurrentExec: 2, // limit concurrent child processes
  maxExecPerMinute: 120, // soft rate limit
  adaptiveEnumeration: true,
  enumerationMinInterval: 60 * 1000, // minimum 1m between full enumerations when adaptive
  enumerationIdleMultiplier: 3, // extend interval when no change
  spawnEagainCooldown: 2 * 60 * 1000, // cool down 2m after EAGAIN
  verboseLogging: process.env.AI_AGENT_VERBOSE_LOG === 'true',
  hourlyAutoLogMinutes: parseInt(process.env.AI_AGENT_HOURLY_AUTLOG_MINUTES || '60', 10), // slice/log every N minutes (default 60)
  enableHourlySlicing: process.env.AI_AGENT_ENABLE_HOURLY_SLICING !== 'false',
  idleThresholdSeconds: parseInt(process.env.AI_AGENT_IDLE_THRESHOLD_SECONDS || '300', 10), // 5m idle ends session
  idleRemainderLogThresholdMinutes: parseInt(process.env.AI_AGENT_IDLE_REMAINDER_THRESHOLD_MINUTES || '5', 10) // log remainder if >= 5m
};

// Test mode configuration - ultra fast intervals for rapid iteration
// (Further reduced for quicker feedback during development)
const AI_AGENT_TEST_CONFIG = {
  monitoringInterval: 10 * 1000, // 10 seconds (was 30s, prod 5m)
  workSessionThreshold: 30 * 1000, // 30 seconds minimum (was 1m, prod 15m)
  autoLogThreshold: 60 * 1000, // Auto-log after 1 minute (was 2m, prod 1h)
  maxSessionDuration: 15 * 60 * 1000, // 15 minutes max (was 30m, prod 8h)
  dataFile: path.join(__dirname, 'ai-agent-test-data.json'),
  logFile: path.join(__dirname, 'ai-agent-test.log'),
  workHoursStart: 0, // Accept any hour in test mode
  workHoursEnd: 24,
  defaultMeetingIssue: 'CON22-2208',
  activeWindowSamplingInterval: 5 * 1000, // 5s sampler (was 15s, prod 30s)
  enableActiveWindowSampler: true,
  runningAppsRefreshInterval: 30 * 1000, // 30s (was 60s, prod 5m)
  enableMeetingMetrics: true,
  maxConcurrentExec: 2,
  maxExecPerMinute: 240,
  adaptiveEnumeration: true,
  enumerationMinInterval: 15 * 1000,
  enumerationIdleMultiplier: 2,
  spawnEagainCooldown: 30 * 1000,
  verboseLogging: true,
  hourlyAutoLogMinutes: 5, // quicker slicing in test mode
  enableHourlySlicing: true,
  idleThresholdSeconds: 30, // very fast idle threshold in test
  idleRemainderLogThresholdMinutes: 1
};

// Determine which config to use
const isTestMode = process.env.AI_AGENT_TEST_MODE === 'true';
const isDryRun = process.env.AI_AGENT_DRY_RUN === 'true';
const meetingDebug = process.env.AI_AGENT_MEETING_DEBUG === 'true';
const CONFIG = isTestMode ? AI_AGENT_TEST_CONFIG : AI_AGENT_CONFIG;
// Runtime overrides (loaded from user-config.json if present)
let RUNTIME_OVERRIDES = {};

function loadRuntimeOverrides() {
  try {
    const p = path.join(__dirname, 'user-config.json');
    if (require('fs').existsSync(p)) {
      const raw = require('fs').readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      RUNTIME_OVERRIDES = parsed || {};
    }
  } catch (e) {
    console.error('Failed to load user-config.json overrides:', e.message);
  }
}
loadRuntimeOverrides();

function getEffectiveConfig() {
  return { ...CONFIG, ...RUNTIME_OVERRIDES };
}

// Work attribute mappings based on actual Tempo API values
const WORK_ATTRIBUTE_MAPPINGS = {
  development: {
    timeCategory: 'Execution',
    technologyTimeType: 'Capitalizable_Writing_Code'
  },
  meetings: {
    timeCategory: 'Meeting-Collaboration',
    technologyTimeTypes: {
      general: 'Capitalizable_Technical Discussion',
      standup: 'Capitalizable_DailyStandup',
      'sprint-planning': 'Capitalizable_Sprint_Planning',
      'code-review': 'Capitalizable_Code_Review',
      'test-case-review': 'Capitalizable_Test_Case_Review_meet',
      'sprint-demo': 'Capitalizable_Sprint_Demo',
      'sprint-retro': 'Capitalizable_Sprint_Retro',
      brainstorming: 'Capitalizable _Brainstorming'
    }
  },
  debugging: {
    timeCategory: 'Debugging',
    technologyTimeType: 'Capitalizable_Debugging _Code'
  },
  testing: {
    timeCategory: 'Execution',
    technologyTimeTypes: {
      writing: 'Capitalizable_Writing_Test_Cases',
      executing: 'Capitalizable_Execute_Test_Cases',
      automation: 'Capitalizable_Write_QA_Automation_Code'
    }
  }
};

// Some environments expose slightly different value forms (camel or without underscores); normalize before sending.
const TECHNOLOGY_TYPE_NORMALIZATION = {
  'Capitalizable_Writing_Code': 'Capitalizable_Writing_Code',
  'CapitalizableWritingCode': 'Capitalizable_Writing_Code',
  'Capitalizable_Technical Discussion': 'Capitalizable_Technical Discussion',
  'CapitalizableTechnicalDiscussion': 'Capitalizable_Technical Discussion',
  'Capitalizable_DailyStandup': 'Capitalizable_DailyStandup',
  'CapitalizableDailyStandup': 'Capitalizable_DailyStandup',
  'Capitalizable_Sprint_Planning': 'Capitalizable_Sprint_Planning',
  'CapitalizableSprintPlanning': 'Capitalizable_Sprint_Planning',
  'Capitalizable_Sprint_Demo': 'Capitalizable_Sprint_Demo',
  'CapitalizableSprintDemo': 'Capitalizable_Sprint_Demo',
  'Capitalizable_Sprint_Retro': 'Capitalizable_Sprint_Retro',
  'CapitalizableSprintRetro': 'Capitalizable_Sprint_Retro',
  'Capitalizable_Code_Review': 'Capitalizable_Code_Review',
  'CapitalizableCodeReview': 'Capitalizable_Code_Review',
  'Capitalizable_Debugging _Code': 'Capitalizable_Debugging _Code',
  'CapitalizableDebuggingCode': 'Capitalizable_Debugging _Code',
  'Capitalizable_Writing_Test_Cases': 'Capitalizable_Writing_Test_Cases',
  'CapitalizableWritingTestCases': 'Capitalizable_Writing_Test_Cases',
  'Capitalizable_Execute_Test_Cases': 'Capitalizable_Execute_Test_Cases',
  'CapitalizableExecuteTestCases': 'Capitalizable_Execute_Test_Cases'
};

// Create API clients
const jiraApi = axios.create({
  baseURL: JIRA_BASE_URL,
  headers: {
    Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

const tempoApi = axios.create({
  baseURL: TEMPO_BASE_URL,
  headers: {
    Authorization: `Bearer ${TEMPO_API_TOKEN}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

class AITimeTrackingAgent {
  constructor() {
    this.isRunning = false;
    this.currentSession = null;
    this.sessions = [];
    this.activeApplications = new Map();
    this.lastActivity = null;
    this.loggedSessions = new Set();
    this.issueKeywordMap = new Map();
    this.assignedIssues = [];
  // Active applications caching (to avoid repeated heavy AppleScript enumeration)
  this._runningAppsCache = { list: [], lastUpdated: 0 };
  this._activeAppScriptInFlight = false;
  this._lastActiveAppErrorAt = 0; // to throttle repeated timeout logs
    // Failure / metrics tracking
    this._metrics = {
      activeAppTimeouts: 0,
      runningAppsFailures: 0,
      lastReset: Date.now(),
      backoff: {
        runningAppsDelay: 0, // current added backoff ms
        failures: 0,         // consecutive failures counter
        maxDelay: 10 * 60 * 1000 // 10m cap
      },
      meetings: {
        sessions: 0,
        byType: {},
        lastSummaryLog: 0
      },
      runningAppsFallbacks: {
        applescriptVariant2: 0,
        lsappinfo: 0,
        psParsing: 0,
        lastStrategy: null
      },
      performance: {
        execInFlight: 0,
        execStarted: 0,
        execCompleted: 0,
        execThrottled: 0,
        lastMinuteWindow: Date.now(),
        lastMinuteCount: 0,
        spawnEagainEvents: 0,
        lastSpawnEagainAt: 0,
        avgExecMs: 0
      }
    };
    this._execQueue = [];
    this._execTimer = null;
    // New: micro event buffer for high-frequency window samples (only kept in-memory per session)
    this.activeWindowSamplerTimer = null;
  // Hourly slicing tracking
  this._sliceMetrics = { slicesLogged: 0 };
    
    // Initialize logging
    this.setupLogging();
    // Reconciliation tracking
    this.lastReconciliation = null;
    this.lastReconciliationSummary = null;
    this.reconciliationTimer = null;
    this._effectiveConfig = getEffectiveConfig();

    // Activity trace logging (lightweight structured JSON lines for external analysis)
    this._activityTraceEnabled = process.env.AI_AGENT_ACTIVITY_TRACE === 'true';
    this._activityTraceFile = process.env.AI_AGENT_ACTIVITY_TRACE_FILE || path.join(__dirname, 'ai-agent-activity-trace.log');
    this._activityTraceQueue = [];
    this._activityTraceFlushTimer = null;
  }

  async setupLogging() {
    const mode = isTestMode ? '🧪 TEST MODE' : '🚀 PRODUCTION MODE';
    const dryRun = isDryRun ? ' (DRY RUN - NO ACTUAL LOGGING)' : '';
    await this.log(`${mode}${dryRun} - AI Time Tracking Agent initialized`);
    
    if (isTestMode) {
  const cfg = this.effectiveConfig;
  const monitorSec = Math.round(cfg.monitoringInterval/1000);
  const autoLogMin = (cfg.autoLogThreshold/1000/60).toFixed(2).replace(/\.00$/, '');
  const workSessionSec = Math.round(cfg.workSessionThreshold/1000);
      await this.log(`⚡ FAST INTERVALS: Monitor every ${monitorSec}s, Work session min ${workSessionSec}s, Auto-log after ${autoLogMin}min`);
      await this.log('🔍 ENHANCED LOGGING: Detailed error information enabled');
      if (isDryRun) {
        await this.log('🔒 DRY RUN MODE: Will not actually log time to Tempo');
      }
      if (meetingDebug) {
        await this.log('🩺 MEETING DEBUG ENABLED: Extra logging for meeting detection, apps, window titles');
      }
    }
    // Schedule reconciliation after initial logging setup
    this.scheduleReconciliation();
  }

  async log(message, force = false) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    // Honor verbose flag unless forced
    if (CONFIG.verboseLogging || force) {
      console.log(logMessage.trim());
    }
    
    try {
      await fs.appendFile(AI_AGENT_CONFIG.logFile, logMessage);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  // ---- Activity Trace Logging ---------------------------------------------
  _enqueueActivityTrace(record) {
    if (!this._activityTraceEnabled) return;
    // Attach monotonic sequence
    if (!this._activitySeq) this._activitySeq = 0;
    record.seq = ++this._activitySeq;
    record.ts = Date.now();
    this._activityTraceQueue.push(record);
    if (this._activityTraceQueue.length >= 50) {
      this._flushActivityTrace();
    } else if (!this._activityTraceFlushTimer) {
      this._activityTraceFlushTimer = setTimeout(() => {
        this._activityTraceFlushTimer = null;
        this._flushActivityTrace();
      }, 2000);
    }
  }

  async _flushActivityTrace() {
    if (!this._activityTraceEnabled) return;
    if (!this._activityTraceQueue.length) return;
    const batch = this._activityTraceQueue.splice(0, this._activityTraceQueue.length);
    const lines = batch.map(r => JSON.stringify(r)).join('\n') + '\n';
    try {
      await fs.appendFile(this._activityTraceFile, lines);
    } catch (e) {
      console.error('Activity trace write failed:', e.message);
      // disable further attempts if persistent
      this._activityTraceEnabled = false;
    }
  }

  async flushAndStopActivityTrace() {
    if (this._activityTraceFlushTimer) {
      clearTimeout(this._activityTraceFlushTimer);
      this._activityTraceFlushTimer = null;
    }
    await this._flushActivityTrace();
  }

  // Centralized exec with concurrency + rate limiting
  async limitedExec(command) {
    return new Promise((resolve, reject) => {
      const task = { command, resolve, reject, enqueued: Date.now() };
      this._execQueue.push(task);
      this._drainExecQueue();
    });
  }

  _drainExecQueue() {
    const perf = this._metrics.performance;
    // Reset minute window
    const now = Date.now();
    if (now - perf.lastMinuteWindow > 60 * 1000) {
      perf.lastMinuteWindow = now;
      perf.lastMinuteCount = 0;
    }
    while (this._execQueue.length && perf.execInFlight < CONFIG.maxConcurrentExec) {
      if (perf.lastMinuteCount >= CONFIG.maxExecPerMinute) {
        // Throttle: schedule next drain
        perf.execThrottled++;
        if (!this._execTimer) {
          this._execTimer = setTimeout(() => { this._execTimer = null; this._drainExecQueue(); }, 500);
        }
        return;
      }
      const task = this._execQueue.shift();
      perf.execInFlight++;
      perf.execStarted++;
      perf.lastMinuteCount++;
      const start = Date.now();
      execAsync(task.command).then(res => {
        const dur = Date.now() - start;
        // EMA for avgExecMs
        perf.avgExecMs = perf.avgExecMs === 0 ? dur : Math.round(perf.avgExecMs * 0.9 + dur * 0.1);
        perf.execCompleted++;
        perf.execInFlight--;
        task.resolve(res);
        this._drainExecQueue();
      }).catch(err => {
        if (/EAGAIN/.test(err.message)) {
          perf.spawnEagainEvents++;
          perf.lastSpawnEagainAt = Date.now();
        }
        perf.execInFlight--;
        task.reject(err);
        this._drainExecQueue();
      });
    }
  }

  async start() {
    if (this.isRunning) {
      await this.log('⚠️ Agent is already running');
      return;
    }

    // Optional reset: remove persisted data & logs for a truly fresh start
    if (process.env.AI_AGENT_RESET === 'true') {
      try {
        const targets = [CONFIG.dataFile, AI_AGENT_CONFIG.logFile, path.join(__dirname,'ai-agent-test-data.json'), path.join(__dirname,'ai-agent-test.log')];
        for (const f of targets) {
          try { await fs.unlink(f); await this.log(`🧹 Reset removed ${path.basename(f)}`); } catch(_) {}
        }
        await this.log('🧨 AI_AGENT_RESET applied – data & logs cleared');
      } catch (e) {
        await this.log('⚠️ Reset encountered an error: '+ e.message);
      }
    }

    this.isRunning = true;
    const mode = isTestMode ? '🧪 Starting AI Agent in TEST MODE' : '🚀 Starting AI Time Tracking Agent';
    await this.log(`${mode}...`);
    
    const intervals = {
  monitor: this.effectiveConfig.monitoringInterval/1000/60,
  workSession: this.effectiveConfig.workSessionThreshold/1000/60, 
  autoLog: this.effectiveConfig.autoLogThreshold/1000/60/60
    };
    
    if (isTestMode) {
      await this.log(`🔧 TEST Configuration: Monitor every ${intervals.monitor}min, Work session min ${intervals.workSession}min, Auto-log after ${intervals.autoLog*60}min`);
    } else {
      await this.log(`🔧 Configuration: Monitor every ${intervals.monitor}min, Work session min ${intervals.workSession}min, Auto-log after ${intervals.autoLog}h`);
    }
    
    // Load existing data
    await this.loadData();

    // Apply env override for running apps refresh interval if provided
    const overrideMs = parseInt(process.env.AI_AGENT_RUNNING_APPS_REFRESH_MS, 10);
    if (!isNaN(overrideMs) && overrideMs > 5000) { // minimum sane limit 5s
      CONFIG.runningAppsRefreshInterval = overrideMs;
      await this.log(`⚙️ Overridden runningAppsRefreshInterval via env: ${overrideMs}ms`);
    }
    
    // Test connections in test mode
    if (isTestMode) {
      await this.testConnections();
    }
    
    // Fetch assigned issues for context
    await this.fetchAssignedIssues();
    
    // Start monitoring
    await this.log('🔍 Starting activity monitoring loop...');
    this.startMonitoring();
    // Start lightweight foreground window sampler (independent higher frequency)
    if (CONFIG.enableActiveWindowSampler) {
      this.startActiveWindowSampler();
    } else {
      await this.log('🧪 Active window sampler disabled via config flag');
    }
    
    await this.log('✅ AI Agent started successfully');
  }

  /* ---------------------------------------------
   * Active Window Sampler (High-frequency, lightweight)
   * ---------------------------------------------
   * Captures app + window title + (optional) browser URL every N seconds.
   * Feeds additional context into current session to improve issue detection
   * and confidence without waiting for the heavier monitoring loop.
   */
  startActiveWindowSampler() {
    if (this.activeWindowSamplerTimer) {
      return; // Already running
    }
    this.log(`🪟 Starting active window sampler @ ${(CONFIG.activeWindowSamplingInterval/1000)}s interval`);
    let lastFingerprint = null;

    const sample = async () => {
      if (!this.isRunning) {
        return; // Will not reschedule
      }
      try {
  const appInfo = await this.getActiveApplications();
        const title = await this.getActiveWindowTitles();
        let browserUrl = null;
        let urlHost = null;

        // Only attempt browser URL if active app is a known browser
        const browserApps = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Safari'];
        if (browserApps.some(b => appInfo.active.includes(b))) {
          browserUrl = await this.getActiveBrowserUrl();
          if (browserUrl) {
            try { urlHost = new URL(browserUrl).host; } catch(_) {}
          }
        }

        if (meetingDebug) {
          this.log(`🩺 [Sampler] Active='${appInfo.active}' Title='${(title||'').slice(0,80)}' RunningCount=${appInfo.running.length}`);
        }
        const fingerprint = `${appInfo.active}::${title}::${browserUrl || ''}`;
        if (fingerprint === lastFingerprint) {
          // No material change; skip heavy processing
          this.scheduleNextSample(sample);
          return;
        }
        lastFingerprint = fingerprint;

        const jiraKeyPattern = /([A-Z]+-\d+)/g;
        let jiraKey = null;
        const sourceHints = [];
        // Window title key
        const titleMatches = title.match(jiraKeyPattern);
        if (titleMatches && titleMatches.length) {
          jiraKey = titleMatches[0];
          sourceHints.push('title');
        }
        // Browser URL key
        if (!jiraKey && browserUrl) {
          const urlMatches = browserUrl.match(jiraKeyPattern);
          if (urlMatches && urlMatches.length) {
            jiraKey = urlMatches[0];
            sourceHints.push('url');
          }
        }

        const microEvent = {
          t: Date.now(),
          app: appInfo.active,
          title: title ? title.substring(0, 180) : '',
          browser: browserUrl ? { host: urlHost, isJira: !!(browserUrl && /jira/i.test(browserUrl)), hasKey: !!jiraKey } : null,
            // Only retain host + flags, not full URL for privacy.
          jiraKey: jiraKey || null,
          source: sourceHints.join('+') || null
        };

        // Attach to current session if present
        if (this.currentSession) {
            if (!this.currentSession.microEvents) {
              this.currentSession.microEvents = [];
            }
            this.currentSession.microEvents.push(microEvent);
            // Bound size to avoid unbounded growth
            if (this.currentSession.microEvents.length > 200) {
              this.currentSession.microEvents.shift();
            }
            // Opportunistic issue upgrade if we got a new jiraKey from URL with high certainty
            if (jiraKey && (!this.currentSession.detectedIssue || this.currentSession.detectedIssue !== jiraKey)) {
              // Prefer keys belonging to assigned issues
              const isAssigned = this.assignedIssues.some(i => i.key === jiraKey);
              if (isAssigned) {
                const prevIssue = this.currentSession.detectedIssue;
                this.currentSession.detectedIssue = jiraKey;
                // Temporary bump; final confidence recalculated later
                this.currentSession.confidence = Math.max(this.currentSession.confidence, 70);
                this.log(`🔁 Session issue refined via sampler: ${prevIssue || 'none'} -> ${jiraKey} (source: ${microEvent.source})`);
              }
            }
        }

      } catch (err) {
        this.log(`⚠️ Active window sampler error: ${err.message}`);
      } finally {
        this.scheduleNextSample(sample);
      }
    };

    // Kick off first sample
    sample();
  }

  scheduleNextSample(fn) {
    if (!this.isRunning) return;
    this.activeWindowSamplerTimer = setTimeout(fn, CONFIG.activeWindowSamplingInterval);
  }

  stopActiveWindowSampler() {
    if (this.activeWindowSamplerTimer) {
      clearTimeout(this.activeWindowSamplerTimer);
      this.activeWindowSamplerTimer = null;
      this.log('🛑 Active window sampler stopped');
    }
  }

  async getActiveBrowserUrl() {
    // Currently only macOS implementation (AppleScript). Windows: TODO (Edge / Chrome remote debugging optional)
    if (!IS_MAC) return null;
    const scripts = [
      { name: 'Google Chrome', script: 'tell application "Google Chrome" to if (count of windows) > 0 then get URL of active tab of front window' },
      { name: 'Brave Browser', script: 'tell application "Brave Browser" to if (count of windows) > 0 then get URL of active tab of front window' },
      { name: 'Microsoft Edge', script: 'tell application "Microsoft Edge" to if (count of windows) > 0 then get URL of active tab of front window' },
      { name: 'Safari', script: 'tell application "Safari" to if (count of windows) > 0 then get URL of front document' }
    ];
    for (const b of scripts) {
      try {
        const { stdout } = await execAsync(`osascript -e '${b.script}'`);
        const url = stdout.trim();
        if (url && /^https?:\/\//.test(url)) {
          if (/jira/i.test(url)) {
            this.log(`🌐 Active browser JIRA URL detected (${b.name})`);
          }
          return url;
        }
      } catch (_) {}
    }
    return null;
  }

  async stop() {
    if (!this.isRunning) {
      await this.log('⚠️ Agent is not running');
      return;
    }

    await this.log('🛑 Stopping AI Time Tracking Agent...');
    this.isRunning = false;
    
    // End current session if active
    if (this.currentSession) {
      await this.log('📏 Ending current session before shutdown...');
      await this.endSession();
    }
    
    // Save data
    await this.saveData();
    
    await this.log('✅ AI Time Tracking Agent stopped successfully');
  }

  async loadData() {
    await this.log('🔄 Loading agent data from file...');
    try {
      const data = await fs.readFile(CONFIG.dataFile, 'utf8');
      const parsedData = JSON.parse(data);
      
      this.sessions = parsedData.sessions || [];
      this.loggedSessions = new Set(parsedData.loggedSessions || []);
      this.issueKeywordMap = new Map(parsedData.issueKeywordMap || []);
      
      await this.log(`✅ Loaded ${this.sessions.length} previous sessions, ${this.loggedSessions.size} logged sessions, ${this.issueKeywordMap.size} keyword mappings`);
    } catch (error) {
      await this.log(`ℹ️ No existing data file found, starting fresh: ${error.message}`);
    }
  }

  async saveData() {
    await this.log('💾 Saving agent data to file...');
    try {
      const data = {
        sessions: this.sessions,
        loggedSessions: Array.from(this.loggedSessions),
        issueKeywordMap: Array.from(this.issueKeywordMap.entries()),
        lastSaved: new Date().toISOString(),
        isTestMode: isTestMode,
        isDryRun: isDryRun
      };
      
      await fs.writeFile(CONFIG.dataFile, JSON.stringify(data, null, 2));
      await this.log(`✅ Data saved successfully: ${this.sessions.length} sessions, ${this.loggedSessions.size} logged sessions`);
    } catch (error) {
      await this.log(`❌ Failed to save data: ${error.message}`);
    }
  }

  async testConnections() {
    await this.log('🔧 Testing connections in test mode...');
    
    try {
      // Test JIRA connection
      await this.log('🔍 Testing JIRA API connection...');
      const jiraTest = await jiraApi.get('/rest/api/3/myself');
      await this.log(`✅ JIRA connection successful: ${jiraTest.data.displayName} (${jiraTest.data.emailAddress})`);
    } catch (error) {
      await this.log(`❌ JIRA connection failed: ${error.message}`);
      if (error.response) {
        await this.log(`   Status: ${error.response.status}, Details: ${JSON.stringify(error.response.data)}`);
      }
    }
    
    try {
      // Test Tempo connection  
      await this.log('🔍 Testing Tempo API connection...');
      const tempoTest = await tempoApi.get('/worklogs', {
        params: {
          from: new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0],
          to: new Date().toISOString().split('T')[0],
          worker: [TEMPO_ACCOUNT_ID]
        }
      });
      await this.log(`✅ Tempo connection successful: Found ${tempoTest.data.results?.length || 0} recent worklogs`);
    } catch (error) {
      await this.log(`❌ Tempo connection failed: ${error.message}`);
      if (error.response) {
        await this.log(`   Status: ${error.response.status}, Details: ${JSON.stringify(error.response.data)}`);
      }
    }
  }

  async fetchAssignedIssues() {
    await this.log('📋 Fetching assigned JIRA issues...');
    try {
      const response = await jiraApi.post('/rest/api/3/search/jql', {
        jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
        fields: ['key','summary','status','project'],
        maxResults: 50
      });

      this.assignedIssues = response.data.issues || [];
      
      // Build keyword map for issue detection
      let totalKeywords = 0;
      this.assignedIssues.forEach(issue => {
        const keywords = this.extractKeywords(issue.fields.summary);
        keywords.forEach(keyword => {
          if (!this.issueKeywordMap.has(keyword)) {
            this.issueKeywordMap.set(keyword, []);
          }
          this.issueKeywordMap.get(keyword).push(issue.key);
          totalKeywords++;
        });
      });

      await this.log(`✅ Fetched ${this.assignedIssues.length} assigned issues, extracted ${totalKeywords} keywords for detection`);
    } catch (error) {
      await this.log(`❌ Failed to fetch assigned issues: ${error.message}`);
    }
  }

  extractKeywords(text) {
    // Extract meaningful keywords from issue summary
    const words = text.toLowerCase()
      .split(/[\s\-\_\(\)\[\]]+/)
      .filter(word => word.length > 3)
      .filter(word => !['the', 'and', 'for', 'with', 'from', 'this', 'that', 'will', 'have', 'been', 'were', 'are'].includes(word));
    
    return [...new Set(words)];
  }

  startMonitoring() {
    let monitoringCycle = 0;
    
    const monitoringLoop = async () => {
      if (!this.isRunning) {
        await this.log('🛑 Monitoring loop stopped - agent not running');
        return;
      }

      monitoringCycle++;
      
      // Log monitoring cycle every 10 cycles (50 minutes by default)
      if (monitoringCycle % 10 === 0) {
        await this.log(`🔁 Monitoring cycle #${monitoringCycle} - Agent running for ${this.formatDuration(Date.now() - this.startTime)}`);
      }

      try {
        await this.detectCurrentActivity();
        await this.processActivity();
        await this.autoLogCompletedSessions();
      } catch (error) {
        await this.log(`❌ Error in monitoring loop (cycle #${monitoringCycle}): ${error.message}`);
        console.error('Monitoring error details:', error);
      }

      // Schedule next check
  setTimeout(monitoringLoop, this.effectiveConfig.monitoringInterval);
    };

    // Record start time for uptime tracking
    this.startTime = Date.now();
    
    // Start the monitoring loop
    monitoringLoop();
  }

  async detectCurrentActivity() {
    await this.log('🔍 Detecting current activity...');
    // Check idle first – if user idle beyond threshold, treat as idle even before collecting heavy data
    const idleSeconds = await this.getSystemIdleSeconds().catch(()=>0);
    const idleTooLong = idleSeconds >= this.effectiveConfig.idleThresholdSeconds;
    if (idleTooLong && this.currentSession) {
      await this.log(`⏸️ System idle ${idleSeconds}s >= threshold ${this.effectiveConfig.idleThresholdSeconds}s -> ending session`);
      await this.endSession();
      return; // skip new activity snapshot until next cycle
    }
    const activity = {
      timestamp: Date.now(),
      applications: await this.getActiveApplications(),
      windowTitles: await this.getActiveWindowTitles(),
      currentDirectory: await this.getCurrentDirectory(),
      gitBranch: await this.getCurrentGitBranch(),
      openFiles: await this.getOpenFiles(),
      isWorkingHours: this.isWorkingHours()
    };

    this.lastActivity = activity;
    
    const isWork = this.isWorkActivity(activity);
    await this.log(`📊 Activity detected - App: ${activity.applications.active}, Working Hours: ${activity.isWorkingHours}, Work Activity: ${isWork}`);
    
    // Detect if this is development/work activity
    if (isWork) {
      await this.handleWorkActivity(activity);
    } else {
      await this.handleIdleActivity();
    }
  }

  async getActiveApplications() {
    // Strategy:
    // 1. Lightweight AppleScript to get ONLY frontmost app (fast, less error prone)
    // 2. Refresh full visible apps list at most every runningAppsRefreshInterval
    // 3. If enumeration fails, reuse cached running list
    const now = Date.now();
    const refreshNeeded = (now - this._runningAppsCache.lastUpdated) > CONFIG.runningAppsRefreshInterval;
    let activeApp = 'unknown';
    if (IS_WINDOWS) {
      try {
        const ps = 'powershell -NoProfile -Command "Add-Type -Namespace Win32 -Name User32 -MemberDefinition \"[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport(\\\"user32.dll\\\")] public static extern int GetWindowThreadProcessId(IntPtr h,out int pid);\"; $h=[Win32.User32]::GetForegroundWindow(); $pid=0; [Win32.User32]::GetWindowThreadProcessId($h,[ref]$pid) | Out-Null; (Get-Process -Id $pid).ProcessName"';
        const { stdout } = await execAsync(ps);
        const name = stdout.trim();
        if (name) activeApp = name;
      } catch (_) {}
    } else if (IS_MAC) {
      // Lightweight frontmost query (guard against overlapping calls)
      if (!this._activeAppScriptInFlight) {
        this._activeAppScriptInFlight = true;
        try {
          const now2 = Date.now();
            const skipDueToEagain = (now2 - this._metrics.performance.lastSpawnEagainAt) < CONFIG.spawnEagainCooldown;
            const cached = this.lastActivity?.applications?.active || this._lastKnownActiveApp;
            const canSkip = skipDueToEagain && cached && cached !== 'unknown';
            if (canSkip) {
              activeApp = cached;
            } else {
              let resolved = false;
              try {
                const script = `osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'return frontApp'`;
                const { stdout } = await this.limitedExec(script);
                const cand = stdout.trim();
                if (cand) { activeApp = cand; resolved = true; }
              } catch (appleErr) {
                if (/EAGAIN/.test(appleErr.message)) {
                  this._metrics.performance.spawnEagainEvents++;
                  this._metrics.performance.lastSpawnEagainAt = Date.now();
                }
                if (/(-1712|timed out)/i.test(appleErr.message)) {
                  this._metrics.activeAppTimeouts++;
                }
              }
              if (!resolved) {
                try {
                  const { stdout: lsOut } = await this.limitedExec('lsappinfo front');
                  const match = lsOut.match(/"?name"?=\"([^"\\]+)\"/);
                  if (match && match[1]) { activeApp = match[1]; resolved = true; }
                } catch (_) {}
              }
              if (!resolved && cached) activeApp = cached;
            }
            if (activeApp && activeApp !== 'unknown') this._lastKnownActiveApp = activeApp;
        } finally {
          this._activeAppScriptInFlight = false;
        }
      }
    } else {
      // Linux basic fallback using xprop / wmctrl if available (best effort)
      try {
        const { stdout } = await execAsync('wmctrl -lp 2>/dev/null | awk \'NR==1{print $5}\'');
        const proc = stdout.trim();
        if (proc) activeApp = proc;
      } catch (_) {}
    }

    // Refresh running apps list only when needed
    if (refreshNeeded) {
      const backoffDelay = this._metrics.backoff.runningAppsDelay;
      if (backoffDelay > 0) {
        // If we are in backoff, skip refresh until next cycle after delay passes.
        if ((now - this._runningAppsCache.lastUpdated) < (CONFIG.runningAppsRefreshInterval + backoffDelay)) {
          // still within backoff window
        } else {
          // backoff window expired; proceed
          await this._refreshRunningApps(now);
        }
      } else {
        await this._refreshRunningApps(now);
      }
    }

    const result = { active: activeApp, running: this._runningAppsCache.list.slice() };
    if (meetingDebug) {
      this.log(`🩺 [ActiveApps] Frontmost='${result.active}' Visible=${result.running.length}`);
    } else if (Math.random() < 0.05) {
      this.log(`💻 Active app: ${result.active}, Running (cached): ${result.running.length}`);
    }
    return result;
  }

  async _refreshRunningApps(nowTs) {
    try {
      const list = await this.enumerateRunningApps();
      this._runningAppsCache = { list, lastUpdated: nowTs };
      if (meetingDebug) {
        this.log(`🩺 [RunningAppsRefresh] VisibleApps=${list.slice(0,15).join(', ')} (strategy=${this._metrics.runningAppsFallbacks.lastStrategy})`);
      }
      // Success resets backoff
      if (this._metrics.backoff.failures > 0 || this._metrics.backoff.runningAppsDelay > 0) {
        this._metrics.backoff.failures = 0;
        this._metrics.backoff.runningAppsDelay = 0;
        this.log('🔁 Running apps enumeration recovered; backoff reset');
      }
    } catch (err) {
      this._metrics.runningAppsFailures++;
      this._metrics.backoff.failures++;
      const base = 10 * 1000;
      const delay = Math.min(base * Math.pow(2, this._metrics.backoff.failures - 1), this._metrics.backoff.maxDelay);
      this._metrics.backoff.runningAppsDelay = delay;
      const now = Date.now();
      if (now - this._lastActiveAppErrorAt > 30000) {
        this._lastActiveAppErrorAt = now;
        this.log(`⚠️ Running apps enumeration failed (attempt ${this._metrics.backoff.failures}) -> backoff ${Math.round(delay/1000)}s: ${err.message.split('\n')[0]}`);
      }
    }
  }

  // Multi-strategy running apps enumeration for resilience
  async enumerateRunningApps() {
    if (IS_WINDOWS) {
      try {
        const { stdout } = await execAsync('powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName"');
        const list = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        this._metrics.runningAppsFallbacks.lastStrategy = 'ps-win';
        return Array.from(new Set(list));
      } catch (e) {
        this._metrics.runningAppsFallbacks.lastStrategy = 'none-win';
        return [];
      }
    }
    if (IS_MAC) {
      const disableApple = process.env.AI_AGENT_DISABLE_APPLESCRIPT_ENUM === 'true';
      if (!disableApple) {
        try {
          const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to name of every application process whose visible is true'`);
          const list = stdout.split(', ').map(s => s.trim()).filter(Boolean);
          this._metrics.runningAppsFallbacks.lastStrategy = 'applescript1';
          return list;
        } catch (_) {}
        try {
          const { stdout } = await execAsync(`osascript -e 'tell application "System Events" to get the name of every application process whose visible is true'`);
          const list = stdout.split(/,|\n/).map(s => s.trim()).filter(Boolean);
          this._metrics.runningAppsFallbacks.applescriptVariant2++;
          this._metrics.runningAppsFallbacks.lastStrategy = 'applescript2';
          return list;
        } catch (_) {}
      }
      try {
        const { stdout } = await execAsync('lsappinfo list');
        const list = stdout.split('\n').map(l => { const m = l.match(/name="([^"]+)"/); return m ? m[1] : null; }).filter(Boolean).filter(n => !n.startsWith('com.apple.'));
        this._metrics.runningAppsFallbacks.lsappinfo++;
        this._metrics.runningAppsFallbacks.lastStrategy = 'lsappinfo';
        return Array.from(new Set(list));
      } catch (_) {}
      try {
        const { stdout } = await execAsync('ps -Ao comm | tail -n +2');
        const list = stdout.split('\n').map(s => path.basename(s.trim())).filter(Boolean).filter(n => /[A-Za-z]/.test(n)).slice(0, 80);
        this._metrics.runningAppsFallbacks.psParsing++;
        this._metrics.runningAppsFallbacks.lastStrategy = 'ps';
        return Array.from(new Set(list));
      } catch (err) {
        this._metrics.runningAppsFallbacks.lastStrategy = 'none';
        return [];
      }
    }
    // Linux fallback
    try {
      const { stdout } = await execAsync('ps -eo comm | tail -n +2');
      const list = stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 80);
      this._metrics.runningAppsFallbacks.lastStrategy = 'ps-linux';
      return Array.from(new Set(list));
    } catch (_) {
      return [];
    }
  }

  async getActiveWindowTitles() {
    if (IS_WINDOWS) {
      try {
        const ps = 'powershell -NoProfile -Command "Add-Type -Namespace Win32 -Name User32 -MemberDefinition \"[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\\\"user32.dll\\\")] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int n);\"; $h=[Win32.User32]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 512; [Win32.User32]::GetWindowText($h,$sb,$sb.Capacity) | Out-Null; $sb.ToString()"';
        const { stdout } = await execAsync(ps);
        return stdout.trim();
      } catch (_) { return ''; }
    }
    if (IS_MAC) {
      try {
        const now = Date.now();
        const skipDueToEagain = (now - this._metrics.performance.lastSpawnEagainAt) < CONFIG.spawnEagainCooldown;
        if (skipDueToEagain) return '';
        const script = `osascript -e 'tell application "System Events" to set frontApp to name of first application process whose frontmost is true' -e 'tell application "System Events" to tell process frontApp to if exists window 1 then get name of window 1'`;
        const { stdout } = await this.limitedExec(script);
        return stdout.trim();
      } catch (_) { return ''; }
    }
    // Linux basic attempt using xprop (optional)
    try {
      // Use single quotes for JS string; escape inner single quotes for awk; final cut uses double quotes
      const cmd = 'xprop -id $(xprop -root _NET_ACTIVE_WINDOW | awk -F \' \'\'{print $5}\'\') WM_NAME 2>/dev/null | sed -E "s/.*WM_NAME\(STRING\) = \\\"(.*)\\\"/\\1/"';
      const { stdout } = await execAsync(cmd);
      return stdout.trim();
    } catch (_) { return ''; }
  }

  async getCurrentDirectory() { return process.cwd(); }

  async getCurrentGitBranch() {
    try {
      const { stdout } = await execAsync('git branch --show-current 2>/dev/null');
      return stdout.trim();
    } catch (error) {
      return null;
    }
  }

  async getOpenFiles() {
    try {
      // Try to get open files from common editors
      const vscodeFiles = await this.getVSCodeOpenFiles();
      return vscodeFiles;
    } catch (error) {
      return [];
    }
  }

  async getVSCodeOpenFiles() {
    try {
      // Check if VS Code is running and get workspace info
      const { stdout } = await execAsync(`
        osascript -e '
          tell application "System Events"
            if exists (process "Code") then
              tell process "Code"
                if exists window 1 then
                  return name of window 1
                end if
              end tell
            end if
            return ""
          end tell
        '
      `);
      
      return stdout.trim() ? [stdout.trim()] : [];
    } catch (error) {
      return [];
    }
  }

  isWorkingHours() {
    const now = new Date();
    const hour = now.getHours();
    const isWeekday = now.getDay() >= 1 && now.getDay() <= 5;
    
    // In test mode, accept any time for testing purposes
    if (isTestMode) {
      return true;
    }
    
  const cfg = this.effectiveConfig;
  return isWeekday && hour >= cfg.workHoursStart && hour < cfg.workHoursEnd;
  }

  isWorkActivity(activity) {
    const workApps = [
      'Visual Studio Code', 'Code', 'VS Code', 'IntelliJ IDEA', 'WebStorm', 
      'Terminal', 'iTerm2', 'Postman', 'Docker Desktop', 'Slack', 'Microsoft Teams',
      'JIRA', 'Confluence', 'Chrome', 'Safari', 'Firefox', 'Teams', 'MSTeams', 'Zoom', 'Skype'
    ];

    const workKeywords = [
      'jira', 'confluence', 'github', 'gitlab', 'bitbucket', 'docker', 'kubernetes',
      'api', 'test', 'debug', 'development', 'coding', 'programming', 'review',
      'meeting', 'standup', 'sprint', 'ticket', 'teams call', 'zoom meeting',
      'technical discussion', 'sync meeting'
    ];

    // Check if using work applications
    const hasWorkApp = workApps.some(app => 
      activity.applications.active.includes(app) || 
      activity.applications.running.some(runningApp => runningApp.includes(app))
    );

    // Check for work-related keywords in window titles
    const hasWorkKeywords = workKeywords.some(keyword =>
      activity.windowTitles.toLowerCase().includes(keyword)
    );

    // Check if in a development directory
    const isDevDirectory = activity.currentDirectory.includes('Desktop') || 
                           activity.currentDirectory.includes('Projects') ||
                           activity.currentDirectory.includes('Development') ||
                           activity.gitBranch !== null;

    const isWork = (hasWorkApp || hasWorkKeywords || isDevDirectory) && activity.isWorkingHours;
    
    // Only log details occasionally to avoid spam
    if (CONFIG.verboseLogging) {
      this.log(`📊 Work activity analysis - App: ${hasWorkApp}, Keywords: ${hasWorkKeywords}, DevDir: ${isDevDirectory}, WorkHours: ${activity.isWorkingHours}, Result: ${isWork}`);
    }
    
    return isWork;
  }

  async handleWorkActivity(activity) {
    const now = Date.now();
    await this.log(`💼 Handling work activity at ${new Date(now).toLocaleTimeString()}`);
    this._enqueueActivityTrace({ type: 'activity:work', now, activeApp: activity.applications.active, title: activity.windowTitles });

    if (!this.currentSession) {
      // Detect issue for the activity
      const detectedIssue = await this.detectRelatedIssue(activity);
      
      // Start new session
      this.currentSession = {
        id: `session_${now}`,
        startTime: now,
        endTime: null,
        duration: 0,
        detectedIssue: detectedIssue,
        activities: [activity],
        applications: new Set([activity.applications.active]),
        windowTitles: new Set([activity.windowTitles]),
        directories: new Set([activity.currentDirectory]),
        gitBranches: new Set(activity.gitBranch ? [activity.gitBranch] : []),
        confidence: this.calculateConfidence(activity)
      };
      this._enqueueActivityTrace({ type: 'session:start', id: this.currentSession.id, issue: detectedIssue || null, confidence: this.currentSession.confidence });

      const sessionType = this.detectActivityType(this.currentSession);
      const sessionDescription = sessionType.isMeetingActivity 
        ? (detectedIssue ? `Meeting for ${detectedIssue}` : 'Microsoft Teams Call/Meeting') 
        : (detectedIssue || 'Unknown task');
        
      await this.log(`🎆 Started new work session: ${sessionDescription} (Confidence: ${this.currentSession.confidence}%)`);
    } else {
      // Update existing session
      const prevDuration = this.currentSession.duration;
      this.currentSession.activities.push(activity);
      this.currentSession.applications.add(activity.applications.active);
      this.currentSession.windowTitles.add(activity.windowTitles);
      this.currentSession.directories.add(activity.currentDirectory);
      if (activity.gitBranch) {
        this.currentSession.gitBranches.add(activity.gitBranch);
      }
      this._enqueueActivityTrace({ type: 'session:update', id: this.currentSession.id, dur: this.currentSession.duration, apps: this.currentSession.applications.size, titles: this.currentSession.windowTitles.size });

      // Update detected issue if confidence is higher
      const currentIssue = await this.detectRelatedIssue(activity);
      const newConfidence = this.calculateConfidence(activity);
      if (currentIssue && newConfidence > this.currentSession.confidence) {
        await this.log(`🔄 Updated session issue: ${this.currentSession.detectedIssue} -> ${currentIssue} (Confidence: ${this.currentSession.confidence}% -> ${newConfidence}%)`);
        this.currentSession.detectedIssue = currentIssue;
        this.currentSession.confidence = newConfidence;
        this._enqueueActivityTrace({ type: 'session:issueUpdate', id: this.currentSession.id, issue: currentIssue, confidence: newConfidence });
      }

      this.currentSession.duration = now - this.currentSession.startTime;

  // Attempt hourly slicing auto-log (or test-mode accelerated)
  try { await this.attemptHourlySlice(now); } catch(e){ if (CONFIG.verboseLogging) this.log('Slice attempt error: '+e.message); }
      
      // Log session progress every 15 minutes
      const currentDurationMinutes = Math.floor(this.currentSession.duration / (1000 * 60));
      const prevDurationMinutes = Math.floor(prevDuration / (1000 * 60));
      if (currentDurationMinutes > 0 && currentDurationMinutes % 15 === 0 && currentDurationMinutes !== prevDurationMinutes) {
        await this.log(`🕰️ Session progress: ${this.formatDuration(this.currentSession.duration)} on ${this.currentSession.detectedIssue || 'Unknown task'}`);
      }

      // Auto-log if session is long enough
      if (this.currentSession.duration >= CONFIG.autoLogThreshold) {
        await this.log(`🏁 Session reached auto-log threshold (${this.formatDuration(CONFIG.autoLogThreshold)})`);
        await this.autoLogCurrentSession();
      }
    }
  }

  async handleIdleActivity() {
    if (this.currentSession) {
      const currentTime = Date.now();
      const sessionDuration = currentTime - this.currentSession.startTime;
      const lastActivityTime = this.currentSession.activities[this.currentSession.activities.length - 1]?.timestamp || this.currentSession.startTime;
      const idleTime = currentTime - lastActivityTime;
      
      await this.log(`😴 Idle activity detected - Session duration: ${this.formatDuration(sessionDuration)}, Idle time: ${this.formatDuration(idleTime)}`);
      this._enqueueActivityTrace({ type: 'activity:idle', sessionId: this.currentSession.id, idleMs: idleTime, sessionMs: sessionDuration });
      
      // End session if idle for too long
      if (idleTime > CONFIG.workSessionThreshold) {
        await this.log(`🚨 Idle time exceeded threshold (${this.formatDuration(CONFIG.workSessionThreshold)}), ending session`);
        await this.endSession();
      }
    } else {
      // Only log idle activity occasionally to avoid spam
      if (Math.random() < 0.1) { // 10% chance to log
        await this.log(`😴 System idle - no active work session`);
        this._enqueueActivityTrace({ type: 'activity:idleNoSession' });
      }
    }
  }

  async detectRelatedIssue(activity) {
    await this.log('🎯 Detecting related JIRA issue...');
    const jiraKeyPattern = /([A-Z]+-\d+)/g;
    
    // 0. Prefer microEvents (high-frequency sampler) recent signals (last 10 events)
    if (this.currentSession && this.currentSession.microEvents && this.currentSession.microEvents.length) {
      const recent = this.currentSession.microEvents.slice(-10).reverse();
      for (const ev of recent) {
        if (ev.jiraKey) {
          const assigned = this.assignedIssues.some(i => i.key === ev.jiraKey);
            if (assigned) {
              await this.log(`✅ Detected issue from microEvents buffer: ${ev.jiraKey} (source: ${ev.source})`);
              return ev.jiraKey;
            }
        }
      }
    }

    // 1. Look for JIRA key patterns in window title, open files, git branch
    const searchText = `${activity.windowTitles} ${activity.openFiles.join(' ')} ${activity.gitBranch || ''}`;
    const jiraMatches = searchText.match(jiraKeyPattern);
    if (jiraMatches) {
      const validIssue = jiraMatches.find(key => this.assignedIssues.some(issue => issue.key === key));
      if (validIssue) {
        await this.log(`✅ Detected issue via direct pattern: ${validIssue}`);
        return validIssue;
      }
    }

    // 2. Add keywords from browser URL (if sampler stored one in last microEvent)
    let browserRecentText = '';
    if (this.currentSession && this.currentSession.microEvents && this.currentSession.microEvents.length) {
      const lastEv = this.currentSession.microEvents[this.currentSession.microEvents.length - 1];
      if (lastEv && lastEv.browser && lastEv.browser.isJira && lastEv.jiraKey) {
        await this.log(`✅ Using browser URL key for detection: ${lastEv.jiraKey}`);
        return lastEv.jiraKey;
      }
    }

    // 3. Keyword-based fallback
    const activityKeywords = this.extractKeywords(searchText + ' ' + browserRecentText);
    const matchedIssues = [];
    if (activityKeywords.length) {
      this.log(`🔎 Keyword detection attempt with: ${activityKeywords.slice(0,12).join(', ')}`);
    }
    activityKeywords.forEach(keyword => {
      if (this.issueKeywordMap.has(keyword)) {
        const issues = this.issueKeywordMap.get(keyword);
        issues.forEach(issueKey => {
          const match = matchedIssues.find(m => m.issueKey === issueKey);
          if (match) {
            match.score++;
          } else {
            matchedIssues.push({ issueKey, score: 1 });
          }
        });
      }
    });
    if (matchedIssues.length > 0) {
      matchedIssues.sort((a, b) => b.score - a.score);
      const bestMatch = matchedIssues[0];
      await this.log(`✅ Detected issue via keyword fallback: ${bestMatch.issueKey} (score: ${bestMatch.score})`);
      return bestMatch.issueKey;
    }
    await this.log('❌ No related issue detected');
    return null;
  }

  calculateConfidence(activity) {
    let confidence = 0;
    const reasons = [];

    // Higher confidence for meeting applications
    const meetingApps = ['Microsoft Teams', 'Teams', 'MSTeams', 'Zoom', 'Skype', 'Meet', 'WebEx'];
    if (meetingApps.some(app => 
      activity.applications.active.toLowerCase().includes(app.toLowerCase()) ||
      app.toLowerCase().includes(activity.applications.active.toLowerCase())
    )) {
      confidence += 40;
      reasons.push('meeting app (+40)');
    }

    // Higher confidence for development tools
    const devApps = ['Visual Studio Code', 'Code', 'IntelliJ IDEA', 'WebStorm', 'Terminal', 'iTerm2'];
    if (devApps.some(app => activity.applications.active.includes(app))) {
      confidence += 30;
      reasons.push('dev app (+30)');
    }

    // Higher confidence for JIRA key in window title (base 30)
    let titleHasKey = false;
    if (/[A-Z]+-\d+/.test(activity.windowTitles)) {
      confidence += 30;
      titleHasKey = true;
      reasons.push('JIRA key (title +30)');
    }

    // If current session microEvents indicate URL sourced key, add extra boost (not cumulative with title boost beyond +50 total for key sources)
    if (this.currentSession && this.currentSession.microEvents && this.currentSession.microEvents.length) {
      const recent = this.currentSession.microEvents.slice(-5);
      const urlKeyEvent = recent.find(ev => ev.source && ev.source.includes('url') && ev.jiraKey);
      if (urlKeyEvent) {
        // Add 40 if no title key yet, else top up to at most +50 between both
        const alreadyForKey = titleHasKey ? 30 : 0;
        const desiredTotalKey = 50; // cap combined key-based confidence contribution
        const add = Math.max(0, desiredTotalKey - alreadyForKey);
        if (add > 0) {
          confidence += add;
          reasons.push(`JIRA key (browser URL +${add})`);
        }
      }
    }

    // Higher confidence for meeting keywords in window titles
    const meetingKeywords = ['meeting', 'call', 'teams', 'zoom', 'standup', 'sync', 'discussion'];
    if (meetingKeywords.some(keyword => activity.windowTitles.toLowerCase().includes(keyword))) {
      confidence += 30;
      reasons.push('meeting keywords (+30)');
    }

    // Higher confidence for Git branch
    if (activity.gitBranch) {
      confidence += 20;
      reasons.push(`git branch (+20): ${activity.gitBranch}`);
    }

    // Higher confidence for development directory
    if (activity.currentDirectory.includes('Development') || activity.currentDirectory.includes('Projects')) {
      confidence += 10;
      reasons.push('dev directory (+10)');
    }

    const finalConfidence = Math.min(confidence, 100);
  if (CONFIG.verboseLogging) this.log(`🎯 Confidence calculation: ${finalConfidence}% - ${reasons.join(', ')}`);
    
    return finalConfidence;
  }

  async endSession() {
    if (!this.currentSession) {
      await this.log('⚠️ Attempted to end session but no current session exists');
      return;
    }

    await this.log(`🏁 Ending current session: ${this.currentSession.id}`);
    this.currentSession.endTime = Date.now();
    this.currentSession.duration = this.currentSession.endTime - this.currentSession.startTime;

    // If slices already logged, only log remainder if large enough and not already fully covered
    if (this.currentSession.loggedUntil && this.currentSession.loggedUntil > this.currentSession.startTime) {
      const remainderStart = this.currentSession.loggedUntil;
      const remainderDur = this.currentSession.endTime - remainderStart;
      const remainderMin = remainderDur / 60000;
      if (remainderMin >= this.effectiveConfig.idleRemainderLogThresholdMinutes) {
        await this.log(`🧩 Logging remainder slice ${this.formatDuration(remainderDur)} at session end`);
        await this.logSlice(this.currentSession, remainderStart, this.currentSession.endTime);
      } else {
        await this.log(`🧩 Remainder ${Math.round(remainderMin)}m below threshold; skipping`);
      }
    }

    // Only save sessions that meet minimum threshold
    if (this.currentSession.duration >= CONFIG.workSessionThreshold) {
      this.sessions.push({
        ...this.currentSession,
        applications: Array.from(this.currentSession.applications),
        windowTitles: Array.from(this.currentSession.windowTitles),
        directories: Array.from(this.currentSession.directories),
        gitBranches: Array.from(this.currentSession.gitBranches),
        microEvents: this.currentSession.microEvents || []
      });

      await this.log(`✅ Session saved: ${this.formatDuration(this.currentSession.duration)} on ${this.currentSession.detectedIssue || 'Unknown task'}`);
      await this.saveData();
    } else {
      await this.log(`⏱️ Session too short (${this.formatDuration(this.currentSession.duration)}), not saving`);
    }

    this.currentSession = null;
  }

  /* ------------------------------ Hourly Slicing ------------------------------ */
  async attemptHourlySlice(nowTs) {
    if (!this.currentSession || !this.effectiveConfig.enableHourlySlicing) return;
    const sliceMs = this.effectiveConfig.hourlyAutoLogMinutes * 60 * 1000;
    if (!this.currentSession.loggedUntil) {
      this.currentSession.loggedUntil = this.currentSession.startTime; // initialize pointer
    }
    const elapsedSincePointer = nowTs - this.currentSession.loggedUntil;
    if (elapsedSincePointer >= sliceMs) {
      // Only slice if we have an issue or it's a meeting activity (avoid logging unknown work prematurely)
      const activityType = this.detectActivityType(this.currentSession);
      const canSlice = activityType.isMeetingActivity || this.currentSession.detectedIssue;
      if (!canSlice) return; // wait until issue detected
      const sliceStart = this.currentSession.loggedUntil;
      const sliceEnd = sliceStart + sliceMs;
      // Avoid exceeding current time (small drift)
      const cappedSliceEnd = Math.min(sliceEnd, nowTs);
      await this.log(`⏱️ Hourly slice reached ${this.formatDuration(cappedSliceEnd - this.currentSession.startTime)} – logging slice ${this.formatDuration(cappedSliceEnd - sliceStart)}`);
      this._enqueueActivityTrace({ type: 'slice:trigger', sessionId: this.currentSession.id, from: sliceStart, to: cappedSliceEnd, dur: cappedSliceEnd - sliceStart });
      await this.logSlice(this.currentSession, sliceStart, cappedSliceEnd);
      this.currentSession.loggedUntil = cappedSliceEnd;
      this._sliceMetrics.slicesLogged++;
    }
  }

  async logSlice(parentSession, startMs, endMs) {
    const duration = endMs - startMs;
    if (duration < this.effectiveConfig.workSessionThreshold / 3) {
      // too tiny to be meaningful
      return;
    }
    const sliceSession = {
      id: parentSession.id + '_slice_' + startMs,
      startTime: startMs,
      endTime: endMs,
      duration: duration,
      detectedIssue: parentSession.detectedIssue,
      confidence: parentSession.confidence,
      applications: Array.from(parentSession.applications || []),
      windowTitles: Array.from(parentSession.windowTitles || []),
      directories: Array.from(parentSession.directories || []),
      gitBranches: Array.from(parentSession.gitBranches || []),
      microEvents: []
    };
    this._enqueueActivityTrace({ type: 'slice:prepare', parentId: parentSession.id, sliceId: sliceSession.id, dur: duration, issue: sliceSession.detectedIssue });
    try {
      await this.logTimeToTempo(sliceSession);
      this.loggedSessions.add(sliceSession.id);
      await this.log(`✅ Logged slice ${sliceSession.id}`);
      this._enqueueActivityTrace({ type: 'slice:logged', sliceId: sliceSession.id });
    } catch(e) {
      await this.log(`❌ Slice log failed: ${e.message}`);
      this._enqueueActivityTrace({ type: 'slice:error', sliceId: sliceSession.id, error: e.message });
    }
  }

  /* ------------------------------- Idle Detection ----------------------------- */
  async getSystemIdleSeconds() {
    try {
      if (IS_MAC) {
        // Use ioreg HIDIdleTime (nanoseconds)
        const { stdout } = await execAsync("ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'");
        const v = parseInt(stdout.trim(),10);
        return isNaN(v)?0:v;
      }
      if (IS_WINDOWS) {
        const ps = 'powershell -NoProfile -Command "Add-Type -MemberDefinition \"[DllImport(\\\"user32.dll\\\")]public static extern bool GetLastInputInfo(ref LASTINPUTINFO li);public struct LASTINPUTINFO{public uint cbSize;public uint dwTime;}\" -Name Win32LastInput -Namespace Win32; $info=New-Object Win32.Win32LastInput+LASTINPUTINFO; $info.cbSize=[System.Runtime.InteropServices.Marshal]::SizeOf($info); [Win32.Win32LastInput]::GetLastInputInfo([ref]$info) | Out-Null; $idle = (Get-TickCount) - $info.dwTime; [int]($idle/1000)"';
        const { stdout } = await execAsync(ps);
        const v = parseInt(stdout.trim(),10); return isNaN(v)?0:v;
      }
      // Linux: use xprintidle if available
      try {
        const { stdout } = await execAsync('xprintidle 2>/dev/null');
        const ms = parseInt(stdout.trim(),10); if (!isNaN(ms)) return Math.floor(ms/1000);
      } catch(_) {}
      return 0;
    } catch(_) { return 0; }
  }

  async autoLogCurrentSession() {
    if (!this.currentSession) {
      await this.log('⚠️ No current session to auto-log');
      return;
    }
    
    if (this.loggedSessions.has(this.currentSession.id)) {
      this.currentSession.logStatus = this.currentSession.logStatus || 'logged';
      this.currentSession.logReason = this.currentSession.logReason || 'already-logged';
      await this.log(`ℹ️ Session ${this.currentSession.id} already logged, skipping`);
      return;
    }

    await this.log(`🤖 Evaluating current session for auto-logging: ${this.currentSession.id}`);
    const activityType = this.detectActivityType(this.currentSession);
    
    // For meeting activities, always log to CON22-2208 regardless of detected issue
    // For story development, require detected issue and confidence >= 70%
    const shouldLog = activityType.isMeetingActivity || 
                     (this.currentSession.detectedIssue && this.currentSession.confidence >= 70);

    await this.log(`📋 Auto-log evaluation - Meeting: ${activityType.isMeetingActivity}, Issue: ${this.currentSession.detectedIssue}, Confidence: ${this.currentSession.confidence}%, Should Log: ${shouldLog}`);

    if (shouldLog) {
      try {
        const result = await this.logTimeToTempo(this.currentSession);
        if (result && result.dryRun) {
          this.currentSession.logStatus = 'dry-run';
          this.currentSession.logReason = 'dry-run-mode';
        } else {
          this.currentSession.logStatus = 'logged';
          this.currentSession.logReason = activityType.isMeetingActivity ? 'meeting-auto' : 'dev-threshold-met';
          this.loggedSessions.add(this.currentSession.id);
        }
      } catch (e) {
        this.currentSession.logStatus = 'error';
        this.currentSession.logReason = e.message;
      }
    } else {
      this.currentSession.logStatus = 'skipped';
      if (!this.currentSession.detectedIssue && !activityType.isMeetingActivity) {
        this.currentSession.logReason = 'no-issue-detected';
      } else {
        this.currentSession.logReason = `low-confidence-${this.currentSession.confidence}`;
      }
      await this.log(`⏭️ Session skipped (${this.currentSession.logReason})`);
    }
  }

  async autoLogCompletedSessions() {
    await this.log('🔍 Checking for completed sessions to auto-log...');
    
    const unloggedSessions = this.sessions.filter(session => {
      if (this.loggedSessions.has(session.id) || 
          session.duration < CONFIG.workSessionThreshold) {
        return false;
      }
      
      const activityType = this.detectActivityType(session);
      
      // Log if it's a meeting activity OR if it's story development with good confidence
      return activityType.isMeetingActivity || 
             (session.detectedIssue && session.confidence >= 60);
    });

    if (unloggedSessions.length === 0) {
      await this.log('✅ No completed sessions requiring auto-logging');
      return;
    }

    await this.log(`📋 Found ${unloggedSessions.length} completed sessions to auto-log`);
    
    for (const session of unloggedSessions) {
      const activityType = this.detectActivityType(session);
      await this.log(`🚀 Auto-logging completed session: ${session.id} (${activityType.description})`);
      try {
        const result = await this.logTimeToTempo(session);
        if (result && result.dryRun) {
          session.logStatus = 'dry-run';
          session.logReason = 'dry-run-mode';
        } else {
          session.logStatus = 'logged';
          session.logReason = activityType.isMeetingActivity ? 'meeting-auto' : 'completed-session-auto';
          this.loggedSessions.add(session.id);
        }
      } catch (e) {
        session.logStatus = 'error';
        session.logReason = e.message;
      }
    }
    
    await this.log(`✅ Completed auto-logging ${unloggedSessions.length} sessions`);
  }

  async logTimeToTempo(session) {
    // Declare variables at function scope to avoid reference errors
    let targetIssueKey = session.detectedIssue;
    let targetIssueId;
    let activityType;
    
    try {
      const timeSpentSeconds = Math.round(session.duration / 1000);
      const description = this.generateWorkDescription(session);
      activityType = this.detectActivityType(session);
      
      // Determine issue key and ID based on activity type
      if (activityType.isMeetingActivity) {
        targetIssueKey = CONFIG.defaultMeetingIssue;
      }
      
      // Validate that we have a target issue key
      if (!targetIssueKey) {
        throw new Error('No target issue key available for logging');
      }
      
      // Enhanced error logging for test mode
      if (isTestMode) {
        await this.log(`🧪 TEST MODE - Preparing to log ${this.formatDuration(session.duration)} to ${targetIssueKey}`);
        await this.log(`   Description: ${description}`);
        await this.log(`   Activity Type: ${activityType.description}`);
        await this.log(`   Time: ${timeSpentSeconds} seconds`);
      }
      
      // Get issue ID from issue key
      const issueResponse = await jiraApi.get(`/rest/api/3/issue/${targetIssueKey}`);
      targetIssueId = issueResponse.data.id;
      
      if (isTestMode) {
        await this.log(`✅ Issue ${targetIssueKey} found with ID: ${targetIssueId}`);
      }
      
      // Set attributes: prefer explicit customAttributes (e.g., from LLM daily notes) else derive
      let attributes = Array.isArray(session.customAttributes) && session.customAttributes.length
        ? session.customAttributes
        : this.getWorkAttributes(activityType);
      // Normalize technology time type values
      attributes = attributes.map(a => {
        if (a.key === '_TechnologyTimeType_' && a.value) {
          a.value = TECHNOLOGY_TYPE_NORMALIZATION[a.value] || a.value;
        }
        return a;
      });

      // Handle date (optionally use local date to avoid UTC rollover issues)
      const useLocal = process.env.USE_LOCAL_DATE_FOR_TEMPO === 'true';
      const startDateObj = new Date(session.startTime);
      const utcDate = startDateObj.toISOString().split('T')[0];
      let localDate = utcDate;
      if (useLocal) {
        const y = startDateObj.getFullYear();
        const m = String(startDateObj.getMonth() + 1).padStart(2, '0');
        const d = String(startDateObj.getDate()).padStart(2, '0');
        localDate = `${y}-${m}-${d}`;
      }
      const payload = {
        attributes: attributes,
        authorAccountId: TEMPO_ACCOUNT_ID,
        billableSeconds: timeSpentSeconds,
        description: description,
        issueId: parseInt(targetIssueId),
        startDate: useLocal ? localDate : utcDate,
        startTime: new Date(session.startTime).toTimeString().split(' ')[0],
        timeSpentSeconds: timeSpentSeconds
      };

      if (isTestMode) {
        await this.log(`🧪 TEST MODE - Payload prepared: ${JSON.stringify(payload, null, 2)}`);
      }

      // Check if this is a dry run
      if (isDryRun) {
        await this.log(`🔒 DRY RUN - Would log ${this.formatDuration(session.duration)} to ${targetIssueKey} (${activityType?.description || 'Unknown'}) - NOT ACTUALLY LOGGED`);
        session.logStatus = 'dry-run';
        session.logReason = 'dry-run-mode';
        return { id: 'dry-run-' + Date.now(), dryRun: true };
      }

      let response;
      try {
        response = await tempoApi.post('/worklogs', payload);
      } catch (primaryErr) {
        // If 400, attempt a diagnostic + attribute removal fallback (common cause: invalid attribute values)
        if (primaryErr.response && primaryErr.response.status === 400) {
          await this.log(`⚠️ Tempo 400 for issue ${targetIssueKey} – attempting fallback without attributes`);
          if (primaryErr.response.data) {
            const snippet = JSON.stringify(primaryErr.response.data).slice(0,300);
            await this.log(`   Original 400 payload response: ${snippet}`);
          }
          // Keep required _TimeCategory_ but drop _TechnologyTimeType_ only, since error indicated invalid list value.
          const kept = (payload.attributes || []).filter(a => a.key === '_TimeCategory_');
          const fallbackPayload = { ...payload, attributes: kept };
          try {
            response = await tempoApi.post('/worklogs', fallbackPayload);
            await this.log('✅ Fallback without attributes succeeded');
          } catch (fallbackErr) {
            // Re-throw richer error including both responses
            const errInfo = {
              primary: primaryErr.response?.data || primaryErr.message,
              fallback: fallbackErr.response?.data || fallbackErr.message,
              issue: targetIssueKey
            };
            const combined = new Error(`Tempo logging failed (400) even after fallback: ${JSON.stringify(errInfo).slice(0,500)}`);
            combined.original = primaryErr;
            combined.fallback = fallbackErr;
            throw combined;
          }
        } else {
          throw primaryErr;
        }
      }
      const worklogId = response.data?.id || response.data?.tempoWorklogId || response.data?.worklogId;
      session.loggedIssueKey = targetIssueKey;
      session.loggedWorklogId = worklogId;
      if (!worklogId) {
        await this.log(`⚠️ Tempo response missing worklog ID field. Raw response keys: ${Object.keys(response.data || {}).join(', ')} `);
        if (process.env.AI_AGENT_LOG_TEMPO_RESPONSE === 'true') {
          await this.log(`🔬 Raw Tempo response: ${JSON.stringify(response.data, null, 2)}`);
        }
      }
      await this.log(`✅ Auto-logged ${this.formatDuration(session.duration)} to ${targetIssueKey} (${activityType?.description || 'Unknown'}) - Worklog ID: ${worklogId || 'unknown'}`);
      session.logStatus = 'logged';
      session.logReason = activityType.isMeetingActivity ? 'meeting-auto' : 'logged';
      
      return response.data;
    } catch (error) {
      // Enhanced error logging for test mode
      if (isTestMode) {
        await this.log(`❌ TEST MODE - Detailed auto-log error for ${targetIssueKey || session.detectedIssue || 'Unknown issue'}:`);
        await this.log(`   Error Message: ${error.message}`);
        await this.log(`   Error Code: ${error.code || 'N/A'}`);
        if (error.response) {
          await this.log(`   HTTP Status: ${error.response.status}`);
          await this.log(`   Response Data: ${JSON.stringify(error.response.data, null, 2)}`);
        }
        if (error.original && error.fallback) {
          await this.log('   Fallback diagnostic present (original & fallback errors captured)');
        }
        await this.log(`   Session Details: ${JSON.stringify({
          duration: session.duration,
          startTime: session.startTime,
          detectedIssue: session.detectedIssue,
          confidence: session.confidence
        }, null, 2)}`);
      } else {
        await this.log(`❌ Failed to auto-log session for ${targetIssueKey || session.detectedIssue || 'Unknown issue'}: ${error.message}`);
        session.logStatus = 'error';
        session.logReason = error.message;
      }
      throw error;
    }
  }

  // Cached activity type to avoid repeated heavy keyword scans per session
  detectActivityType(session) {
    const now = Date.now();
    if (session._cachedActivityType && (now - session._cachedActivityTypeAt < 5000)) {
      return session._cachedActivityType; // reuse within 5s window
    }
    const result = (function(self, session) {
    // Allow legacy logic via env toggle
    if (process.env.AI_AGENT_LEGACY_MEETING_DETECTION === 'true') {
      // Recursively call a simplified legacy path (old logic preserved above in git history)
      // Fallback: treat any Teams/Zoom keyword OR app as meeting.
      const appsLegacy = ['Teams','Microsoft Teams','Zoom','Meet','WebEx','Google Meet'];
      const kwsLegacy = ['meeting','standup','retro','planning'];
      const applicationsLegacy = Array.isArray(session.applications) ? session.applications : (session.applications ? Array.from(session.applications) : []);
      const windowTitlesLegacy = Array.isArray(session.windowTitles) ? session.windowTitles : (session.windowTitles ? Array.from(session.windowTitles) : []);
      const isMeet = applicationsLegacy.some(a => appsLegacy.some(m => a.toLowerCase().includes(m.toLowerCase()))) || windowTitlesLegacy.some(t => kwsLegacy.some(k => t.toLowerCase().includes(k)));
      return {
        isMeetingActivity: isMeet,
        isStoryDevelopment: !isMeet && session.detectedIssue,
        meetingType: null,
        description: isMeet ? 'Meeting/Collaboration (legacy)' : 'Story Development'
      };
    }

    // Scoring-based detection (reduces false positives)
    const meetingApps = ['microsoft teams','teams','zoom','skype','meet','webex','google meet','cisco webex'];
    const strongKeywords = ['standup','all hands','all-hands','town hall','retro','retrospective','sprint planning','kickoff','brainstorm','brainstorming','demo'];
    const weakKeywords = ['meeting','call','sync','discussion','review','planning','huddle']; // need extra support (app presence or multiple occurrences)
    const devApps = ['visual studio code','code','intellij','webstorm','pycharm','iterm','terminal','xcode','android studio'];
    const devKeywords = ['localhost','git','commit','branch','merge','pull request','pr ','src/','package.json','node_modules','jira','tempo','api'];

    const applications = Array.isArray(session.applications) ? session.applications : (session.applications ? Array.from(session.applications) : []);
    const windowTitles = Array.isArray(session.windowTitles) ? session.windowTitles : (session.windowTitles ? Array.from(session.windowTitles) : []);
    const lowerTitles = windowTitles.map(t => t.toLowerCase());
    const lowerApps = applications.map(a => a.toLowerCase());

    // Collect triggers
    const appTriggers = lowerApps.filter(a => meetingApps.some(m => a.includes(m)));
    const strongKeywordHits = [];
    const weakKeywordHits = [];
    lowerTitles.forEach(t => {
      strongKeywords.forEach(k => { if (t.includes(k)) strongKeywordHits.push(k); });
      weakKeywords.forEach(k => { if (t.includes(k)) weakKeywordHits.push(k); });
    });

    const devAppHits = lowerApps.filter(a => devApps.some(d => a.includes(d)));
    const devKeywordHits = [];
    lowerTitles.forEach(t => {
      devKeywords.forEach(k => { if (t.includes(k)) devKeywordHits.push(k); });
    });

    // Scoring heuristic
    let score = 0;
    score += appTriggers.length * 5; // each meeting app very strong
    score += strongKeywordHits.length * 3; // strong phrases
    // weak keywords only contribute if more than one OR there is a meeting app
    if (weakKeywordHits.length >= 2 || appTriggers.length > 0) {
      score += weakKeywordHits.length; // +1 each
    }
    // Penalize if strong dev context dominates
    score -= devAppHits.length * 2;
    score -= devKeywordHits.length; // soft penalty

    const threshold = parseInt(process.env.AI_AGENT_MEETING_SCORE_THRESHOLD || '7', 10);
    let isMeetingActivity = score >= threshold;

    // Additional guard: if only generic weak words like 'planning' or 'review' appear without meeting app & without another strong keyword, demote.
    if (isMeetingActivity && appTriggers.length === 0 && strongKeywordHits.length === 0) {
      // Only weak triggers drove score; require at least 3 weak keywords to accept.
      const distinctWeak = Array.from(new Set(weakKeywordHits));
      if (distinctWeak.length < 3) {
        isMeetingActivity = false;
      }
    }

    // Detect specific meeting type only if classified as meeting
    const meetingTypes = {
      'standup': ['standup','daily standup','daily standup meeting','daily','scrum'],
      'sprint-planning': ['sprint planning','planning','sprint plan','iteration planning'],
      'code-review': ['code review','pr review','pull request review','review meeting','architecture review','arch review'],
      'test-case-review': ['test case review','test review','qa review'],
      'sprint-demo': ['sprint demo','demo','demonstration','showcase'],
      'sprint-retro': ['retrospective','retro','sprint retro'],
      'kickoff': ['kickoff','project kickoff'],
      'all-hands': ['all hands','all-hands','town hall','townhall'],
      'brainstorming': ['brainstorm','brainstorming','ideation','design jam']
    };
    let meetingType = null;
    if (isMeetingActivity) {
      const allText = lowerTitles.join(' ');
      for (const [type, kws] of Object.entries(meetingTypes)) {
        if (kws.some(k => allText.includes(k))) { meetingType = type; break; }
      }
    }

    const activityType = {
      isMeetingActivity,
      isStoryDevelopment: !isMeetingActivity && session.detectedIssue,
      meetingType,
      description: isMeetingActivity ? (meetingType ? `Meeting: ${meetingType.replace('-', ' ')}` : 'Meeting/Collaboration') : 'Story Development',
      debug: {
        score,
        threshold,
        appTriggers: Array.from(new Set(appTriggers)),
        strongKeywordHits: Array.from(new Set(strongKeywordHits)),
        weakKeywordHits: Array.from(new Set(weakKeywordHits)),
        devAppHits: Array.from(new Set(devAppHits)),
        devKeywordHits: Array.from(new Set(devKeywordHits))
      }
    };

  if (CONFIG.verboseLogging) self.log(`🎭 Activity type detected: ${activityType.description} | score=${score} (>=${threshold}? ${score >= threshold}) | apps=${appTriggers.join(',') || '-'} | strong=${activityType.debug.strongKeywordHits.join(',') || '-'} | weak=${activityType.debug.weakKeywordHits.join(',') || '-'} | devApps=${activityType.debug.devAppHits.join(',') || '-'} | devKw=${activityType.debug.devKeywordHits.join(',') || '-'}`);
    if (CONFIG.enableMeetingMetrics && self._metrics) {
      try {
        if (activityType.isMeetingActivity) {
          self._metrics.meetings.sessions++;
          const t = meetingType || 'general';
          self._metrics.meetings.byType[t] = (self._metrics.meetings.byType[t] || 0) + 1;
        } else if (activityType.isStoryDevelopment) {
          self._metrics.development.sessions++;
        }
        const nowTs = Date.now();
        if (nowTs - self._metrics.meetings.lastSummaryLog > 30 * 60 * 1000) {
          self._metrics.meetings.lastSummaryLog = nowTs;
          self.log(`📈 Metrics summary: Meetings=${self._metrics.meetings.sessions}, DevSessions=${self._metrics.development.sessions}`);
        }
      } catch (_) {}
    }

    return activityType;
    })(this, session);
    session._cachedActivityType = result;
    session._cachedActivityTypeAt = now;
    return result;
  }
  
  getWorkAttributes(activityType) {
    let attributes;
    
    if (activityType.isMeetingActivity) {
      // Determine specific meeting type for more accurate categorization
      const meetingType = activityType.meetingType || 'general';
      const technologyTimeType = WORK_ATTRIBUTE_MAPPINGS.meetings.technologyTimeTypes[meetingType] || 
                                 WORK_ATTRIBUTE_MAPPINGS.meetings.technologyTimeTypes.general;
      
      // For Microsoft Teams calls and meetings - use correct Tempo values
      attributes = [
        {
          key: "_TimeCategory_",
          value: WORK_ATTRIBUTE_MAPPINGS.meetings.timeCategory
        },
        {
          key: "_TechnologyTimeType_",
          value: technologyTimeType
        }
      ];
      this.log(`🏅 Work attributes for meeting: TimeCategory=${WORK_ATTRIBUTE_MAPPINGS.meetings.timeCategory}, TechnologyTimeType=${technologyTimeType}`);
    } else {
      // For story development work - use correct Tempo values
      attributes = [
        {
          key: "_TimeCategory_",
          value: WORK_ATTRIBUTE_MAPPINGS.development.timeCategory
        },
        {
          key: "_TechnologyTimeType_",
          value: WORK_ATTRIBUTE_MAPPINGS.development.technologyTimeType
        }
      ];
      this.log(`💻 Work attributes for development: TimeCategory=${WORK_ATTRIBUTE_MAPPINGS.development.timeCategory}, TechnologyTimeType=${WORK_ATTRIBUTE_MAPPINGS.development.technologyTimeType}`);
    }
    
    return attributes;
  }

  generateWorkDescription(session) {
    // Allow opting out to legacy description for debugging / payload size issues
    if (process.env.AI_AGENT_SIMPLE_DESCRIPTION === 'true') {
      const basic = [];
      const activityType = this.detectActivityType(session);
      const primaryApps = Array.from(session.applications).slice(0, 3);
      if (primaryApps.length) {
        basic.push(activityType.isMeetingActivity ? `Meeting using ${primaryApps.join(', ')}` : `Dev work in ${primaryApps.join(', ')}`);
      }
      if (session.gitBranches.length && !activityType.isMeetingActivity) {
        basic.push(`Branch: ${Array.from(session.gitBranches)[0]}`);
      }
      basic.push(`Time: ${new Date(session.startTime).toLocaleTimeString()} - ${new Date(session.endTime || (session.startTime + session.duration)).toLocaleTimeString()}`);
      basic.push(`Confidence ${session.confidence}%`);
      return basic.join('. ');
    }

    const activityType = this.detectActivityType(session);
    const start = new Date(session.startTime);
    const end = new Date(session.endTime || (session.startTime + session.duration));
    const durationMs = session.duration || (end - start);
    const durationH = Math.floor(durationMs / 3600000);
    const durationM = Math.floor((durationMs % 3600000) / 60000);
    const durationStr = `${durationH ? durationH + 'h ' : ''}${durationM}m`.trim();

    // Derive primary applications & branches
    const apps = Array.from(session.applications).filter(a => a && a !== 'unknown');
    const primaryApps = apps.slice(0, 4);
    const branch = session.gitBranches && session.gitBranches.size ? Array.from(session.gitBranches)[0] : null;

    // Mine microEvents + window titles for lightweight topic cues
    const textCorpus = [];
    const pushIf = v => { if (v) textCorpus.push(v); };
    Array.from(session.windowTitles).forEach(t => pushIf(t));
    if (session.microEvents) {
      session.microEvents.slice(-50).forEach(ev => pushIf(ev.title));
    }
    const corpus = textCorpus.join(' ').toLowerCase();

    function extractKeywords(src) {
      return Array.from(new Set(src
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 3 && !['meeting','standup','daily','teams','zoom','microsoft','google','chrome','discussion','https','local','project','console','development','branch','merge','issue','board','story','review','retro','sprint','planning','demo','work','window','code','github','tempo'].includes(w))
      ));
    }

    const rawKeywords = extractKeywords(corpus).slice(0, 12);

    // Heuristic topic grouping
    const topics = [];
    const topicMatchers = [
      { label: 'progress update', re: /(progress|update|status)/ },
      { label: 'defect triage', re: /(bug|defect|issue|error|fix)/ },
      { label: 'UI adjustments', re: /(ui|frontend|button|layout|css)/ },
      { label: 'performance', re: /(perf|latency|speed|optimi[sz]e)/ },
      { label: 'auth/session', re: /(auth|session|token|login)/ },
      { label: 'test coverage', re: /(test|coverage|qa|regression)/ },
      { label: 'deployment readiness', re: /(deploy|release|build)/ }
    ];
    topicMatchers.forEach(m => { if (m.re.test(corpus)) topics.push(m.label); });

    // Decisions / actions heuristics (lightweight inference)
    const decisions = [];
    if (/reuse|existing component/.test(corpus)) decisions.push('Reuse existing component');
    if (/defer|later sprint|next sprint/.test(corpus)) decisions.push('Deferred low priority items');
    if (/null[- ]state|empty state/.test(corpus)) decisions.push('Add null-state UX');
    if (/analytics|telemetry|metric/.test(corpus)) decisions.push('Add analytics event');

    const actions = [];
    if (/test|coverage/.test(corpus)) actions.push('Finalize test checklist');
    if (/auth|session/.test(corpus)) actions.push('Create auth edge-case ticket');
    if (/latency|perf/.test(corpus)) actions.push('Monitor performance metrics');
    if (branch) actions.push(`Complete work on ${branch}`);

    // Deduplicate
    const dedupe = arr => Array.from(new Set(arr));
    const topicsOut = dedupe(topics).slice(0, 5);
    const decisionsOut = dedupe(decisions).slice(0, 4);
    const actionsOut = dedupe(actions).slice(0, 5);

    // Build structured description
    const lines = [];
    const issueKey = session.detectedIssue || (activityType.isMeetingActivity ? 'General Meeting' : 'Unassigned');
    if (activityType.isMeetingActivity) {
      lines.push(`${issueKey} ${activityType.meetingType ? '(' + activityType.meetingType.replace('-', ' ') + ')' : 'meeting'} (${durationStr})`);
    } else {
      lines.push(`${issueKey} development session (${durationStr})`);
    }
    lines.push(`Time: ${start.toLocaleTimeString()}–${end.toLocaleTimeString()}`);
    if (primaryApps.length) lines.push(`Apps: ${primaryApps.join(', ')}`);
    if (branch && !activityType.isMeetingActivity) lines.push(`Branch: ${branch}`);
    if (topicsOut.length) lines.push(`Topics: ${topicsOut.join('; ')}`);
    if (rawKeywords.length) lines.push(`Context: ${rawKeywords.slice(0,6).join(', ')}`);
    if (decisionsOut.length) lines.push(`Decisions: ${decisionsOut.join(' | ')}`);
    if (actionsOut.length) lines.push(`Actions: ${actionsOut.join(' | ')}`);
    lines.push(`Confidence: ${session.confidence}%`);

    return lines.join('\n');
  }

  formatDuration(milliseconds) {
    const hours = Math.floor(milliseconds / (1000 * 60 * 60));
    const minutes = Math.floor((milliseconds % (1000 * 60 * 60)) / (1000 * 60));
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  async processActivity() {
    // Additional processing logic can be added here
    // For example, learning from user patterns, improving detection accuracy, etc.
    
    // Log statistics periodically
    if (this.lastActivity && Math.random() < 0.05) { // 5% chance to log stats
      const stats = this.getStatus();
      await this.log(`📊 Agent statistics: ${stats.totalSessions} total sessions, ${stats.loggedSessions} logged, ${stats.pendingSessions} pending, ${stats.assignedIssues} assigned issues`);
    }
  }

  get effectiveConfig() {
    // always reflect latest overrides
    this._effectiveConfig = getEffectiveConfig();
    return this._effectiveConfig;
  }

  updateRuntimeConfig(partial) {
    const allowed = ['monitoringInterval','workSessionThreshold','autoLogThreshold','maxSessionDuration','workHoursStart','workHoursEnd'];
    let changed = false;
    for (const k of Object.keys(partial)) {
      if (allowed.includes(k) && partial[k] != null && partial[k] !== '') {
        RUNTIME_OVERRIDES[k] = Number.isFinite(partial[k]) ? partial[k] : partial[k];
        changed = true;
      }
    }
    if (changed) {
      // persist to file
      try {
        require('fs').writeFileSync(path.join(__dirname,'user-config.json'), JSON.stringify(RUNTIME_OVERRIDES, null, 2));
      } catch (e) {
        console.error('Failed to write user-config.json:', e.message);
      }
    }
    // apply monitoring interval change by restarting loop timer indirectly (next tick uses new value)
    return this.effectiveConfig;
  }

  clearRuntimeConfig() {
    RUNTIME_OVERRIDES = {};
    try { require('fs').unlinkSync(path.join(__dirname,'user-config.json')); } catch(_) {}
    return this.effectiveConfig;
  }

  // ==== RECONCILIATION LOGIC ==================================================
  async fetchTempoWorklogs(fromDate, toDate) {
    try {
      const params = {
        from: fromDate,
        to: toDate,
        worker: [TEMPO_ACCOUNT_ID]
      };
      const resp = await tempoApi.get('/worklogs', { params });
      return resp.data?.results || [];
    } catch (e) {
      await this.log(`❌ Reconciliation: failed to fetch Tempo worklogs (${fromDate}..${toDate}): ${e.message}`);
      if (e.response) {
        await this.log(`   HTTP ${e.response.status} ${JSON.stringify(e.response.data).substring(0,400)}`);
      }
      return null;
    }
  }

  _sessionDate(session) {
    const useLocal = process.env.USE_LOCAL_DATE_FOR_TEMPO === 'true';
    const d = new Date(session.startTime);
    if (useLocal) {
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${day}`;
    }
    return d.toISOString().split('T')[0];
  }

  async reconcileWorklogs(daysBack = 2) {
    const now = Date.now();
    const toDate = new Date(now).toISOString().split('T')[0];
    const fromDate = new Date(now - daysBack*24*3600*1000).toISOString().split('T')[0];
    await this.log(`🧮 Reconciliation started for ${fromDate}..${toDate}`);
    const remote = await this.fetchTempoWorklogs(fromDate, toDate);
    if (!remote) {
      this.lastReconciliationSummary = { ok:false, error:'Fetch failed', at: new Date().toISOString() };
      return this.lastReconciliationSummary;
    }
    const remoteByComposite = new Set(remote.map(w => {
      // Composite key: date|issueId|roundedMinutes
      const minutes = Math.round((w.timeSpentSeconds||0)/60);
      return `${w.startDate}|${w.issue?.key||w.issueKey}|${minutes}`;
    }));
    const candidateSessions = this.sessions.filter(s => s.duration >= CONFIG.workSessionThreshold);
    const missing = [];
    for (const s of candidateSessions) {
      const date = this._sessionDate(s);
      const minutes = Math.round((s.duration||0)/60000);
      const issue = s.loggedIssueKey || s.detectedIssue || (this.detectActivityType(s).isMeetingActivity ? CONFIG.defaultMeetingIssue : null);
      if (!issue) continue; // cannot reconcile without an issue
      const key = `${date}|${issue}|${minutes}`;
      if (!remoteByComposite.has(key)) {
        missing.push({ id: s.id, issue, date, minutes, status: s.logStatus, reason: s.logReason });
      }
    }
    // Attempt re-log for missing sessions that are not already logged or error and have issue
    const relogged = [];
    for (const m of missing) {
      const session = this.sessions.find(ss => ss.id === m.id);
      if (!session) continue;
      if (session.logStatus === 'logged' && session.loggedWorklogId) continue; // already good
      if (session._relogAttempted) continue;
      if (session.duration < CONFIG.workSessionThreshold) continue;
      try {
        session._relogAttempted = true;
        await this.log(`♻️ Re-log attempt for session ${session.id} (${this.formatDuration(session.duration)}) issue=${m.issue}`);
        const result = await this.logTimeToTempo(session);
        relogged.push({ id: session.id, worklogId: session.loggedWorklogId || result?.id || null });
      } catch (e) {
        await this.log(`❌ Re-log failed for session ${session.id}: ${e.message}`);
      }
    }
    this.lastReconciliation = Date.now();
    this.lastReconciliationSummary = {
      ok: true,
      at: new Date().toISOString(),
      window: { fromDate, toDate },
      remoteCount: remote.length,
      candidateSessions: candidateSessions.length,
      missingBeforeRelog: missing.length,
      relogged: relogged.length
    };
    await this.log(`🧮 Reconciliation complete: remote=${remote.length}, candidates=${candidateSessions.length}, missing=${missing.length}, relogged=${relogged.length}`);
    return this.lastReconciliationSummary;
  }

  scheduleReconciliation() {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    const intervalHours = parseFloat(process.env.AI_AGENT_RECONCILE_INTERVAL_HOURS || '6');
    const ms = intervalHours * 3600 * 1000;
    this.reconciliationTimer = setInterval(() => {
      this.reconcileWorklogs(parseInt(process.env.AI_AGENT_RECONCILE_DAYS_BACK || '2',10)).catch(()=>{});
    }, ms);
    this.log(`🗓️ Reconciliation scheduled every ${intervalHours}h (daysBack=${process.env.AI_AGENT_RECONCILE_DAYS_BACK || '2'})`);
  }

  // Public API trigger for reconciliation
  async triggerReconciliation(daysBack) {
    return this.reconcileWorklogs(daysBack || parseInt(process.env.AI_AGENT_RECONCILE_DAYS_BACK || '2',10));
  }

  // ==== AI daily note integration ===========================================
  async logDailyBlocks(structuredDay) {
    const results = [];
    for (const block of structuredDay.blocks) {
      try {
        const minutes = block.minutes;
        if (!minutes || minutes < 1) continue;
        const issueKey = block.issueKey || (block.type === 'meeting' ? CONFIG.defaultMeetingIssue : null);
        if (!issueKey) {
          results.push({ block, status: 'skipped', reason: 'no-issue' });
          continue;
        }
        // Create a synthetic session object to reuse existing logTimeToTempo
        const startDate = new Date(`${structuredDay.date}T${block.start || '09:00'}:00`);
        const durationMs = minutes * 60000;
        const session = {
          id: `daily_${structuredDay.date}_${block.start}_${issueKey}_${Math.random().toString(36).slice(2,8)}`,
          startTime: startDate.getTime(),
          endTime: startDate.getTime() + durationMs,
          duration: durationMs,
          confidence: 100,
          detectedIssue: issueKey,
          applications: [],
          windowTitles: [],
          directories: [],
          gitBranches: new Set(),
          microEvents: [],
          blockType: block.type
        };
        if (block.type === 'meeting') {
          session._forcedMeeting = true;
        }
        const description = `[DailyNotes:${block.type}] ${block.description}`;
        // Temporarily wrap generateWorkDescription override
        const originalGenerate = this.generateWorkDescription.bind(this);
        this.generateWorkDescription = () => description;
        try {
          const resp = await this.logTimeToTempo(session);
          results.push({ block, status: 'logged', worklogId: session.loggedWorklogId || resp?.id });
        } finally {
          this.generateWorkDescription = originalGenerate;
        }
      } catch (e) {
        results.push({ block, status: 'error', error: e.message });
      }
    }
    return { date: structuredDay.date, results };
  }

  // API endpoints for integration with the web interface
  async getSessionHistory(days = 7) {
    await this.log(`📅 Retrieving session history for last ${days} days`);
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const sessions = this.sessions.filter(session => session.startTime >= cutoff).map(s => ({
      ...s,
      logStatus: s.logStatus || (this.loggedSessions.has(s.id) ? 'logged' : 'unknown'),
      logReason: s.logReason || (this.loggedSessions.has(s.id) ? 'logged' : 'not-logged'),
      loggedIssueKey: s.loggedIssueKey || (s.logStatus === 'logged' ? (s.detectedIssue || (s.meeting ? 'MEETING' : undefined)) : undefined),
      loggedWorklogId: s.loggedWorklogId || undefined
    }));
    await this.log(`📋 Found ${sessions.length} sessions in the last ${days} days`);
    return sessions;
  }

  async getPendingSessions() {
    return this.sessions.filter(session => {
      if (this.loggedSessions.has(session.id) || 
          session.duration < CONFIG.workSessionThreshold) {
        return false;
      }
      
      const activityType = this.detectActivityType(session);
      
      // Include meeting activities or story development sessions
      return activityType.isMeetingActivity || session.detectedIssue;
    });
  }

  async approveSession(sessionId) {
    await this.log(`✅ Attempting to approve session: ${sessionId}`);
    const session = this.sessions.find(s => s.id === sessionId);
    if (session && !this.loggedSessions.has(sessionId)) {
      await this.log(`🚀 Approving and logging session: ${session.detectedIssue || 'Unknown'} - ${this.formatDuration(session.duration)}`);
      await this.logTimeToTempo(session);
      this.loggedSessions.add(sessionId);
      await this.saveData();
      await this.log(`✅ Session ${sessionId} approved and logged successfully`);
      return true;
    }
    await this.log(`❌ Cannot approve session ${sessionId} - not found or already logged`);
    return false;
  }

  async rejectSession(sessionId) {
    await this.log(`❌ Rejecting session: ${sessionId}`);
    this.loggedSessions.add(sessionId); // Mark as processed (rejected)
    await this.saveData();
    await this.log(`✅ Session ${sessionId} marked as rejected`);
    return true;
  }

  async updateSessionIssue(sessionId, newIssueKey) {
    await this.log(`📝 Updating session ${sessionId} issue to: ${newIssueKey}`);
    const session = this.sessions.find(s => s.id === sessionId);
    if (session) {
      const oldIssue = session.detectedIssue;
      session.detectedIssue = newIssueKey;
      session.confidence = 100; // Manual override gives 100% confidence
      await this.saveData();
      await this.log(`✅ Session ${sessionId} issue updated: ${oldIssue} -> ${newIssueKey} (confidence: 100%)`);
      return true;
    }
    await this.log(`❌ Cannot update session ${sessionId} - not found`);
    return false;
  }

  getStatus() {
    // Reset metrics hourly to keep them bounded
    const now = Date.now();
    if (now - this._metrics.lastReset > 60 * 60 * 1000) {
      this._metrics.activeAppTimeouts = 0;
      this._metrics.runningAppsFailures = 0;
      this._metrics.lastReset = now;
    }

    return {
      isRunning: this.isRunning,
      isTestMode: isTestMode,
      isDryRun: isDryRun,
      config: {
        monitoringInterval: CONFIG.monitoringInterval / 1000,
        workSessionThreshold: CONFIG.workSessionThreshold / 1000,
        autoLogThreshold: CONFIG.autoLogThreshold / 1000
      },
      currentSession: this.currentSession ? {
        id: this.currentSession.id,
        duration: this.formatDuration(this.currentSession.duration),
        detectedIssue: this.currentSession.detectedIssue,
        confidence: this.currentSession.confidence
      } : null,
      totalSessions: this.sessions.length,
      loggedSessions: this.loggedSessions.size,
      pendingSessions: this.sessions.filter(s => !this.loggedSessions.has(s.id) && s.detectedIssue).length,
      assignedIssues: this.assignedIssues.length,
      metrics: {
        activeAppTimeouts: this._metrics.activeAppTimeouts,
        runningAppsFailures: this._metrics.runningAppsFailures,
        runningAppsBackoffMs: this._metrics.backoff.runningAppsDelay,
        runningAppsConsecutiveFailures: this._metrics.backoff.failures,
        meetings: CONFIG.enableMeetingMetrics ? this._metrics.meetings : undefined,
        development: CONFIG.enableMeetingMetrics ? this._metrics.development : undefined,
        runningAppsFallbacks: this._metrics.runningAppsFallbacks
      }
    };
  }
}

// Export for use as a module
module.exports = AITimeTrackingAgent;

// If running directly, start the agent
if (require.main === module) {
  const agent = new AITimeTrackingAgent();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down AI agent...');
    await agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nShutting down AI agent...');
    await agent.stop();
    process.exit(0);
  });

  // Start the agent
  agent.start().catch(error => {
    console.error('Failed to start AI agent:', error);
    process.exit(1);
  });
}