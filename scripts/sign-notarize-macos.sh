#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$ROOT/release/mac-arm64/Test Agent Workbench.app"
ZIP="$ROOT/release/Test Agent Workbench-0.1.0-arm64-mac.zip"

if [ -z "${TEST_AGENT_MACOS_IDENTITY:-}" ]; then
  echo "TEST_AGENT_MACOS_IDENTITY is required (for example 'Developer ID Application: Team Name (TEAMID)')" >&2
  exit 2
fi
if [ -z "${TEST_AGENT_NOTARY_PROFILE:-}" ]; then
  echo "TEST_AGENT_NOTARY_PROFILE is required (xcrun notarytool stored credential profile)" >&2
  exit 2
fi

cd "$ROOT"
CI=true pnpm desktop:package

codesign --verify --deep --strict --verbose=2 "$APP"
xcrun notarytool submit "$ZIP" --keychain-profile "$TEST_AGENT_NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl --assess --type execute --verbose "$APP"
shasum -a 256 "$ZIP" "$APP/Contents/Resources/app.asar"
