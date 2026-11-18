# win32-window.ps1 -- resident window helper driven by win32-window.js (Windows only).
# ASCII only on purpose: PowerShell 5.1 decodes a BOM-less .ps1 as ANSI and mangles UTF-8 comments.
#
# Protocol: one JSON request per stdin line -> one JSON reply per stdout line.
#   owner    {hostPid}                    -> {pid, name} | {error}
#            walk up from the native-messaging host process to the browser that spawned it;
#            every window operation below is scoped to that browser process only, so a second
#            browser (or a second instance of the same browser) is never touched.
#   find     {title, ownerPid, wantIconic?} -> {hwnd, pid, title, iconic, candidates} | {error}
#   show     {hwnd}           -> {ok}        SW_SHOWNOACTIVATE: un-minimize WITHOUT activating (keeps z-order)
#   raise    {hwnd}           -> {ok, prev}  top of z-order without activation; prev = window that was above
#   lower    {hwnd, prev}     -> {ok}        put back right under prev
#   minimize {hwnd}           -> {ok}        SW_SHOWMINNOACTIVE: minimize, the active window stays active
#   state    {hwnd}           -> {iconic, foreground}
#   ping     {}               -> {ok}
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class BW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static List<object[]> List() {
    var r = new List<object[]>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      if (n == 0) return true;
      var sb = new StringBuilder(n + 1);
      GetWindowText(h, sb, n + 1);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      r.Add(new object[] { (long)h, (int)pid, sb.ToString(), IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@

$SW_SHOWNOACTIVATE = 4
$SW_SHOWMINNOACTIVE = 7
$GW_HWNDPREV = 3
$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010

$BROWSER_EXE = '^(chrome|brave|msedge|chromium|vivaldi|opera)\.exe$'

# Walk ProcessId -> ParentProcessId from the native-messaging host until a browser executable
# shows up (host.js <- host.cmd/cmd.exe <- chrome.exe). Only the browser that spawned the host is
# the one with the extension installed; anything else on the machine is the user's own business.
function Find-OwnerBrowser($hostPid) {
  $p = [int]$hostPid
  for ($i = 0; $i -lt 8; $i++) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
    if (-not $proc) { return @{ error = 'host process chain broken' } }
    if ($proc.Name -match $BROWSER_EXE) { return @{ pid = [int]$proc.ProcessId; name = [string]$proc.Name } }
    if ($proc.ParentProcessId -eq 0 -or $proc.ParentProcessId -eq $p) { break }
    $p = [int]$proc.ParentProcessId
  }
  return @{ error = 'no browser process above host' }
}

function Find-BrowserWindow($title, $ownerPid, $wantIconic) {
  if (-not $ownerPid) { return @{ error = 'ownerPid required' } }
  $wins = @()
  foreach ($w in [BW]::List()) {
    if ([int]$w[1] -eq [int]$ownerPid) {
      $wins += [pscustomobject]@{ hwnd = [long]$w[0]; pid = [int]$w[1]; title = [string]$w[2]; iconic = [bool]$w[3] }
    }
  }
  if ($wins.Count -eq 0) { return @{ error = 'owner browser has no visible window'; candidates = 0 } }
  $hit = @()
  if ($title) {
    $prefix = $title + ' - '
    $hit = @($wins | Where-Object { $_.title -eq $title -or $_.title.StartsWith($prefix) })
  }
  # Title lookup failed (title changed between the extension's report and now). Within the owner
  # browser only: if the caller knows its window is minimized, fall back to the single minimized one.
  if ($hit.Count -eq 0 -and $wantIconic) {
    $iconic = @($wins | Where-Object { $_.iconic })
    if ($iconic.Count -eq 1) { $hit = $iconic }
  }
  if ($hit.Count -eq 0) { return @{ error = 'no window matches title'; candidates = $wins.Count } }
  $pick = $hit
  if ($wantIconic) { $pick = @($hit | Where-Object { $_.iconic }); if ($pick.Count -eq 0) { $pick = $hit } }
  $p = $pick[0]
  return @{ hwnd = $p.hwnd; pid = $p.pid; title = $p.title; iconic = $p.iconic; candidates = $wins.Count }
}

function Handle($req) {
  $op = [string]$req.op
  if ($op -eq 'ping') { return @{ ok = $true } }
  if ($op -eq 'owner') { return Find-OwnerBrowser $req.hostPid }
  if ($op -eq 'find') { return Find-BrowserWindow ([string]$req.title) $req.ownerPid ([bool]$req.wantIconic) }
  $h = [IntPtr][long]$req.hwnd
  if (-not [BW]::IsWindow($h)) { return @{ error = 'window handle is gone' } }
  switch ($op) {
    'show' {
      [void][BW]::ShowWindow($h, $SW_SHOWNOACTIVATE)
      return @{ ok = $true }
    }
    'raise' {
      $prev = [long][BW]::GetWindow($h, $GW_HWNDPREV)
      [void][BW]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
      return @{ ok = $true; prev = $prev }
    }
    'lower' {
      $prev = [IntPtr][long]$req.prev
      if ($prev -ne [IntPtr]::Zero -and [BW]::IsWindow($prev)) {
        [void][BW]::SetWindowPos($h, $prev, 0, 0, 0, 0, ($SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOACTIVATE))
      }
      return @{ ok = $true }
    }
    'minimize' {
      [void][BW]::ShowWindow($h, $SW_SHOWMINNOACTIVE)
      return @{ ok = $true }
    }
    'state' {
      return @{ iconic = [BW]::IsIconic($h); foreground = ([BW]::GetForegroundWindow() -eq $h) }
    }
    default { return @{ error = ('unknown op: ' + $op) } }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $res = $null
  try {
    $req = $line | ConvertFrom-Json
    $res = Handle $req
  } catch {
    $res = @{ error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
