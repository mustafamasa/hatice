import { PromptBuilder, issueToTemplateData } from './prompt-builder.js';
import { AgentError } from './errors.js';
import { TurnTimeout } from './turn-timeout.js';
import type { SessionLogger } from './session-logger.js';
import type { RateLimitTracker } from './rate-limiter.js';
import type {
  Issue, WorkerResult, TokenUsage, OpencodeConfig, TrackerConfig,
} from './types.js';
import { emptyTokenUsage } from './types.js';

export interface AgentRunnerOptions {
  issue: Issue;
  workspacePath: string;
  promptTemplate: string;
  attempt: number;
  maxTurns: number;
  opencodeConfig: OpencodeConfig;
  trackerConfig: TrackerConfig;
  abortController: AbortController;
  onEvent?: (issueId: string, eventName: string, detail: string) => void;
  onTokenUsage?: (issueId: string, usage: TokenUsage) => void;
  onSessionId?: (issueId: string, sessionId: string) => void;
  sessionLogger?: SessionLogger;
  rateLimiter?: RateLimitTracker;
}

export class AgentRunner {
  private options: AgentRunnerOptions;
  private promptBuilder: PromptBuilder;
  private sessionId: string | null = null;
  private sessionLog: { info: Function; error: Function } | null = null;

  constructor(options: AgentRunnerOptions) {
    this.options = options;
    this.promptBuilder = new PromptBuilder();
  }

