// Tests OpenAI branch of llmParser without making real network calls.
// We mock the 'openai' module before requiring llmParser so that
// parseDailyNotes uses the stub client.

function buildMockJson() {
  return {
    date: '2025-09-24',
    totalMinutes: 45, // Intentionally off; real sum = 50
    blocks: [
      { start: '10:00', end: '10:15', minutes: 15, type: 'meeting', issueKey: null, description: 'Sprint planning session' },
      { start: '10:15', end: '11:20', minutes: 35, type: 'development', issueKey: 'CON22-1234', description: 'Implement parser improvements' }
    ],
    warnings: []
  };
}

// Helper to dynamically mock openai with a specific raw content return
function mockOpenAIReturning(rawContent) {
  jest.doMock('openai', () => {
    class MockOpenAI {
      constructor() {}
      chat = {
        completions: {
          create: async () => ({
            choices: [ { message: { content: rawContent } } ]
          })
        }
      };
    }
    return { OpenAI: MockOpenAI };
  });
}

describe('llmParser OpenAI provider', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV }; // restore each time
  });

  test('parses and enriches blocks using mocked gpt-5.5-turbo response', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key'; // dummy
    process.env.LLM_MODEL = 'gpt-5.5-turbo';

    const payload = buildMockJson();
    mockOpenAIReturning(JSON.stringify(payload));

    // Now load module inside isolateModules so our mock applies
    let parseDailyNotes, MODEL;
    jest.isolateModules(() => {
      ({ parseDailyNotes, MODEL } = require('../llmParser'));
    });

    expect(MODEL).toBe('gpt-5.5-turbo');

    const result = await parseDailyNotes({
      date: payload.date,
      notes: 'Planning then coding parser improvements',
      issues: [{ key: 'CON22-1234', summary: 'Parser improvements' }]
    });

    // Total minutes corrected to 50 (15 + 35)
    expect(result.totalMinutes).toBe(50);
    expect(result.blocks).toHaveLength(2);

    const meeting = result.blocks[0];
    const dev = result.blocks[1];

    // Meeting enrichment: planning meeting should select Sprint Planning technology type
    expect(meeting.workAttribute).toBe('Meeting-Collaboration');
    expect(meeting.technologyTimeType).toBe('Capitalizable_Sprint_Planning');

    // Development enrichment defaults
    expect(dev.workAttribute).toBe('Execution');
    expect(dev.technologyTimeType).toBe('Capitalizable_Writing_Code');
  });

  test('throws on non-JSON OpenAI content', async () => {
    process.env.LLM_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.LLM_MODEL = 'gpt-5.5-turbo';

    mockOpenAIReturning('NOT_JSON');

    let parseDailyNotes;
    jest.isolateModules(() => {
      ({ parseDailyNotes } = require('../llmParser'));
    });

    await expect(parseDailyNotes({ date: '2025-09-24', notes: 'Some notes', issues: [] }))
      .rejects.toThrow('LLM returned non-JSON content');
  });
});
