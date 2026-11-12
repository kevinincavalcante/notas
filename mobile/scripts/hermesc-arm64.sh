#!/usr/bin/env bash
# Hermes (`hermesc`) é um ELF x86_64 e não existe versão arm64 empacotada —
# roda via QEMU (receita do app-cliente da HomeDance). Vive FORA do
# node_modules pra sobreviver a npm install.
# Pré-requisito: qemu-user-static (qemu-x86_64 no PATH).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec qemu-x86_64 "$DIR/node_modules/hermes-compiler/hermesc/linux64-bin/hermesc" "$@"
