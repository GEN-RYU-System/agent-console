#!/bin/bash
# e2e 用スタブ: 本物の new-worktree.sh の代わりに git worktree add -b だけを行い、台帳ファイルを作る
set -eu
BRANCH="${1:?branch required}"
SAFE="${BRANCH//\//-}"
ROOT="$(git rev-parse --show-toplevel)"
git worktree add -q -b "${BRANCH}" "${ROOT}-wt/${SAFE}" HEAD
mkdir -p "${ROOT}/.claude-pipeline/active-work.d"
cat > "${ROOT}/.claude-pipeline/active-work.d/${SAFE}.md" <<LEDGER
branch: ${BRANCH}

| ブランチ名 | 担当機能エリア | 開始日時 | 状態 | PR# | main | 備考 |
|-----------|--------------|---------|------|-----|------|------|
| ${BRANCH} | e2e | $(date '+%Y-%m-%d %H:%M') | IN_PROGRESS | | | stub |
LEDGER
