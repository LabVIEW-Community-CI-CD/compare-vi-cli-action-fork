#Requires -Version 7.0
[CmdletBinding()]
param(
  [switch]$Ensure,
  [switch]$Stop,
  [switch]$Status,
  [switch]$QueueApply,
  [switch]$NoPortfolioApply,
  [switch]$StopWhenNoOpenIssues,
  [switch]$SleepMode,
  [string]$Repo = 'LabVIEW-Community-CI-CD/compare-vi-cli-action',
  [string]$RuntimeDir = 'tests/results/_agent/runtime',
  [int]$DaemonPollIntervalSeconds = 60,
  [int]$CycleIntervalSeconds = 90,
  [int]$MaxCycles = 0,
  [int]$StopWaitSeconds = 30,
  [string]$ProjectStatus = 'In Progress',
  [string]$ProjectProgram = 'Shared Infra',
  [string]$ProjectPhase = 'Helper Workflow',
  [string]$ProjectEnvironmentClass = 'Infra',
  [string]$ProjectBlockingSignal = 'Scope',
  [string]$ProjectEvidenceState = 'Partial',
  [string]$ProjectPortfolioTrack = 'Agent UX',
  [int]$QueuePauseRecoveryThresholdCycles = 2,
  [int]$QueuePauseRecoveryCooldownMinutes = 30,
  [int]$QueuePauseRecoveryMaxAttempts = 8,
  [string]$QueuePauseRecoveryRef = 'develop',
  [switch]$DispatchValidateOnQueuePause,
  [switch]$QueuePauseRecoveryAllowFork,
  [switch]$OnlyRecoverQueueWhenEligible,
  [int]$MaxConsecutiveCycleFailures = 0,
  [switch]$AutoBootstrapOnFailure,
  [switch]$AutoPrioritySyncLane,
  [switch]$AutoDevelopSync,
  [int]$CodexHygieneIntervalCycles = 3,
  [string]$WslDistro = 'Ubuntu'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'DeliveryAgentWrapper.Build.psm1') -Force
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$distScript = Join-Path $repoRoot 'dist\tools\priority\delivery-agent.js'
Initialize-DeliveryAgentDistScript -RepoRoot $repoRoot -DistScript $distScript -WrapperLabel 'delivery-agent wrapper'

function Get-ManagerStatusSummary {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Report
  )

  $hostSignal = $Report.hostSignal
  $hostIsolation = $Report.hostIsolation
  $hostSignalStatus = if ($hostSignal -and $hostSignal.status) { [string]$hostSignal.status } else { $null }
  $hostSignalProvider = if ($hostSignal -and $hostSignal.provider) { [string]$hostSignal.provider } else { $null }

  $activeRunnerServices = @()
  if ($hostSignal -and $hostSignal.runnerServices -and $hostSignal.runnerServices.running) {
    $activeRunnerServices = @($hostSignal.runnerServices.running) | Where-Object { $_ -and $_ -like 'actions.runner.*' }
  }

  $summaryStatus = 'unknown'
  $summaryText = 'cutover readiness unknown: host signal is missing'

  if ($hostSignal) {
    if ($activeRunnerServices.Count -gt 0) {
      $summaryStatus = 'runner-conflict'
      $summaryText = "runner conflict: $($activeRunnerServices.Count) actions.runner.* services still active"
      if ($hostSignalStatus -eq 'desktop-backed' -or $hostSignalProvider -eq 'desktop') {
        $summaryText += '; cutover required: host still desktop-backed'
      }
    } elseif ($hostSignalStatus -eq 'native-wsl' -or $hostSignalProvider -eq 'native-wsl') {
      $summaryStatus = 'ready'
      $summaryText = 'cutover ready: native-wsl host signal is clear and no runner-service conflict remains'
    } elseif ($hostSignalStatus -eq 'desktop-backed' -or $hostSignalProvider -eq 'desktop') {
      $summaryStatus = 'cutover-required'
      $summaryText = 'cutover required: host still desktop-backed'
    } else {
      $summaryStatus = 'cutover-required'
      $summaryText = "cutover required: host signal status=$hostSignalStatus provider=$hostSignalProvider"
    }
  }

  return [ordered]@{
    hostSignal = [ordered]@{
      status = $hostSignalStatus
      provider = $hostSignalProvider
    }
    hostIsolation = [ordered]@{
      lastEvent = $hostIsolation.lastEvent
    }
    runnerServices = [ordered]@{
      activeCount = @($activeRunnerServices).Count
      activeNames = @($activeRunnerServices)
    }
    cutoverReadiness = [ordered]@{
      status = $summaryStatus
      summary = $summaryText
    }
  }
}

