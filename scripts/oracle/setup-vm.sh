#!/usr/bin/env bash
set -euo pipefail

# Run on the Oracle VM after cloning the repo:
#   bash scripts/oracle/setup-vm.sh

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs git
fi

npm ci
npm test

sudo npm install -g pm2
pm2 delete sanchase-api 2>/dev/null || true
HOST=0.0.0.0 PORT=8787 pm2 start npm --name sanchase-api -- run start:server
pm2 save
pm2 startup | tail -n 1 | bash || true

echo "SanChase API running. Check: curl http://127.0.0.1:8787/health"
