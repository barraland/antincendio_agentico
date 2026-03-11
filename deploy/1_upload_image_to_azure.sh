#!/bin/bash
set -euo pipefail

# =========================
# CONFIG
# =========================
RG="betterthannuvia"
ACR_NAME="betterthannuviaacr123456"
TAG="${TAG:-v1}"

IMAGE_LOCAL="antincendio-agentico:local"
IMAGE_REPO="antincendio-agentico-image"

# =========================
# PATHS ROBUSTI
# =========================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_DIR/fire-safety-analyzer"

# =========================
# HELPERS
# =========================
need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "❌ Comando non trovato: $1"; exit 1; }
}

build_local() {
  local dir="$1"
  local image="$2"

  if [[ ! -f "$dir/Dockerfile" ]]; then
    echo "❌ Dockerfile non trovato in: $dir"
    exit 1
  fi

  echo "🔨 Build (no-cache) $image da $dir"
  docker build --no-cache -t "$image" "$dir"
}

tag_and_push() {
  local image_local="$1"
  local repo="$2"
  local tag="$3"
  local remote="${ACR_LOGIN_SERVER}/${repo}:${tag}"

  echo "🏷️  Tag: $image_local -> $remote"
  docker tag "$image_local" "$remote"

  echo "📤 Push: $remote"
  docker push "$remote"
}

# =========================
# PRECHECK
# =========================
need_cmd az
need_cmd docker

echo "🔎 Verifico login Azure..."
az account show >/dev/null 2>&1 || {
  echo "❌ Non sei loggato. Esegui: az login --use-device-code"
  exit 1
}

echo "🔎 Verifico Resource Group: $RG"
az group show -n "$RG" >/dev/null 2>&1 || {
  echo "❌ Resource Group '$RG' non trovato."
  exit 1
}

# =========================
# ACR
# =========================
echo "🔐 Login su ACR..."
az acr login -n "$ACR_NAME"

ACR_LOGIN_SERVER="$(az acr show -n "$ACR_NAME" --query loginServer -o tsv)"
echo "✅ ACR Login Server: $ACR_LOGIN_SERVER"

# =========================
# BUILD + PUSH
# =========================
build_local "$APP_DIR" "$IMAGE_LOCAL"
tag_and_push "$IMAGE_LOCAL" "$IMAGE_REPO" "$TAG"

# =========================
# VERIFY
# =========================
echo "🏷️ Tag su repo '${IMAGE_REPO}':"
az acr repository show-tags -n "$ACR_NAME" --repository "$IMAGE_REPO" -o table

echo
echo "✅ DONE:"
echo " - ${ACR_LOGIN_SERVER}/${IMAGE_REPO}:${TAG}"
