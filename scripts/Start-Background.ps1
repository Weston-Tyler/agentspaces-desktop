param([int]$Port=43127)
$ErrorActionPreference='Stop'
$productRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$localState=if($env:AGENTSPACES_STATE){[IO.Path]::GetFullPath($env:AGENTSPACES_STATE)}else{Join-Path $productRoot '.local'}
$runtimeFile=Join-Path $localState 'runtime.json'
if(Test-Path -LiteralPath $runtimeFile){Push-Location $productRoot;try{node app/cli.mjs status;if($LASTEXITCODE -eq 0){$running=Get-Content -Raw -LiteralPath $runtimeFile | ConvertFrom-Json;Write-Output $running.address;exit 0}}finally{Pop-Location};throw 'Prior runtime needs diagnosis; no duplicate process was started.'}
if(-not(Test-Path -LiteralPath (Join-Path $productRoot 'node_modules'))){throw 'Install the locked dependencies with npm ci first.'}
$env:AGENTSPACES_PORT=$Port
New-Item -ItemType Directory -Force -Path $localState | Out-Null
Start-Process -FilePath (Get-Command node).Source -ArgumentList 'app/cli.mjs','serve' -WorkingDirectory $productRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $localState 'stdout.log') -RedirectStandardError (Join-Path $localState 'stderr.log') | Out-Null
Write-Output "Starting local companion at http://127.0.0.1:$Port. Run node app/cli.mjs status to verify."
