# Single instance
web: mkdir -p /app/bin && curl -L -o /app/bin/scalingo https://github.com/Scalingo/cli/releases/latest/download/scalingo-linux-amd64 && chmod +x /app/bin/scalingo && export PATH="/app/bin:$PATH" && node bot.js --instances 1 --wait 5

# Multiple instances (uncomment the one you want)
# web: node bot.js --instances 2 --wait 10 --delay 30
# web: node bot.js --instances 3 --wait 15 --delay 60 --delay-between 45

# For development with logging
# worker: node bot.js --instances 1 --wait 2
