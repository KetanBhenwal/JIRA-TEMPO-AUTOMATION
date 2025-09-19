# JIRA Tempo Time Logger with AI Agent

A web application and AI-powered background agent to help you log work time for JIRA issues automatically.

## ✨ NEW: AI Time Tracking Agent

🤖 **Automated Time Tracking**: The AI agent runs in the background, monitors your work activity, and automatically logs time to JIRA Tempo!

### AI Agent Features

- 🔍 **Smart Detection**: Monitors active applications, window titles, Git branches, and development activity
- 🎯 **Issue Recognition**: Automatically detects which JIRA issues you're working on
- ⚡ **Auto-Logging**: High-confidence work sessions are logged automatically
- 👀 **Manual Review**: Medium-confidence sessions await your approval via web interface
- 📊 **Dashboard**: Beautiful web dashboard to monitor, approve, and manage tracked sessions
- 🛡️ **Privacy-First**: All monitoring happens locally on your machine

## Features

- View all JIRA issues assigned to you
- Search and filter your issues
- Display issues where you were mentioned in comments as "Adhoc Tasks"
- Log time with description, date, and start time
- Dynamic fetching of required custom fields from Tempo API
- Support for required custom fields in your Tempo configuration
- User-friendly interface
- **NEW: AI-powered background time tracking**
- **NEW: Automatic JIRA issue detection**
- **NEW: Smart work session management**

## New in Latest Version
- 🤖 **AI Time Tracking Agent** - Automatically monitors and logs your work
- 📊 **AI Agent Dashboard** - Web interface to manage auto-tracked sessions
- 🎯 **Smart Issue Detection** - Recognizes JIRA issues from window titles and Git branches
- ⚡ **Auto-Logging** - High-confidence sessions logged automatically
- 👀 **Review Interface** - Approve or reject detected work sessions
- 📈 **Session Analytics** - Track your work patterns and productivity
- Added support for fetching work attributes from Tempo Core API
- Dynamic dropdowns for Time Type and Technology Time Type fields
- Added "Adhoc Tasks" section for issues where you were mentioned in comments but not assigned
- Fixed issues with invalid attribute values

### JIRA User Endpoint
Added endpoint `GET /api/jira/me` returning current authenticated JIRA user profile (accountId, displayName, emailAddress (if permitted), timeZone, locale, groups, avatar URLs). See "API: JIRA Current User" section below.

## Prerequisites

- Node.js (v14 or higher)
- JIRA account with API token
- Tempo account with API token

## Setup (macOS / Linux Quick Start)

1. **Install dependencies:**
   ```sh
   npm install
   ```

   If you pulled an updated version of the repository that added new scripts (e.g. cross‑platform init launcher), run `npm install` again to ensure `cross-env` and any new dev dependencies are installed.

