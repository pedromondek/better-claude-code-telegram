export const PULL_REQUEST_NUMBER = /^[1-9]\d*$/u;

export const CODERABBIT_CHECK = "CodeRabbit";

export const CODERABBIT_APP = "coderabbitai";

export const LOCK_WORKFLOW = "lock-pull-requests.yml";

export const invalidPullRequestNumber = (value) =>
  `PR_NUMBER must be the number of a pull request, not "${value}"`;
