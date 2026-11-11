& {
  # Sentrix <-> Windows Hello bridge.
  # Run as: powershell.exe -NoProfile -NonInteractive -Command -   (this script on stdin)
  # Input comes from environment variables, output is one line of JSON on stdout.
  #   SENTRIX_HELLO_CMD        supported | enroll | sign | remove
  #   SENTRIX_HELLO_NAME       key name (Sentrix-<uuid>)
  #   SENTRIX_HELLO_CHALLENGE  base64 data to sign (enroll / sign)
  # The private key never leaves Windows Hello (TPM); only the signature is returned.
  $ErrorActionPreference = 'Stop'
  function Out-Json($o) { [Console]::Out.Write(($o | ConvertTo-Json -Compress)) }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Security.Credentials.KeyCredentialManager, Windows.Security.Credentials, ContentType = WindowsRuntime]
    $null = [Windows.Security.Cryptography.CryptographicBuffer, Windows.Security.Cryptography, ContentType = WindowsRuntime]
    $methods = [System.WindowsRuntimeSystemExtensions].GetMethods()
    $asTaskOp = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $asTaskAction = ($methods | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
    function Wait-Op($op, [Type]$type) {
      $task = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
      [void]$task.Wait(-1)
      $task.Result
    }
    function Wait-Action($op) {
      $task = $asTaskAction.Invoke($null, @($op))
      [void]$task.Wait(-1)
    }
    $kcm = [Windows.Security.Credentials.KeyCredentialManager]
    $name = $env:SENTRIX_HELLO_NAME
    function Sign-Challenge($credential) {
      $data = [Windows.Security.Cryptography.CryptographicBuffer]::DecodeFromBase64String($env:SENTRIX_HELLO_CHALLENGE)
      $signed = Wait-Op ($credential.RequestSignAsync($data)) ([Windows.Security.Credentials.KeyCredentialOperationResult])
      if ([string]$signed.Status -ne 'Success') { return @{ ok = $false; status = [string]$signed.Status } }
      @{ ok = $true; signature = [Windows.Security.Cryptography.CryptographicBuffer]::EncodeToBase64String($signed.Result) }
    }
    switch ($env:SENTRIX_HELLO_CMD) {
      'supported' {
        Out-Json @{ ok = $true; supported = [bool](Wait-Op ($kcm::IsSupportedAsync()) ([bool])) }
      }
      'enroll' {
        $created = Wait-Op ($kcm::RequestCreateAsync($name, [Windows.Security.Credentials.KeyCredentialCreationOption]::ReplaceExisting)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
        if ([string]$created.Status -ne 'Success') { Out-Json @{ ok = $false; status = [string]$created.Status }; return }
        Out-Json (Sign-Challenge $created.Credential)
      }
      'sign' {
        $opened = Wait-Op ($kcm::OpenAsync($name)) ([Windows.Security.Credentials.KeyCredentialRetrievalResult])
        if ([string]$opened.Status -ne 'Success') { Out-Json @{ ok = $false; status = [string]$opened.Status }; return }
        Out-Json (Sign-Challenge $opened.Credential)
      }
      'remove' {
        Wait-Action ($kcm::DeleteAsync($name))
        Out-Json @{ ok = $true }
      }
      default { Out-Json @{ ok = $false; status = 'UnknownCommand' } }
    }
  } catch {
    Out-Json @{ ok = $false; status = 'Error'; message = $_.Exception.Message }
  }
}

