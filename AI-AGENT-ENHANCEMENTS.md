# AI Agent Enhancements

## Overview
The AI Time Tracking Agent has been enhanced with sophisticated activity detection and automatic time logging with proper work attributes based on the type of activity detected.

## New Features

### 1. Story Development Detection
When the AI agent detects development work on any story:
- **Time Category**: `Execution`
- **Technology Time Type**: `CapitalizableWritingCode`
- **Target**: The detected story/issue key
- **Description**: Includes development tools used, Git branch, and activity details

### 2. Microsoft Teams Call Detection
When the AI agent detects Microsoft Teams calls or meetings:
- **Time Category**: `MeetingCollaboration`
- **Technology Time Type**: `CapitalizableTechnicalDiscussion`
- **Target**: `CON22-2208` (configurable via `AI_AGENT_CONFIG.defaultMeetingIssue`)
- **Description**: Includes meeting details and applications used

## Enhanced Detection Logic

### Activity Type Detection
The agent now distinguishes between:
1. **Story Development Activities**
   - VS Code, IntelliJ, Terminal usage
   - Git operations
   - Development-related window titles
   - JIRA issue key detection

2. **Meeting/Collaboration Activities**
   - Microsoft Teams, Zoom, Skype usage
   - Meeting-related keywords in window titles
   - Call/meeting activity patterns

### Improved Confidence Scoring
- Meeting apps detection: +40 points
- Development tools: +30 points
- JIRA keys in titles: +40 points
- Meeting keywords: +30 points
- Git branches: +20 points
- Development directories: +10 points

## Work Attributes Mapping

### For Story Development (`isStoryDevelopment: true`)
```javascript
attributes: [
  {
    key: "_TimeCategory_",
    value: "Execution"
  },
  {
    key: "_TechnologyTimeType_", 
    value: "CapitalizableWritingCode"
  }
]
```

### For Meeting Activities (`isMeetingActivity: true`)
```javascript
attributes: [
  {
    key: "_TimeCategory_",
    value: "MeetingCollaboration"
  },
  {
    key: "_TechnologyTimeType_",
    value: "CapitalizableTechnicalDiscussion"
  }
]
```

## Configuration

### Default Meeting Issue
The default issue for logging meeting time can be configured:
```javascript
AI_AGENT_CONFIG.defaultMeetingIssue = 'CON22-2208'
```

### Auto-Logging Behavior
- **Story Development**: Requires detected issue + confidence ≥ 70%
- **Meeting Activities**: Auto-logs to default meeting issue regardless of confidence
- **Minimum Session**: 15 minutes
- **Auto-log Threshold**: 1 hour of continuous activity

## Enhanced Descriptions

The work descriptions now include:
- Activity type (Development vs Meeting/Collaboration)
- Primary applications used
- Git branch information (for development)
- Time period
- Confidence score

## Example Log Entries

### Story Development
```
✅ Auto-logged 2h 15m to CON22-4567 (Story Development) - Worklog ID: 12345
Description: Development work using Visual Studio Code, Terminal. Working on branch: feature/user-auth. Activity: Story Development. Time: 09:00:00 - 11:15:00. (Auto-tracked with 85% confidence)
```

### Microsoft Teams Call
```
✅ Auto-logged 45m to CON22-2208 (Meeting/Collaboration) - Worklog ID: 12346
Description: Meeting/collaboration using Microsoft Teams. Activity: Meeting/Collaboration. Time: 14:00:00 - 14:45:00. (Auto-tracked with 70% confidence)
```

## Benefits

1. **Accurate Time Categorization**: Proper work attributes ensure compliance with time tracking requirements
2. **Automatic Meeting Logging**: No manual intervention needed for Teams calls
3. **Improved Detection**: Better distinction between development and collaboration activities
4. **Configurable**: Meeting issue target can be easily changed
5. **Detailed Logging**: Enhanced descriptions provide better audit trail

## Technical Implementation

### Key Methods Added/Modified
- `detectActivityType()`: Determines if activity is meeting or development
- `getWorkAttributes()`: Returns appropriate attributes based on activity type
- `logTimeToTempo()`: Enhanced with activity-based attribute assignment
- `calculateConfidence()`: Improved scoring for meeting activities
- `generateWorkDescription()`: Activity-aware description generation

### Enhanced Applications Detection
- Microsoft Teams, Teams, Zoom, Skype, Meet, WebEx
- Meeting keywords: meeting, call, teams, zoom, standup, sync, discussion
- Development keywords: expanded to include collaboration tools

This enhancement ensures that all work time is properly categorized and logged with the appropriate attributes, meeting both development tracking and meeting collaboration requirements.

---

## Active Window Sampler (Foreground Monitoring)

### Overview
An optional high-frequency (15–60s) sampler now runs alongside the main 5‑minute monitoring loop to capture foreground window changes sooner. This improves:
1. Faster JIRA key detection (from browser tab URL or VS Code window title)
2. Earlier and more reliable meeting identification
3. Smoother session continuity for rapid app/tab switches

### Configuration
```javascript
AI_AGENT_CONFIG.enableActiveWindowSampler = true;           // Feature flag
AI_AGENT_CONFIG.activeWindowSamplingInterval = 60000;       // 60s production
AI_AGENT_TEST_CONFIG.activeWindowSamplingInterval = 15000;  // 15s test mode
```

### What It Captures (Micro Events)
Each sample (only on change) records a compact object:
```json
{
  "t": 1736612345678,             // timestamp
  "app": "Google Chrome",        // active app
  "title": "CON22-1234 | Jira",  // truncated window title
  "browser": { "host": "jira.company.com", "isJira": true, "hasKey": true },
  "jiraKey": "CON22-1234",       // if extracted from title or URL
  "source": "url"                // 'title', 'url', or 'title+url'
}
```
Max stored per session: 200 (oldest dropped).

### Privacy Safeguards
- Only host part of browser URL retained; full path/query discarded.
- Non‑JIRA URLs are not persisted beyond host + boolean flags.
- No keystrokes, clipboard, or background process lists beyond what was already collected.
- Feature can be disabled via `enableActiveWindowSampler`.

### Issue Detection Enhancements
Detection order now prioritizes (highest certainty first):
1. Recent microEvents with a JIRA key belonging to an assigned issue
2. Current window title / git branch pattern match
3. Browser URL JIRA key (if last event marks it as JIRA)
4. Keyword fallback against assigned issue summaries

### Confidence Model Changes
| Signal | Previous | New |
|--------|----------|-----|
| JIRA key (generic) | +40 | Title-only: +30 |
| Browser URL JIRA key | N/A | Adds up to reach combined +50 (caps total from title+url) |
| Meeting apps/keywords | unchanged | unchanged |

Rationale: Distinguish origin of key (UI title vs URL) while preventing double counting.

### Session Refinement
If the sampler finds a new, assigned JIRA key mid-session, the session's `detectedIssue` is updated and confidence bumped to at least 70% (pending full recalculation).

### Failure Handling
- AppleScript failures (e.g., browser closed) are silently ignored; sampler continues.
- URL retrieval attempted only when active app is a known browser (Chrome, Brave, Edge, Safari).

### When to Disable
- Battery sensitive scenarios
- Non-macOS systems (current implementation is macOS-only)
- Privacy policies restricting window title capture

### Future Extensions (Not Implemented Yet)
- Linux (X11/Wayland) or Windows (Win32 API) foreground window adapters
- Tab-level classification for multi-issue workflows
- Machine learning ranking for keyword-based matches

---