#!/bin/bash
# Build and optionally install the DevTools Safari Bridge extension
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT_SRC="$REPO_ROOT/extension"
PROJECT_DIR="$REPO_ROOT/desktop-extension/xcode"
BUILD_DIR="$HOME/Library/Developer/Xcode/DerivedData"

echo "=== Building DevTools Safari Bridge Extension ==="

# Check if Xcode project exists; regenerate if not
if [ ! -d "$PROJECT_DIR/DevToolsBridge.xcodeproj" ]; then
  echo "Generating Xcode project..."
  xcrun safari-web-extension-converter "$EXT_SRC" \
    --project-location "$REPO_ROOT/desktop-extension/xcode" \
    --app-name "DevToolsBridge" \
    --bundle-identifier com.nickrepos.devtools-safari-bridge \
    --swift --macos-only --copy-resources --no-open --no-prompt --force
fi

# Sync extension source files to the Xcode project resources
echo "Syncing extension files..."
cp "$EXT_SRC/manifest.json" "$PROJECT_DIR/DevToolsBridge Extension/Resources/manifest.json"
cp "$EXT_SRC/background.js" "$PROJECT_DIR/DevToolsBridge Extension/Resources/background.js"
cp "$EXT_SRC/content.js" "$PROJECT_DIR/DevToolsBridge Extension/Resources/content.js"

# Build
echo "Building..."
cd "$PROJECT_DIR"
xcodebuild -project DevToolsBridge.xcodeproj \
  -scheme DevToolsBridge \
  -configuration Debug \
  -destination 'platform=macOS' \
  build 2>&1 | grep -E "(BUILD|error:|warning:)" | head -20

echo ""
echo "=== Build complete ==="
echo ""
echo "To install the extension:"
echo "  1. Open the app: open \"$(find "$BUILD_DIR" -path "*/DevToolsBridge*/Build/Products/Debug/DevToolsBridge.app" -maxdepth 5 2>/dev/null | head -1)\""
echo "  2. Safari > Settings > Extensions > Enable 'DevTools Safari Bridge'"
echo "  3. Grant access to 'All Websites' when prompted"
