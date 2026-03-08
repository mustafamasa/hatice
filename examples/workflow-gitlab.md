---
tracker:
  kind: gitlab
  endpoint: "https://gitlab.example.com/"
  apiKey: $GITLAB_TOKEN
  projectSlug: "your-group/your-project"
  activeStates: ["Open"]
  terminalStates: ["Closed"]
  assignee: "me"
workspace:
  rootDir: /tmp/hatice-workspaces
hooks:
  afterCreate: "git clone https://gitlab-ci-token:$GITLAB_TOKEN@gitlab.example.com/your-group/your-project.git . && npm install"
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
You are an expert software engineer working on the project.

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
* When done, commit all changes with a descriptive message and push the branch:
  ```
  git add -A && git commit -m "fix: descriptive message" && git push origin HEAD
  ```