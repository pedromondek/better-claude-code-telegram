#!/usr/bin/env sh

target="${1:-HEAD}"

head=$(git rev-parse --verify --quiet "$target^{commit}") || {
  if [ "$target" = "HEAD" ]; then
    echo "✗ check:commit: repository without commits"
  else
    echo "✗ check:commit: commit $target not found"
  fi
  exit 1
}

parent=$(git rev-parse --verify --quiet "$head~1") || {
  echo "✗ check:commit: $head has no parent commit to compare with"
  exit 1
}

printf 'refs/heads/check-commit %s refs/heads/check-commit %s\n' "$head" "$parent" |
  PREPUSH_SKIP_MUTATION=1 PREPUSH_SKIP_BRANCH_CHECK=1 sh "$(dirname "$0")/../pre-push" origin check-commit
