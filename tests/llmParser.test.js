const path = require('path');

// Utility to mock Ollama JSON response
function mockOllamaResponse(payloadObj) {
  return {
    ok: true,
    json: async () => ({ response: JSON.stringify(payloadObj) })
  };
}

describe('llmParser.parseDailyNotes (Ollama provider mock)', () => {
  let originalEnv;
  let originalFetch;

  beforeAll(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch; // restore
  });

  afterEach(() => {
    jest.resetModules();
    if (global.fetch && global.fetch.mockRestore) {
      jest.restoreAllMocks();
    }
  });

  test('enriches missing workAttribute / technologyTimeType and adjusts totalMinutes', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.LLM_MAX_MINUTES_PER_DAY = '720';
    delete process.env.OPENAI_API_KEY; // ensure openai path not taken

    const mockPayload = {
      date: '2025-09-24',
      totalMinutes: 50, // incorrect on purpose; real sum is 60
      blocks: [
        { start: '09:00', end: '09:30', minutes: 30, type: 'meeting', issueKey: null, description: 'Daily standup sync' },
        { start: '09:30', end: '10:00', minutes: 30, type: 'development', issueKey: 'ABC-123', description: 'Implement feature logic' }
      ],
      warnings: []
    };

    // Spy on fetch to simulate Ollama response
    global.fetch = jest.fn().mockResolvedValue(mockOllamaResponse(mockPayload));

    const { parseDailyNotes, PROVIDER, MODEL } = require('../llmParser');

    expect(PROVIDER).toBe('ollama');
    const result = await parseDailyNotes({ date: mockPayload.date, notes: 'Standup + coding work', issues: [{ key: 'ABC-123', summary: 'Feature work' }] });

    // totalMinutes adjusted to real sum (60)
    expect(result.totalMinutes).toBe(60);
    expect(result.blocks).toHaveLength(2);

    const standupBlock = result.blocks[0];
    const devBlock = result.blocks[1];

    // Meeting enrichment: standup should get DailyStandup technology type
    expect(standupBlock.workAttribute).toBe('Meeting-Collaboration');
    expect(standupBlock.technologyTimeType).toBe('Capitalizable_DailyStandup');

    // Development enrichment defaults
    expect(devBlock.workAttribute).toBe('Execution');
    expect(devBlock.technologyTimeType).toBe('Capitalizable_Writing_Code');
  });

  test('applies cap warning when sum exceeds MAX_MINUTES_PER_DAY', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    process.env.LLM_MAX_MINUTES_PER_DAY = '45'; // low cap to trigger warning (sum will be 60)
    delete process.env.OPENAI_API_KEY;

    const mockPayload = {
      date: '2025-09-24',
      totalMinutes: 60,
      blocks: [
        { start: '09:00', end: '09:30', minutes: 30, type: 'development', issueKey: 'ABC-123', description: 'Core feature' },
        { start: '09:30', end: '10:00', minutes: 30, type: 'testing', issueKey: null, description: 'Run regression tests' }
      ],
      warnings: []
    };

    global.fetch = jest.fn().mockResolvedValue(mockOllamaResponse(mockPayload));

    // Re-require module to capture new env values
    jest.isolateModules(() => {
      const { parseDailyNotes } = require('../llmParser');
      return (async () => {
        const result = await parseDailyNotes({ date: mockPayload.date, notes: 'Feature + tests', issues: [{ key: 'ABC-123', summary: 'Feature' }] });
        expect(result.totalMinutes).toBe(60); // unchanged (already sum)
        expect(result.warnings).toEqual(expect.arrayContaining(['Total minutes exceeded cap; consider review']));
        // Testing block enrichment (should pick Execute Test Cases due to 'Run regression tests')
        const testingBlock = result.blocks[1];
        expect(testingBlock.workAttribute).toBe('Execution');
        expect(testingBlock.technologyTimeType).toBe('Capitalizable_Execute_Test_Cases');
      })();
    });
  });
});
