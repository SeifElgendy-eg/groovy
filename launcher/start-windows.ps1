$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# The built app (Vite output) lives in <root>\app. Only that folder is ever served.
$web = [IO.Path]::GetFullPath((Join-Path $root 'app'))
$versionFile = Join-Path $web 'version.txt'
$ver = if (Test-Path -LiteralPath $versionFile) { (Get-Content -LiteralPath $versionFile -TotalCount 1).Trim() } else { '1' }
$noBrowser = [bool]$env:GROOVY_NO_BROWSER   # set by the automated check; never set in normal use
$sha = [Security.Cryptography.SHA256]::Create()
$identity = 'groovy-' + ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-','').Substring(0,20))
$sha.Dispose()
function Open-App([string]$url) {
    if ($noBrowser) { return }
    $candidates = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe")
    foreach ($browser in $candidates) {
        if (Test-Path -LiteralPath $browser) { Start-Process -FilePath $browser -ArgumentList $url; return }
    }
    Start-Process $url
}
function Send-Response($stream, [int]$status, [string]$type, [byte[]]$body, [bool]$headOnly = $false) {
    $reason = switch ($status) { 200 {'OK'} 404 {'Not Found'} 405 {'Method Not Allowed'} default {'Bad Request'} }
    $header = "HTTP/1.1 $status $reason`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($bytes,0,$bytes.Length)
    if (-not $headOnly) { $stream.Write($body,0,$body.Length) }
}
try {
    foreach ($required in @('index.html','vendor/mediapipe/wasm/vision_wasm_internal.wasm','vendor/mediapipe/wasm/vision_wasm_internal.js','models/face_landmarker.task','models/selfie_multiclass_256x256.tflite')) {
        if (-not (Test-Path -LiteralPath (Join-Path $web $required))) { throw "Missing $required. Extract and keep the complete project folder together." }
    }
    $listener = $null
    foreach ($port in 8019..8039) {
        $url = "http://127.0.0.1:$port"
        try {
            $request = [Net.HttpWebRequest]::Create("$url/__groovy_health")
            $request.Proxy = $null; $request.Timeout = 350
            $response = $request.GetResponse()
            $reader = New-Object IO.StreamReader($response.GetResponseStream())
            $body = $reader.ReadToEnd(); $reader.Dispose(); $response.Dispose()
            if ($body -eq $identity) { Open-App "$url/?v=$ver"; exit }
        } catch { }
        $candidate = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$port)
        try { $candidate.Start(); $listener = $candidate; break } catch { $candidate.Stop() }
    }
    if ($null -eq $listener) { throw 'No available local port. Close earlier copies and try again.' }
    Open-App "$url/?v=$ver"
    $mime = @{'.html'='text/html; charset=utf-8';'.js'='text/javascript';'.mjs'='text/javascript';'.css'='text/css';'.wasm'='application/wasm';'.json'='application/json';'.png'='image/png';'.jpg'='image/jpeg';'.jpeg'='image/jpeg';'.svg'='image/svg+xml';'.ico'='image/x-icon';'.task'='application/octet-stream';'.tflite'='application/octet-stream'}
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream(); $stream.ReadTimeout=3000; $stream.WriteTimeout=30000
            $reader = New-Object IO.StreamReader($stream,[Text.Encoding]::ASCII,$false,1024,$true)
            $line = $reader.ReadLine()
            if (-not $line -or $line.Length -gt 8192) { continue }
            $parts = $line.Split(' ')
            if ($parts.Length -ne 3) { continue }
            $method = $parts[0]; $target = $parts[1]
            $total = 0
            do { $header=$reader.ReadLine(); $total += $header.Length; if ($total -gt 16384) { throw 'Headers too large' } } while ($header)
            $reader.Dispose()
            if ($method -notin @('GET','HEAD')) { Send-Response $stream 405 'text/plain' ([Text.Encoding]::UTF8.GetBytes('GET or HEAD only')); continue }
            $headOnly = $method -eq 'HEAD'
            if ($target -eq '/__groovy_health') { Send-Response $stream 200 'text/plain' ([Text.Encoding]::UTF8.GetBytes($identity)) $headOnly; continue }
            $relative = [Uri]::UnescapeDataString(($target -split '\?',2)[0]).TrimStart('/')
            if (-not $relative) { $relative='index.html' }
            $segments = $relative -split '[/\\]'
            if ($relative.Contains(':') -or ($segments | Where-Object { $_.StartsWith('.') })) { Send-Response $stream 404 'text/plain' ([byte[]]@()) $headOnly; continue }
            $path = [IO.Path]::GetFullPath((Join-Path $web $relative))
            $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
            if (-not $path.StartsWith($web+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or -not $mime.ContainsKey($extension) -or -not [IO.File]::Exists($path)) { Send-Response $stream 404 'text/plain' ([byte[]]@()) $headOnly; continue }
            Send-Response $stream 200 $mime[$extension] ([IO.File]::ReadAllBytes($path)) $headOnly
        } catch { } finally { $client.Close() }
    }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show($_.Exception.Message,'Groovy - Unable to start') | Out-Null
} finally { if ($listener) { $listener.Stop() } }
