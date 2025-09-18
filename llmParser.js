let OpenAI = null;
try { OpenAI = require('openai').OpenAI || require('openai'); } catch(_) {}

// Fetch strategy:
// 1. Use Node 18+ global fetch if available.
// 2. Otherwise lazy dynamic import node-fetch (v3 is ESM-only, so require() breaks / returns unexpected object).
// This avoids "TypeError: fetch is not a function" seen when using require('node-fetch') with v3 in CommonJS.
const fetchFn = global.fetch ? global.fetch.bind(global) : async (...args) => {
  const mod = await import('node-fetch');
  return mod.default(...args);
};

// Environment-driven model/provider abstraction
// Required env: OPENAI_API_KEY (if using OpenAI)
// Optional: LLM_MODEL (default gpt-4o-mini), LLM_MAX_MINUTES_PER_DAY (cap parsing)

const PROVIDER = (process.env.LLM_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'ollama')).toLowerCase();
const MODEL = process.env.LLM_MODEL || (PROVIDER === 'openai' ? 'gpt-4o-mini' : (process.env.OLLAMA_MODEL || 'qwen2.5:7b')); // example local default
const MAX_MIN_PER_DAY = parseInt(process.env.LLM_MAX_MINUTES_PER_DAY || '720',10); // 12h cap safety

let openaiClient = null;
if (PROVIDER === 'openai') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY missing');
  }
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function buildPrompt({ date, notes, issues }) {
  const issueList = issues.map(i => `- ${i.key}: ${i.summary}`).join('\n') || 'None';
  return `You are a strict time allocation parser for engineering work.
DATE: ${date}
KNOWN JIRA ISSUES (id: summary):\n${issueList}\n
USER FREE-FORM DAILY NOTES:\n"""\n${notes}\n"""\n
Extract DISTINCT time blocks the user actually spent. Rules:\n1. Output ONLY valid JSON matching schema.\n2. Sum of durations must not exceed ${MAX_MIN_PER_DAY} minutes.\n3. Merge very small fragments (<5m) into adjacent logical block.\n4. Classify each block as one of: meeting, development, review, planning, debugging, testing, other.\n5. If a known issue key clearly matches, include it. Otherwise attempt to infer from text (pattern ABC-123). If none, leave issueKey null.\n6. Provide a concise description (<=140 chars).\n7. If user mentions an external meeting (Teams/Zoom/etc) mark type=meeting even if no issue.\n8. For EACH block provide Tempo mapping fields: workAttribute (Time Category) and technologyTimeType (Technology Time Type) using these exact values: meeting->Meeting-Collaboration + Capitalizable_Technical Discussion (unless standup: Capitalizable_DailyStandup, planning: Capitalizable_Sprint_Planning, demo: Capitalizable_Sprint_Demo, retrospective: Capitalizable_Sprint_Retro), development->Execution + Capitalizable_Writing_Code, review->Execution + Capitalizable_Code_Review, debugging->Debugging + Capitalizable_Debugging _Code, testing->Execution + choose one: Capitalizable_Writing_Test_Cases OR Capitalizable_Execute_Test_Cases ("write/create/spec" => writing, "run/execute/verify/regression" => execute), planning->Meeting-Collaboration + Capitalizable_Sprint_Planning. If unsure leave null and add a warning.\n9. Maintain chronological ordering; approximate start times if missing.

JSON SCHEMA:
{
  "date": "YYYY-MM-DD",
  "totalMinutes": <number>,
  "blocks": [
     {
       "start": "HH:MM", // 24h local, if unknown approximate sequentially
       "end": "HH:MM",
       "minutes": <int>,
       "type": "meeting|development|review|planning|debugging|testing|other",
       "issueKey": "ABC-123" | null,
       "description": "string",
       "workAttribute": "Execution|Meeting-Collaboration|Debugging" | null,
  "technologyTimeType": "Capitalizable_Writing_Code|Capitalizable_Technical Discussion|Capitalizable_DailyStandup|Capitalizable_Sprint_Planning|Capitalizable_Sprint_Demo|Capitalizable_Sprint_Retro|Capitalizable_Code_Review|Capitalizable_Debugging _Code|Capitalizable_Writing_Test_Cases|Capitalizable_Execute_Test_Cases" | null
     }
  ],
  "warnings": ["string", ...]
}
Return ONLY JSON.`;
}

