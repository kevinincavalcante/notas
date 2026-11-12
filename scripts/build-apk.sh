#!/usr/bin/env bash
# Build local do APK do Notas nesta máquina ARM (receita HomeDance):
#   - bare workflow: mobile/android/ commitada, build Gradle direto
#   - hermesc x86_64 via QEMU (mobile/scripts/hermesc-arm64.sh)
#   - arm64-v8a somente (reactNativeArchitectures no gradle.properties)
# Publica no GitHub Release "apk-latest" (link fixo, sempre a última).
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/bump-versioncode.mjs
VC=$(cat mobile/android/notas-versioncode.txt)

cd mobile/android
./gradlew assembleRelease --no-daemon "-PnotasVersionCode=$VC"

APK=app/build/outputs/apk/release/app-release.apk
VER=$(node -p "require('../app.json').expo.version")

cp "$APK" "/tmp/notas-${VER}-v${VC}.apk"

cd ../..
gh release view apk-latest >/dev/null 2>&1 || gh release create apk-latest \
  --title "Notas — APK mais recente" \
  --notes "Build local mais recente do app Android (arm64-v8a)."
gh release upload apk-latest "/tmp/notas-${VER}-v${VC}.apk" --clobber
rm "/tmp/notas-${VER}-v${VC}.apk"

echo ""
echo "✅ APK publicado: https://github.com/kevinincavalcante/notas/releases/tag/apk-latest"
