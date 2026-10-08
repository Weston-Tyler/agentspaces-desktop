$ErrorActionPreference='Stop'
# Installs only the pinned read SDK in this product's private temporary directory.
# It does not connect accounts, read native sessions, execute a model or change shared services.
ssh remote "mkdir -p /tmp/agentspaces-desktop-sdk-read && npm install --prefix /tmp/agentspaces-desktop-sdk-read @anthropic-ai/claude-agent-sdk@0.3.293 --ignore-scripts --save-exact --no-audit --no-fund"
if($LASTEXITCODE -ne 0){throw 'Read helper installation failed.'}
