<#
  Pit Wall: wake the computer and start Pit Wall before every F1 session.

  Night races (Las Vegas, for example) are easy to miss: the laptop is asleep and
  nothing gets recorded. This adds one Windows scheduled task per remaining session
  of the season. Each wakes the computer 20 minutes before the session and starts
  Pit Wall in the background (if it is already running, the new copy just exits).
  Pit Wall then keeps the computer awake until the session is over.

  Usage (from the Pit Wall folder, in PowerShell):
    .\tools\schedule-sessions.ps1            # show what would be scheduled (changes nothing)
    .\tools\schedule-sessions.ps1 -Install   # create the tasks
    .\tools\schedule-sessions.ps1 -Remove    # delete all Pit Wall tasks

  Run it again after a schedule change to refresh the tasks. The computer must be
  asleep, not shut down, and "Allow wake timers" must be on in the power plan
  (Control Panel > Power Options > Change plan settings > Advanced > Sleep).
#>
param(
  [switch]$Install,
  [switch]$Remove,
  [int]$MinutesBefore = 20
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$folder = '\PitWall\'

if ($Remove) {
  $tasks = Get-ScheduledTask -TaskPath $folder -ErrorAction SilentlyContinue
  foreach ($t in $tasks) { Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $folder -Confirm:$false }
  Write-Host "Removed $(@($tasks).Count) Pit Wall task(s)."
  return
}

# The season's sessions, from the free Jolpica (Ergast) API.
$data = Invoke-RestMethod -Uri 'https://api.jolpi.ca/ergast/f1/current.json' -Headers @{ 'User-Agent' = 'pitwall-dashboard' }
$names = [ordered]@{ FirstPractice = 'Practice 1'; SecondPractice = 'Practice 2'; ThirdPractice = 'Practice 3'; SprintQualifying = 'Sprint Qualifying'; SprintShootout = 'Sprint Shootout'; Sprint = 'Sprint'; Qualifying = 'Qualifying' }
$sessions = foreach ($race in $data.MRData.RaceTable.Races) {
  foreach ($k in $names.Keys) {
    $s = $race.$k
    if ($s -and $s.date) { [pscustomobject]@{ Race = $race.raceName; Name = $names[$k]; Start = [datetime]::Parse("$($s.date)T$($s.time)").ToUniversalTime() } }
  }
  [pscustomobject]@{ Race = $race.raceName; Name = 'Race'; Start = [datetime]::Parse("$($race.date)T$($race.time)").ToUniversalTime() }
}
$upcoming = $sessions | Where-Object { $_.Start -gt (Get-Date).ToUniversalTime().AddMinutes($MinutesBefore) } | Sort-Object Start

if (-not $upcoming) { Write-Host 'No upcoming sessions this season.'; return }

Write-Host ''
Write-Host ("{0,-34} {1,-18} {2}" -f 'Session', 'Starts (your time)', 'Pit Wall starts at')
foreach ($s in $upcoming) {
  $local = $s.Start.ToLocalTime()
  Write-Host ("{0,-34} {1,-18} {2}" -f "$($s.Race) $($s.Name)", $local.ToString('ddd d MMM HH:mm'), $local.AddMinutes(-$MinutesBefore).ToString('HH:mm'))
}
Write-Host ''

if (-not $Install) {
  Write-Host 'Nothing changed. Run again with -Install to create these tasks, or -Remove to delete them.'
  return
}

# Start Pit Wall in the background: no browser window, no "press a key" at the end.
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$root\start.cmd`" --background`"" -WorkingDirectory $root
$settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew

$made = 0
foreach ($s in $upcoming) {
  $at = $s.Start.ToLocalTime().AddMinutes(-$MinutesBefore)
  $name = ('{0} {1} {2}' -f $s.Start.ToString('yyyy-MM-dd'), $s.Race, $s.Name) -replace '[\\/:*?"<>|]', ''
  $trigger = New-ScheduledTaskTrigger -Once -At $at
  Register-ScheduledTask -TaskName $name -TaskPath $folder -Action $action -Trigger $trigger -Settings $settings -Description 'Pit Wall: wake up and record this F1 session' -Force | Out-Null
  $made++
}
Write-Host "Created $made task(s) in Task Scheduler > Task Scheduler Library > PitWall."
Write-Host 'Leave the laptop plugged in and asleep (not shut down) on race weekends.'
