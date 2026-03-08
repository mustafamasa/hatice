import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Issue, OpencodeConfig, TrackerConfig, TokenUsage } from '../src/types.js';
import type { AgentRunnerOptions } from '../src/agent-runner.js';
import type { SessionLogger } from '../src/session-logger.js';
import type { RateLimitTracker } from '../src/rate-limiter.js';
import type { InputHandler } from '../src/input-handler.js';

// ── Mock the OpenCode SDK ────────────────────────────────────────────────────

const mockOpencodePrompt = vi.fn();
const mockOpencodeSessionCreate = vi.fn();
const mockOpencodeServerClose = vi.fn();

vi.mock('@opencode-ai/sdk', () => ({
  createOpencode: vi.fn(async () => ({
    client: {
      session: {
        create: (...args: any[]) => mockOpencodeSessionCreate(...args),
        prompt: (...args: any[]) => mockOpencodePrompt(...args),
      },
    },
    server: {
      url: 'http://127.0.0.1:4096',
      close: () => mockOpencodeServerClose(),
    },
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue-1',
    identifier: 'MT-42',
    title: 'Fix the login bug',
    description: 'Users cannot log in when password contains special characters.',
    state: 'Todo',
    priority: 2,
    labels: ['bug', 'auth'],
    blockedBy: [],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-02T00:00:00Z',
    assignedToWorker: false,
    url: 'https://linear.app/team/MT-42',
    branchName: 'fix/mt-42-login-bug',
    assigneeId: 'user-1',
    ...overrides,
  };
}

function makeOpencodeConfig(overrides: Partial<OpencodeConfig> = {}): OpencodeConfig {
  return {
    hostname: '127.0.0.1',
    port: 4096,
    model: null,
    permission: null,
    turnTimeoutMs: 60_000,
    stallTimeoutMs: 30_000,
    autoRespondToInput: false,
    dryRun: false,
    ...overrides,
  };
}

function makeTrackerConfig(overrides: Partial<TrackerConfig> = {}): TrackerConfig {
  return {
    kind: 'linear',
    endpoint: 'https://api.linear.app/graphql',
    apiKey: 'lin_api_test',
    projectSlug: 'TEST',
    activeStates: ['Todo', 'In Progress'],
    terminalStates: ['Done', 'Cancelled'],
    assignee: null,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<AgentRunnerOptions> = {}): AgentRunnerOptions {
  return {
    issue: makeIssue(),
    workspacePath: '/tmp/workspace',
    promptTemplate: 'Fix issue {{ issue.identifier }}: {{ issue.title }}',
    attempt: 1,
    maxTurns: 3,
    opencodeConfig: makeOpencodeConfig(),
    trackerConfig: makeTrackerConfig(),
    abortController: new AbortController(),
    ...overrides,
  };
}

/** Create a standard successful OpenCode mock response */
function mockSuccessfulResponse(sessionId = 'oc-session-1') {
  mockOpencodeSessionCreate.mockResolvedValue({ data: { id: sessionId } });
  mockOpencodePrompt.mockResolvedValue({
    data: {
      info: {
        id: 'msg-1',
        role: 'assistant',
        finish: 'end_turn',
        cost: 0.01,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 10, write: 5 },
        },
      },
      parts: [{ type: 'text', text: 'Done' }],
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('run: returns normal result on successful completion', async () => {
    mockSuccessfulResponse();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    if (result.kind === 'normal') {
      expect(result.issueId).toBe('issue-1');
      expect(result.turnsCompleted).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(50);
    }
  });

  it('run: uses rendered prompt template for turn 1', async () => {
    mockSuccessfulResponse();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    await runner.run();

    expect(mockOpencodePrompt).toHaveBeenCalledTimes(1);
    const callArgs = mockOpencodePrompt.mock.calls[0][0];
    expect(callArgs.body.parts[0].text).toBe('Fix issue MT-42: Fix the login bug');
  });

  it('run: collects token usage from result message', async () => {
    mockSuccessfulResponse();

    const onTokenUsage = vi.fn();
    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ onTokenUsage }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    if (result.kind === 'normal') {
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        costUsd: 0.01,
      });
    }

    expect(onTokenUsage).toHaveBeenCalledWith('issue-1', expect.objectContaining({
      inputTokens: 100,
      outputTokens: 50,
    }));
  });

  it('run: returns error result on agent failure', async () => {
    mockOpencodeSessionCreate.mockRejectedValue(new Error('Connection refused'));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    const result = await runner.run();

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.issueId).toBe('issue-1');
      expect(result.error.message).toContain('OpenCode agent error');
      expect(result.attempt).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('run: returns cancelled result when aborted', async () => {
    const abortController = new AbortController();
    abortController.abort();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ abortController }));
    const result = await runner.run();

    expect(result.kind).toBe('cancelled');
    if (result.kind === 'cancelled') {
      expect(result.issueId).toBe('issue-1');
      expect(result.reason).toBe('Aborted by controller');
    }
  });

  it('run: calls onEvent callback for system events', async () => {
    mockSuccessfulResponse();
    const onEvent = vi.fn();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ onEvent }));
    await runner.run();

    // Should have been called for the system init event
    expect(onEvent).toHaveBeenCalled();
    const firstCall = onEvent.mock.calls[0];
    expect(firstCall[0]).toBe('issue-1');
    expect(firstCall[1]).toBe('system');
  });

  it('run: passes session ID via onSessionId callback', async () => {
    mockSuccessfulResponse('oc-session-42');
    const onSessionId = vi.fn();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ onSessionId }));
    await runner.run();

    expect(onSessionId).toHaveBeenCalledWith('issue-1', 'oc-session-42');
  });

  it('run: creates session with issue title and workspace directory', async () => {
    mockSuccessfulResponse();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    await runner.run();

    expect(mockOpencodeSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { title: 'MT-42: Fix the login bug' },
        query: { directory: '/tmp/workspace' },
      }),
    );
  });

  it('run: passes model config to prompt when provided', async () => {
    mockSuccessfulResponse();

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      opencodeConfig: makeOpencodeConfig({
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
      }),
    }));
    await runner.run();

    expect(mockOpencodePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-20250514' },
        }),
      }),
    );
  });

  it('run: closes server even on error', async () => {
    mockOpencodeSessionCreate.mockRejectedValue(new Error('Connection refused'));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions());
    await runner.run();

    expect(mockOpencodeServerClose).toHaveBeenCalled();
  });

  // ── Integration: Session Logger ──────────────────────────────────────────

  it('run: creates and closes session log when sessionLogger is provided', async () => {
    mockSuccessfulResponse();

    const mockSessionLogger = {
      createSessionLog: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }),
      closeSessionLog: vi.fn(),
    } as unknown as SessionLogger;

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ sessionLogger: mockSessionLogger }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    expect(mockSessionLogger.createSessionLog).toHaveBeenCalledWith('issue-1', 'MT-42');
    expect(mockSessionLogger.closeSessionLog).toHaveBeenCalledWith('issue-1');
  });

  it('run: closes session log even on error when sessionLogger is provided', async () => {
    mockOpencodeSessionCreate.mockRejectedValue(new Error('Connection refused'));

    const mockSessionLogger = {
      createSessionLog: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }),
      closeSessionLog: vi.fn(),
    } as unknown as SessionLogger;

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ sessionLogger: mockSessionLogger }));
    const result = await runner.run();

    expect(result.kind).toBe('error');
    expect(mockSessionLogger.closeSessionLog).toHaveBeenCalledWith('issue-1');
  });

  // ── Integration: Rate Limiter ────────────────────────────────────────────

  it('run: checks rate limiter before each turn and records requests', async () => {
    mockSuccessfulResponse();

    const mockRateLimiter = {
      isLimited: vi.fn().mockReturnValue(false),
      recordSuccess: vi.fn(),
      recordLimit: vi.fn(),
      getInfo: vi.fn().mockReturnValue({ isLimited: false, retryAfterMs: null, lastLimitedAt: null, limitCount: 0, source: 'opencode-api' }),
    } as unknown as RateLimitTracker;

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({ rateLimiter: mockRateLimiter }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    expect(mockRateLimiter.isLimited).toHaveBeenCalledWith('opencode-api');
    expect(mockRateLimiter.recordSuccess).toHaveBeenCalledWith('opencode-api');
  });

  // ── Integration: Turn Timeout ────────────────────────────────────────────

  it('run: wraps turn execution with TurnTimeout.withTimeout', async () => {
    mockSuccessfulResponse();

    const { AgentRunner } = await import('../src/agent-runner.js');
    // Use a generous timeout so the test passes normally
    const runner = new AgentRunner(makeOptions({
      opencodeConfig: makeOpencodeConfig({ turnTimeoutMs: 120_000 }),
    }));
    const result = await runner.run();

    expect(result.kind).toBe('normal');
    if (result.kind === 'normal') {
      expect(result.turnsCompleted).toBe(1);
    }
  });

  it('run: turn timeout produces TimeoutError when exceeded', async () => {
    // Create a session create that never resolves
    mockOpencodeSessionCreate.mockImplementation(() => new Promise(() => {}));

    const { AgentRunner } = await import('../src/agent-runner.js');
    const runner = new AgentRunner(makeOptions({
      opencodeConfig: makeOpencodeConfig({ turnTimeoutMs: 50 }),
      maxTurns: 1,
    }));
    const result = await runner.run();

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toContain('timed out');
    }
  });
});
