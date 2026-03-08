import type { Tracker, Issue, TrackerConfig } from '../types.js';
import { GitLabClient } from './client.js';

export class GitLabAdapter implements Tracker {
  private client: GitLabClient;
  private activeStates: string[];

  constructor(config: TrackerConfig) {
    // Collect all known board labels so the client can resolve issue state from labels
    const boardLabels = [
      ...config.activeStates,
      ...config.terminalStates,
      ...(config.dispatchState ? [config.dispatchState] : []),
      ...(config.completionState ? [config.completionState] : []),
    ];
    this.client = new GitLabClient(config.endpoint, config.apiKey, config.projectSlug, config.assignee, boardLabels);
    this.activeStates = config.activeStates;
  }

  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.client.fetchIssues(this.activeStates);
  }

  async fetchIssuesByStates(states: string[]): Promise<Issue[]> {
    return this.client.fetchIssues(states);
  }

  async fetchIssueStatesByIds(ids: string[]): Promise<Issue[]> {
    return this.client.fetchIssueStatesByIds(ids);
  }

  async createComment(issueId: string, body: string): Promise<void> {
    return this.client.createComment(issueId, body);
  }

  async updateIssueState(issueId: string, stateName: string): Promise<void> {
    return this.client.updateIssueState(issueId, stateName);
  }
}
