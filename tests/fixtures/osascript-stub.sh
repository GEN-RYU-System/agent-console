#!/bin/bash
# e2e 用スタブ: osascript の代わりに、渡された引数を $STUB_OSASCRIPT_LOG へ 1 行で記録する（実際には通知を出さない）
echo "$*" >> "${STUB_OSASCRIPT_LOG:?}"