$command = if ($Ensure) { 'ensure' } elseif ($Stop) { 'stop' } elseif ($Status) { 'status' } else { throw 'Specify one of -Ensure, -Status, or -Stop.' }
$args = @(
  $distScript,
  $command,
  '--repo', $Repo,
  '--runtime-dir', $RuntimeDir,
  '--daemon-poll-interval-seconds', "$DaemonPollIntervalSeconds",
  '--cycle-interval-seconds', "$CycleIntervalSeconds",
  '--max-cycles', "$MaxCycles",
  '--stop-wait-seconds', "$StopWaitSeconds",
  '--project-status', $ProjectStatus,
  '--project-program', $ProjectProgram,
  '--project-phase', $ProjectPhase,
  '--project-environment-class', $ProjectEnvironmentClass,
  '--project-blocking-signal', $ProjectBlockingSignal,
  '--project-evidence-state', $ProjectEvidenceState,
  '--project-portfolio-track', $ProjectPortfolioTrack,
  '--queue-pause-recovery-threshold-cycles', "$QueuePauseRecoveryThresholdCycles",
  '--queue-pause-recovery-cooldown-minutes', "$QueuePauseRecoveryCooldownMinutes",
  '--queue-pause-recovery-max-attempts', "$QueuePauseRecoveryMaxAttempts",
  '--queue-pause-recovery-ref', $QueuePauseRecoveryRef,
  '--max-consecutive-cycle-failures', "$MaxConsecutiveCycleFailures",
  '--codex-hygiene-interval-cycles', "$CodexHygieneIntervalCycles",
  '--wsl-distro', $WslDistro
)
foreach ($flag in @(
  @{ Enabled = $QueueApply; Name = '--queue-apply' },
  @{ Enabled = $NoPortfolioApply; Name = '--no-portfolio-apply' },
  @{ Enabled = $StopWhenNoOpenIssues; Name = '--stop-when-no-open-issues' },
  @{ Enabled = $SleepMode; Name = '--sleep-mode' },
  @{ Enabled = $DispatchValidateOnQueuePause; Name = '--dispatch-validate-on-queue-pause' },
  @{ Enabled = $QueuePauseRecoveryAllowFork; Name = '--queue-pause-recovery-allow-fork' },
  @{ Enabled = $OnlyRecoverQueueWhenEligible; Name = '--only-recover-queue-when-eligible' },
  @{ Enabled = $AutoBootstrapOnFailure; Name = '--auto-bootstrap-on-failure' },
  @{ Enabled = $AutoPrioritySyncLane; Name = '--auto-priority-sync-lane' },
  @{ Enabled = $AutoDevelopSync; Name = '--auto-develop-sync' }
)) {
  if ($flag.Enabled) {
    $args += $flag.Name
  }
}

if ($Status) {
  $stdout = & node @args
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    exit $exitCode
  }

  $report = [string]::Join("`n", @($stdout)) | ConvertFrom-Json -Depth 64
  $report | Add-Member -NotePropertyName managerStatusSummary -NotePropertyValue (Get-ManagerStatusSummary -Report $report) -Force
  $report | ConvertTo-Json -Depth 64
  exit 0
}

& node @args
exit $LASTEXITCODE
