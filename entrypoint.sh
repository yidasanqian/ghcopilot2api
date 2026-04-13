#!/bin/sh

run_with_optional_log_file() {
    if [ -n "$LOG_FILE" ]; then
        mkdir -p "$(dirname "$LOG_FILE")"
        status_file="$(mktemp)"

        (
            "$@"
            printf '%s' "$?" > "$status_file"
        ) 2>&1 | bun /app/scripts/log-tee.ts "$LOG_FILE"
        pipeline_status=$?

        if [ -f "$status_file" ]; then
            command_status="$(cat "$status_file")"
            rm -f "$status_file"
        else
            command_status=1
        fi

        if [ "$pipeline_status" -ne 0 ]; then
            exit "$pipeline_status"
        fi

        exit "${command_status:-1}"
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