  async run(): Promise<WorkerResult> {
    const startTime = Date.now();
    const { issue, maxTurns, abortController } = this.options;
    let turnsCompleted = 0;
    let totalUsage = emptyTokenUsage();

    // Integration: Session Logger — create session log at start
    if (this.options.sessionLogger) {
      this.sessionLog = this.options.sessionLogger.createSessionLog(issue.id, issue.identifier);
    }

    try {
      if (abortController.signal.aborted) {
        return { kind: 'cancelled', issueId: issue.id, reason: 'Aborted by controller' };
      }

      // Integration: Rate Limiter — check before execution
      if (this.options.rateLimiter) {
        if (this.options.rateLimiter.isLimited('opencode-api')) {
          const info = this.options.rateLimiter.getInfo('opencode-api');
          const waitMs = info.retryAfterMs ?? 5000;
          this.sessionLog?.info({ waitMs }, 'Rate limited, waiting before execution');
          await delay(waitMs, abortController.signal);
        }
      }

      const prompt = await this.buildPrompt(1, maxTurns);

      // SDK handles all turns internally via maxTurns
      const { opencodeConfig } = this.options;
      const turnResult = await TurnTimeout.withTimeout(
        async (_signal) => this.executeTurn(prompt, 1),
        opencodeConfig.turnTimeoutMs,
        abortController.signal,
      );

      turnsCompleted = 1;

      // Integration: Rate Limiter — record successful request
      if (this.options.rateLimiter) {
        this.options.rateLimiter.recordSuccess('opencode-api');
      }

      // Aggregate usage
      if (turnResult.usage) {
        totalUsage = mergeUsage(totalUsage, turnResult.usage);
        this.options.onTokenUsage?.(issue.id, totalUsage);
      }

      if (turnResult.sessionId) {
        this.sessionId = turnResult.sessionId;
        this.options.onSessionId?.(issue.id, turnResult.sessionId);
      }

      return {
        kind: 'normal',
        issueId: issue.id,
        turnsCompleted,
        usage: totalUsage,
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      this.sessionLog?.error({ error: error?.message }, 'Agent run failed');
      if (abortController.signal.aborted) {
        return { kind: 'cancelled', issueId: issue.id, reason: error.message ?? 'Aborted' };
      }
      return {
        kind: 'error',
        issueId: issue.id,
        error: error instanceof Error ? error : new AgentError(String(error)),
        attempt: this.options.attempt,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // Integration: Session Logger — always close session log
      if (this.options.sessionLogger) {
        this.options.sessionLogger.closeSessionLog(issue.id);
      }
    }
  }

  private async buildPrompt(turn: number, maxTurns: number): Promise<string> {
    if (turn === 1) {
      const templateData = issueToTemplateData(this.options.issue);
      return this.promptBuilder.render(this.options.promptTemplate, {
        issue: templateData,
        attempt: { number: this.options.attempt, error: null },
      });
    }
    return this.promptBuilder.buildContinuationPrompt(turn, maxTurns);
  }

  private async executeTurn(prompt: string, turn: number): Promise<TurnResult> {
    // Dry-run mode: simulate agent execution without spawning real agents
    if (this.options.opencodeConfig.dryRun) {
      return this.simulateTurn(prompt, turn);
    }

    let sdkModule: any;
    try {
      sdkModule = await import('@opencode-ai/sdk');
    } catch (importErr: any) {
      throw new AgentError(`Failed to import OpenCode SDK: ${importErr.message}`);
    }

    const { createOpencode } = sdkModule;
    const opencodeConfig = this.options.opencodeConfig;
    const { abortController, workspacePath } = this.options;

    const result: TurnResult = {
      isComplete: false,
      usage: null,
      sessionId: null,
    };

    let opencode: any;
    try {
      opencode = await createOpencode({
        ...(opencodeConfig.hostname && { hostname: opencodeConfig.hostname }),
        ...(opencodeConfig.port && { port: opencodeConfig.port }),
        signal: abortController.signal,
        config: {
          ...(opencodeConfig.model && { model: `${opencodeConfig.model.providerID}/${opencodeConfig.model.modelID}` }),
          ...(opencodeConfig.permission && { permission: opencodeConfig.permission }),
        },
      });
    } catch (startErr: any) {
      throw new AgentError(`Failed to start OpenCode server: ${startErr.message}`);
    }

    const client = opencode.client;

    try {
      // Create a session for this issue
      const sessionRes = await client.session.create({
        body: { title: `${this.options.issue.identifier}: ${this.options.issue.title}` },
        query: { directory: workspacePath },
      });

      // SDK returns { data, request, response } wrapper
      const sessionData = sessionRes?.data ?? sessionRes;
      if (!sessionData?.id) {
        throw new AgentError('Failed to create OpenCode session');
      }

      const sessionId = sessionData.id;
      result.sessionId = sessionId;

      this.options.onEvent?.(this.options.issue.id, 'system', JSON.stringify({
        type: 'system', subtype: 'init', backend: 'opencode', sessionId,
      }));
      this.sessionLog?.info({ sessionId, turn, backend: 'opencode' }, 'OpenCode session created');

      // Build prompt parts
      const promptBody: Record<string, unknown> = {
        parts: [{ type: 'text', text: prompt }],
      };

      // Set model if configured
      if (opencodeConfig.model) {
        promptBody.model = opencodeConfig.model;
      }

      // Send prompt and wait for response
      const promptRes = await client.session.prompt({
        path: { id: sessionId },
        body: promptBody,
        query: { directory: workspacePath },
      });

      // SDK returns { data: { info, parts }, request, response }
      const promptData = promptRes?.data ?? promptRes;
      const info = promptData?.info ?? promptData;
      result.isComplete = true;

      this.sessionLog?.info({
        finish: info?.finish,
        cost: info?.cost,
        backend: 'opencode',
      }, 'OpenCode agent result');

      if (info?.tokens) {
        const t = info.tokens;
        result.usage = {
          inputTokens: t.input ?? 0,
          outputTokens: t.output ?? 0,
          totalTokens: (t.input ?? 0) + (t.output ?? 0),
          cacheReadInputTokens: t.cache?.read ?? 0,
          cacheCreationInputTokens: t.cache?.write ?? 0,
          costUsd: info.cost ?? 0,
        };
      }

      if (info?.error) {
        this.sessionLog?.error({ error: info.error }, 'OpenCode agent error in response');
      }
    } catch (err: any) {
      throw new AgentError(`OpenCode agent error: ${err.message}`);
    } finally {
      try {
        opencode.server?.close();
      } catch { /* ignore cleanup errors */ }
    }

    return result;
  }

  /** Simulate a turn for demo/dry-run mode without spawning real agents */
  private async simulateTurn(_prompt: string, turn: number): Promise<TurnResult> {
    // Simulate processing time (1-3 seconds)
    const simulatedDelayMs = 1000 + Math.random() * 2000;
    await delay(simulatedDelayMs, this.options.abortController.signal);

    this.options.onEvent?.(this.options.issue.id, 'system', JSON.stringify({ type: 'system', subtype: 'init', dry_run: true }));
    this.sessionLog?.info({ turn, dryRun: true }, 'Simulated agent turn');

    const simulatedTokens = Math.floor(500 + Math.random() * 2000);
    return {
      isComplete: turn >= this.options.maxTurns || Math.random() > 0.5,
      usage: {
        inputTokens: simulatedTokens,
        outputTokens: Math.floor(simulatedTokens * 0.3),
        totalTokens: Math.floor(simulatedTokens * 1.3),
        cacheReadInputTokens: Math.floor(simulatedTokens * 0.1),
        cacheCreationInputTokens: Math.floor(simulatedTokens * 0.05),
        costUsd: simulatedTokens * 0.000003,
      },
      sessionId: this.sessionId ?? `dry-run-${Date.now()}`,
    };
  }
}

interface TurnResult {
  isComplete: boolean;
  usage: TokenUsage | null;
  sessionId: string | null;
}

function mergeUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }, { once: true });
  });
}

export { mergeUsage, delay };