2. **Configure environment variables:**
   - Create a `.env` file with the following content:
     - `JIRA_BASE_URL` (e.g., https://yourcompany.atlassian.net/)
     - `TEMPO_BASE_URL` (should be https://api.tempo.io/4)
     - `JIRA_EMAIL` (your Atlassian email)
     - `JIRA_API_TOKEN` (from https://id.atlassian.com/manage-profile/security/api-tokens)
     - `TEMPO_API_TOKEN` (from Tempo settings)
     - `TEMPO_ACCOUNT_ID` (your Atlassian account ID)
     - `PORT` (optional, defaults to 3000)
   - `LLM_PROVIDER` (optional: `openai` or `ollama`; auto-detects `openai` if OPENAI_API_KEY present, else `ollama`)
   - `LLM_MODEL` (e.g. `gpt-4o-mini`, `gpt-4o`, `mistral:latest`, or local Ollama model like `qwen2.5:7b`)
   - `OPENAI_API_KEY` (required only when using OpenAI provider)
   - `OLLAMA_BASE_URL` (optional, default `http://localhost:11434`)
   - `LLM_MAX_MINUTES_PER_DAY` (cap for parsed AI daily notes, default 720)

3. **Start the application (interactive menu, cross‑platform):**

   **Recommended (Node launcher – works on Windows/macOS/Linux)**
   ```sh
   npm run setup
   ```
   (Falls back to legacy shell script on macOS/Linux if you prefer: `./start-ai-agent.sh`)

   **Option 2: Web Server + Manual AI Control**
   ```sh
   npm start
   ```
   Then navigate to the AI Agent dashboard to start/stop the agent.

   **Option 3: AI Agent Only (Background)**
   ```sh
   npm run ai-agent
   ```

   **Option 4: Fast Test Mode (auto intervals + dry run)**
   ```sh
   npm run agent:test
   ```

4. **Access the interfaces:**
   - **Main Time Logger:** `http://localhost:3000`
   - **AI Agent Dashboard:** `http://localhost:3000/ai-agent.html`

## Windows Users 🪟

You now have native scripts:

| Purpose | Command |
|---------|---------|
| Interactive menu | `npm run setup` or double‑click `start-ai-agent.bat` |
| PowerShell advanced | `./start-ai-agent.ps1 -Test -DryRun` |
| Start agent (prod) | `npm run agent:prod` |
| Start test mode | `npm run agent:test` |
| Status | `npm run ai-status` |

Notes:
1. Browser URL + active window detection is currently macOS‑optimized. Windows implementation provides foreground window title and process via PowerShell (sufficient for issue key detection in editors/terminals). Browser URL introspection for Edge/Chrome is a future enhancement (would require enabling remote debugging protocol).
2. Meeting detection still works using window title / process name heuristics (Teams/Zoom). If you run into edge cases, set `AI_AGENT_VERBOSE_LOG=true` to collect a sample and open an issue.
3. All paths use `path` module so backslashes are handled automatically.

## Scaling & Performance ⚙️

Recent improvements (this version):
* Concurrency & rate‑limited child process execution (`limitedExec`) prevents spawn storms.
* Cached activity type classification (5s window) reduces repeated regex scans for each API request.
* Optional verbose logging (`AI_AGENT_VERBOSE_LOG=true`) to cut I/O overhead in normal mode.
* Windows + Linux fallbacks for active app & window enumeration (best effort where OS APIs differ).
* Reduced synchronous shell usage (removed `pwd`, consolidated enumeration logic).

Environment knobs (override in `.env` or runtime config endpoints):
| Variable | Purpose |
|----------|---------|
| `AI_AGENT_TEST_MODE` | Fast test intervals (see test config) |
| `AI_AGENT_DRY_RUN` | Prevents actual Tempo logging |
| `AI_AGENT_VERBOSE_LOG` | Force detailed logs (default off in prod) |
| `AI_AGENT_RUNNING_APPS_REFRESH_MS` | Override refresh cadence for running app enumeration |
| `AI_AGENT_MEETING_SCORE_THRESHOLD` | Tune meeting classification threshold (default 7) |
| `AI_AGENT_LEGACY_MEETING_DETECTION` | Force legacy simpler meeting detection |

Runtime adjustments (no restart): PATCH `/api/ai-agent/runtime-config` with fields like `monitoringInterval`, `workSessionThreshold`, etc. (values in ms or minutes auto‑converted if <1000).

Optimization tips:
1. Increase `monitoringInterval` if machine is resource constrained (e.g., from 5m to 7m) – sampler still gives fine‑grained context.
2. If you experience high CPU from PowerShell enumeration on Windows, set `AI_AGENT_VERBOSE_LOG=false` and lengthen `AI_AGENT_RUNNING_APPS_REFRESH_MS` (e.g., 600000 for 10m).
3. Use dry run test mode before rolling changes to production accounts.

## Fresh Setup & Reset ♻️

On first run (`npm run setup`) the project will:
* Copy `.env.example` to `.env` if missing.
* Remove any stale data/log files.
* Create a sentinel `.initialized` file.

To force a clean slate later:
```sh
npm run reset
```
This sets `AI_AGENT_RESET=true`, deletes agent data/logs, and preserves your `.env`.

Manual one-off initialization (non-interactive):
```sh
npm run init
```

If you need to regenerate `.env`, delete it and re-run `npm run init` (your credentials will need to be re-entered).

## API: JIRA Current User

Endpoint:

```
GET /api/jira/me
```

Sample curl:

```sh
curl -s http://localhost:3000/api/jira/me | jq
```

Sample JSON response:
```json
{
   "accountId": "557058:abcd1234-ef56-7890-abcd-112233445566",
   "displayName": "Jane Developer",
   "emailAddress": "jane.dev@example.com",
   "timeZone": "America/New_York",
   "locale": "en_US",
   "groups": ["jira-software-users", "engineering"],
   "rawAvatarUrls": {
      "48x48": "https://avatar-cdn.atlassian.com/jira-avatar-48.png"
   }
}
```

Notes:
1. `emailAddress` may be `null` if Atlassian privacy settings restrict it for API tokens.
2. `groups` retrieval may fail silently (non-fatal) if the API token lacks permission; the endpoint will still return other fields.
3. No secrets are returned; only what JIRA exposes for the authenticated account.
4. If you need custom fields (e.g., application roles), extend the route in `server.js` inside `/api/jira/me`.

Errors:
```json
{
   "error": "Failed to fetch JIRA user",
   "status": 401,
   "message": "Request failed with status code 401"
}
```

Troubleshooting:
- 401/403: Verify `JIRA_EMAIL` + `JIRA_API_TOKEN` pair and that the token wasn't revoked.
- Empty groups: Ensure the token user has permission to browse groups, or ignore if not needed.
- CORS: Server already enables CORS globally; frontend can call directly from `public` pages.

## 🤖 AI Agent Usage

### Quick Start
1. Run `./start-ai-agent.sh` and choose option 1
2. Open the AI Agent dashboard at `http://localhost:3000/ai-agent.html`
3. Click "Start Agent" to begin monitoring
4. Work on your JIRA issues as usual
5. Review and approve detected sessions in the dashboard

### How the AI Agent Works

1. **Monitoring**: Continuously monitors your:
   - Active applications (VS Code, Terminal, browsers, etc.)
   - Window titles (looking for JIRA keys and project names)
   - Git branches and repositories
   - Work hours (9 AM - 6 PM on weekdays)

2. **Detection**: Uses multiple strategies to identify work sessions:
   - JIRA key patterns in window titles (e.g., "PROJ-123")
   - Development tool usage (VS Code, Terminal, IDEs)
   - Git branch analysis
   - Keyword matching with assigned issues

3. **Auto-Logging**: 
   - **High confidence (≥70%)**: Automatically logs to Tempo
   - **Medium confidence (60-69%)**: Awaits your approval
   - **Low confidence (<60%)**: Ignored

4. **Review**: Use the web dashboard to:
   - View detected sessions
   - Approve/reject pending sessions
   - Correct issue assignments
   - Monitor auto-logged time

### AI Agent Commands

```sh
# Start the AI agent in background
npm run ai-agent

# Check agent status
npm run ai-status

# Interactive setup menu
./start-ai-agent.sh
```

## 🧠 LLM / OpenAI Integration
### Enhanced Issue Detection & Exclusions

The agent now employs a weighted evidence scoring pipeline (instead of single-hit heuristics) to choose the most likely JIRA issue. Each potential issue key accumulates score contributions from factors:

| Factor | Weight (default) | Notes |
|--------|------------------|-------|
| Direct key in window title / open file / branch | +40 | First occurrence per snapshot |
| Git branch contains key | +35 | Applied once per activity cycle |
| Micro-event (URL/title) key | +30 | High-frequency sampler events |
| Issue summary keyword overlaps | up to +20 | 4 per matching keyword (cap) |
| Recent frequency (last 50 micro events) | up to +15 | 3 per repeat (cap) |
| Excluded path/branch penalty | -100 | Effectively disqualifies workspace |

Top candidate wins unless the margin to the second candidate < 15 points (ambiguous). Ambiguous sessions optionally invoke an LLM refinement step (placeholder baseline currently returns the top candidate; can be expanded).

### Exclusion Rules
Exclude noise sessions (e.g., time spent working on this tracking tool itself) by path or branch:

Environment variables:
```dotenv
AI_AGENT_EXCLUDED_PATH_KEYWORDS=jira-tempo,jira_tempo,jira-tempo-automation
AI_AGENT_EXCLUDED_BRANCHES=main,master
AI_AGENT_MIN_SESSION_CONFIDENCE=0        # Minimum normalized score to accept (0–100)
AI_AGENT_DETECTION_VERBOSE=false         # Set true for detailed detection logs
AI_AGENT_LLM_REFINE_DETECTION=false      # Enable LLM refinement on ambiguous candidates
```

If a current directory contains any excluded keyword OR the git branch exactly matches an excluded branch, all candidate issue scores receive a -100 penalty. Meeting detection still functions independently.

### Structured Detection Logs
When `AI_AGENT_DETECTION_VERBOSE=true`, activity trace and log lines include:
```
🧮 Detection scoring -> Top PROJ-123=72 (ambiguous)
```
and an internal trace record `detect:score` with the top factor breakdown (in `ai-agent-activity-trace.log` if activity tracing enabled).

### LLM Refinement (Experimental)
Set `AI_AGENT_LLM_REFINE_DETECTION=true` to enable an extra refinement pass for ambiguous cases. Current implementation is a placeholder; future iterations can send a condensed context prompt to the configured LLM provider to adjudicate between close candidates.

### Migration & Backward Compatibility
Set `AI_AGENT_LEGACY_DETECTION=true` to revert to prior heuristic behavior. Leave unset (default) to use the scoring pipeline.


The project supports two interchangeable LLM providers for parsing Daily Notes into structured time blocks:

| Provider | Set `LLM_PROVIDER` | Key Env Vars | Typical Model | When to Use |
|----------|-------------------|--------------|---------------|-------------|
| OpenAI   | `openai`          | `OPENAI_API_KEY`, `LLM_MODEL` | `gpt-4o-mini` / `gpt-4o` | Highest quality / reasoning |
| Ollama (local) | `ollama` (default if no OpenAI key) | `OLLAMA_BASE_URL`, `LLM_MODEL` | `qwen2.5:7b`, `mistral:latest` | Offline / cost control |

### Switching Providers
1. Add to `.env` for OpenAI:
   ```dotenv
   LLM_PROVIDER=openai
   OPENAI_API_KEY=sk-...your key...
   LLM_MODEL=gpt-4o-mini
   ```
2. Or for local Ollama:
   ```dotenv
   LLM_PROVIDER=ollama
   OLLAMA_BASE_URL=http://localhost:11434
   LLM_MODEL=qwen2.5:7b
   ```
3. Restart the server (or let Node auto-reload if you use a watcher). The parser auto-selects based on `LLM_PROVIDER` (falls back to `openai` if key present and provider unset).

### Daily Notes Parsing Flow
`/api/ai/log-daily-notes` → `llmParser.parseDailyNotes()` → provider-specific call (OpenAI Chat Completions w/ JSON mode OR Ollama `/api/generate`).

### Error Handling
- Missing `OPENAI_API_KEY` with `LLM_PROVIDER=openai` throws fast with clear error.
- Non‑JSON responses raise `LLM returned non-JSON content` so you can inspect logs and adjust prompt or model.

### Cost & Safety Controls
- `LLM_MAX_MINUTES_PER_DAY` enforces an upper bound on parsed total minutes (default 720) adding a warning if exceeded.
- Temperature fixed low (0.1) for deterministic parsing.

### Recommended OpenAI Models
| Use Case | Model |
|----------|-------|
| Fast / cost‑efficient | `gpt-4o-mini` |
| Higher context / reasoning | `gpt-4o` |

If using a different JSON-capable model ensure it supports `response_format: { type: 'json_object' }`.

### Troubleshooting
| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| "LLM_PROVIDER=openai but OPENAI_API_KEY missing" | Key not set or typo | Add valid key to `.env` |
| "LLM returned non-JSON content" | Model ignored instructions | Retry; ensure JSON mode supported; lower temperature |
| Long latency | Large model or cold start | Switch to mini model or local Ollama |
| Empty `blocks` array | Notes too vague | Provide clearer time annotations (e.g., "CON22-123 2h backend refactor") |

---

## Manual Time Logging (Web Interface)

1. When you open the web interface, it will automatically fetch and display:
   - Your assigned JIRA issues
   - Issues where you were mentioned in comments but not assigned (under "Adhoc Tasks")
2. You can use the search boxes to filter issues by key, summary, or status
3. Click the "Log Time" button next to any issue to select it for time logging
4. Fill in the required details:
   - Time spent (in hours)
   - Work description
   - Date
   - Start Time (HH:MM:SS format)
   - Time Type (required custom field)
   - Task Type (required custom field)
   - Technology Time Type (required custom field)
5. Click "Submit Time Log" to record your work time
6. You'll see a success message with the worklog ID when the time is successfully logged

## Security

This application stores your JIRA and Tempo API tokens in the `.env` file, which should never be committed to version control.

## Note

Legacy command-line scripts have been moved to the `/unused` directory for reference. The web application is now the recommended way to log time.

1. **JIRA API Token Issues:**
   - Generate a new token at https://id.atlassian.com/manage-profile/security/api-tokens
   - Update your .env file

2. **Tempo API Issues:**
   - Verify your Tempo API token in Tempo settings
   - Make sure your account has Tempo access

3. **Issue ID vs Key:**
   - Tempo API v4 requires numeric issue IDs, not issue keys
   - Use `tempo-logger-id.js` for most reliable results

## Security
- Do not commit your `.env` file to version control.
- Your API tokens and account IDs are sensitive information.
