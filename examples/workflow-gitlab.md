---
tracker:
  kind: gitlab
  endpoint: "https://gitlab.example.com/"
  apiKey: $GITLAB_TOKEN
  projectSlug: "my-org/my-project"
  activeStates: ["To Do"]
  terminalStates: ["Closed"]
  dispatchState: "AI Working"
  completionState: "Human Review"
  assignee: "admin"
workspace:
  rootDir: /tmp/hatice-workspaces
hooks:
  afterCreate: "git clone https://admin:$GITLAB_TOKEN@gitlab.example.com/my-org/my-project.git . && npm install"
  afterRun: "git add -A && git diff --cached --quiet || git commit -m 'fix: automated agent changes' && git push origin HEAD"
polling:
  intervalMs: 30000
agent:
  maxConcurrentAgents: 3
  maxTurns: 0
opencode:
  permission: "allow"
server:
  port: 4000
---
You are an expert software engineer working on this project.

Solve the following GitLab issue:

**{{ issue.identifier }}: {{ issue.title }}**

{{ issue.description }}

## Instructions
* Work in the provided workspace directory
* Follow existing code patterns and conventions
* Create a new branch from the issue identifier before making changes:
  ```
  git checkout -b fix/{{ issue.identifier | replace: "#", "-" | replace: "/", "-" }}
  ```
* When done, commit all changes and push the branch. Always include the issue number (#{{ issue.identifier | split: "#" | last }}) in the commit message:
  ```
  git add -A && git commit -m "fix(#{{ issue.identifier | split: "#" | last }}): descriptive message" && git push origin HEAD
  ```
* You MUST write all your responses, summaries, and explanations in Turkish