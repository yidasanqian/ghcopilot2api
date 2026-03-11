#!/bin/sh

run_with_optional_log_file() {
    if [ -n "$LOG_FILE" ]; then
        mkdir -p "$(dirname "$LOG_FILE")"
        "$@" 2>&1 | tee -a "$LOG_FILE"
        exit ${PIPESTATUS:-${?}}
    fi
    
    exec "$@"
}

if [ "$1" = "--auth" ]; then
    # Run auth command
    run_with_optional_log_file bun run dist/main.js auth
else
    # Default command
    run_with_optional_log_file bun run dist/main.js start -g "$GH_TOKEN" "$@"
fi

