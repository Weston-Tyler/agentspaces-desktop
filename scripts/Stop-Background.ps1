$ErrorActionPreference='Stop'
$productRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $productRoot
try{node app/cli.mjs stop;if($LASTEXITCODE -ne 0){throw 'The owned runtime could not be verified/stopped; inspect diagnostics.'}}finally{Pop-Location}
