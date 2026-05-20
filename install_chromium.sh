#!/bin/bash
# scripts/install_chromium.sh

set -e

echo "===== Installing Chromium for Puppeteer ====="

# Create directories
mkdir -p /app/bin
mkdir -p /app/chromium

# Chromium version to install (using Chrome for Testing)
CHROME_VERSION="121.0.6167.85"
CHROME_URL="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip"

# Check if already installed
CHROME_BIN="/app/chromium/chrome-linux64/chrome"
if [ -f "$CHROME_BIN" ]; then
    echo "Chromium already installed at: $CHROME_BIN"
    export PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"
    echo "export PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN" >> /app/.profile.d/chrome.sh
    exit 0
fi

echo "Downloading Chromium from: $CHROME_URL"

# Download with retry
MAX_RETRIES=3
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if wget -q --show-progress --timeout=300 -O /tmp/chromium.zip "$CHROME_URL"; then
        echo "Download successful"
        break
    else
        RETRY_COUNT=$((RETRY_COUNT + 1))
        echo "Download attempt $RETRY_COUNT failed, retrying..."
        sleep 5
    fi
done

if [ ! -f "/tmp/chromium.zip" ]; then
    echo "ERROR: Failed to download Chromium"
    exit 1
fi

# Extract
echo "Extracting Chromium..."
unzip -q /tmp/chromium.zip -d /app/chromium/
rm /tmp/chromium.zip

# Find the binary
CHROME_BIN=$(find /app/chromium -name "chrome" -type f | head -1)

if [ -z "$CHROME_BIN" ]; then
    echo "ERROR: Could not find chrome binary after extraction"
    exit 1
fi

# Make executable
chmod +x "$CHROME_BIN"
echo "Chromium binary at: $CHROME_BIN"

# Create symlinks
ln -sf "$CHROME_BIN" /app/bin/chrome
ln -sf "$CHROME_BIN" /usr/local/bin/chrome 2>/dev/null || true

# Set environment variable for current session
export PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"

# Save for future sessions
mkdir -p /app/.profile.d
cat > /app/.profile.d/chrome.sh << EOF
export PUPPETEER_EXECUTABLE_PATH="$CHROME_BIN"
EOF

# Test Chromium
echo "Chromium version: $("$CHROME_BIN" --version 2>/dev/null || echo 'Version check skipped')"

echo "===== Chromium installation complete ====="
