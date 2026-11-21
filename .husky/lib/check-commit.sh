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

hooks=$(mktemp -d "${TMPDIR:-/tmp}/check-commit-hooks.XXXXXX") || {
  echo "✗ check:commit: could not create the folder for the hooks of $head"
  exit 1
}
trap 'rm -rf "$hooks"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pre_push="$(dirname "$0")/../pre-push"

if git cat-file -e "$head:.husky/pre-push" 2>/dev/null &&
  git archive "$head" .husky | tar -x -C "$hooks"; then
  pre_push="$hooks/.husky/pre-push"
fi

printf 'refs/heads/check-commit %s refs/heads/check-commit %s\n' "$head" "$parent" |
  PREPUSH_SKIP_MUTATION=1 PREPUSH_SKIP_BRANCH_CHECK=1 sh "$pre_push" origin check-commit
