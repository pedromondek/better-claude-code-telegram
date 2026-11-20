export const PULL_REQUEST_NUMBER = /^[1-9]\d*$/u;

export const invalidPullRequestNumber = (value) =>
  `PR_NUMBER must be the number of a pull request, not "${value}"`;