async function parseDailyNotes({ date, notes, issues=[] }) {
  const prompt = buildPrompt({ date, notes, issues });
  let raw;
  if (PROVIDER === 'openai') {
    const completion = await openaiClient.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You convert messy human day summaries into precise time blocks.'},
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    });
    raw = completion.choices[0].message.content;
  } else if (PROVIDER === 'ollama') {
    // Ollama local server (default port 11434). We'll request JSON-style output by wrapping instructions.
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const body = {
      model: MODEL,
      stream: false,
      // Provide explicit instruction to output JSON only
      prompt: `SYSTEM: You output ONLY JSON.\n${prompt}`
    };
    const resp = await fetchFn(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Ollama request failed: ${resp.status} ${txt}`);
    }
    const json = await resp.json();
    raw = json.response;
  } else {
    throw new Error(`Unsupported LLM_PROVIDER: ${PROVIDER}`);
  }
  let data;
  try { data = JSON.parse(raw); } catch(e) { throw new Error('LLM returned non-JSON content'); }
  // Basic validation
  if (!data.blocks || !Array.isArray(data.blocks)) {
    throw new Error('Parsed JSON missing blocks array');
  }
  // Enrich / normalize Tempo attribute fields
  const ATTR_DEFAULTS = {
    meeting: { workAttribute: 'Meeting-Collaboration', technologyTimeType: 'Capitalizable_Technical Discussion' },
    development: { workAttribute: 'Execution', technologyTimeType: 'Capitalizable_Writing_Code' },
    review: { workAttribute: 'Execution', technologyTimeType: 'Capitalizable_Code_Review' },
    planning: { workAttribute: 'Meeting-Collaboration', technologyTimeType: 'Capitalizable_Sprint_Planning' },
    debugging: { workAttribute: 'Debugging', technologyTimeType: 'Capitalizable_Debugging _Code' },
    testing: { workAttribute: 'Execution', technologyTimeType: 'Capitalizable_Execute_Test_Cases' },
    other: { workAttribute: null, technologyTimeType: null }
  };
  const meetingOverrides = [
    { re: /stand ?up|daily scrum/i, tech: 'Capitalizable_DailyStandup' },
    { re: /retro|retrospective/i, tech: 'Capitalizable_Sprint_Retro' },
    { re: /planning|groom|refine|refinement/i, tech: 'Capitalizable_Sprint_Planning' },
    { re: /demo|show ?case/i, tech: 'Capitalizable_Sprint_Demo' }
  ];
  data.blocks.forEach(b => {
    const base = ATTR_DEFAULTS[b.type] || ATTR_DEFAULTS.other;
    if (!b.workAttribute) b.workAttribute = base.workAttribute;
    if (!b.technologyTimeType) {
      if (b.type === 'meeting' && b.description) {
        const hit = meetingOverrides.find(m => m.re.test(b.description));
        b.technologyTimeType = hit ? hit.tech : base.technologyTimeType;
      } else if (b.type === 'testing' && b.description) {
        if (/write|create|spec/i.test(b.description)) b.technologyTimeType = 'Capitalizable_Writing_Test_Cases';
        else if (/run|execute|verify|regression/i.test(b.description)) b.technologyTimeType = 'Capitalizable_Execute_Test_Cases';
        else b.technologyTimeType = base.technologyTimeType;
      } else {
        b.technologyTimeType = base.technologyTimeType;
      }
    }
  });
  const sum = data.blocks.reduce((a,b)=>a+(b.minutes||0),0);
  if (sum !== data.totalMinutes) data.totalMinutes = sum;
  if (sum > MAX_MIN_PER_DAY) {
    data.warnings = data.warnings || [];
    data.warnings.push('Total minutes exceeded cap; consider review');
  }
  return data;
}

module.exports = { parseDailyNotes, PROVIDER, MODEL };
