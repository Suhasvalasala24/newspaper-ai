#!/bin/bash
# sync-extension.sh — copies the canonical widget files to the Chrome extension folder.
# Run this after ANY edit to widget/newsai-widget.js, widget/newsai-widget.css,
# widget/newsai-config-loader.js, or widget/newsai-content.js.
#
# Usage:
#   chmod +x sync-extension.sh   (first time only)
#   ./sync-extension.sh

set -e

WIDGET_DIR="widget"
EXT_WIDGET_DIR="extension/widget"

echo "🔄 Syncing widget files → extension..."

cp "$WIDGET_DIR/newsai-widget.js"          "$EXT_WIDGET_DIR/newsai-widget.js"
cp "$WIDGET_DIR/newsai-widget.css"         "$EXT_WIDGET_DIR/newsai-widget.css"
cp "$WIDGET_DIR/newsai-config-loader.js"   "$EXT_WIDGET_DIR/newsai-config-loader.js"
cp "$WIDGET_DIR/newsai-content.js"         "$EXT_WIDGET_DIR/newsai-content.js"

echo "✅ Synced:"
echo "   widget/newsai-widget.js        → extension/widget/newsai-widget.js"
echo "   widget/newsai-widget.css       → extension/widget/newsai-widget.css"
echo "   widget/newsai-config-loader.js → extension/widget/newsai-config-loader.js"
echo "   widget/newsai-content.js       → extension/widget/newsai-content.js"
echo ""
echo "💡 Reload the extension in chrome://extensions (↺ button) to pick up the changes."
