# The Windows Job Object helper (docs/PROCESS_CONTAINMENT_PLAN.md).
#
# Runs OUTSIDE the job it owns. Invoked by containment.ts only:
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File job-object-helper.ps1 <pipe> <base64 json [file, ...args]>
#
# Protocol over the named pipe the controller listens on:
#   helper -> controller   "attached"          the target was created SUSPENDED, assigned to a
#                                              kill-on-close / no-breakaway job, then resumed
#                          "failed <detail>"   the target never ran
#                          "empty"             the job reports zero active processes
#   controller -> helper   "kill"              TerminateJobObject, then report "empty" and exit
# The helper exits with the root's exit code as soon as the job is empty;
# members that outlive the root's natural exit are terminated after 2 s.
# The controller's death closes the pipe: the helper terminates the job and exits, and the
# job handle closing (kill-on-close) ends anything that raced that.
#
# The target inherits this helper's stdin/stdout/stderr (the controller's pipes), its
# environment and its working directory verbatim; argv is re-quoted with the same rules
# libuv uses, never re-parsed through a shell.

param(
  [Parameter(Position = 0)] [string] $Pipe,
  # The target's argv - file first - as base64(UTF-8 JSON array): one opaque
  # token, so PowerShell's own command-line parsing can never touch a quote,
  # a space or a percent sign the controller passed.
  [Parameter(Position = 1)] [string] $Encoded,
  [string] $JobName,
  [string] $QueryName,
  # A whole-job memory limit in bytes (the code map's bounded reads); 0 is none.
  [long] $MemoryLimit = 0
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SoJob {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses;
  }
  public const int JobObjectBasicAccountingInformation = 1;
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  public const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
  public const uint CREATE_SUSPENDED = 0x4;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
  public const int STARTF_USESTDHANDLES = 0x100;
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);

  /** libuv's quoting rules: the target sees exactly the argv the controller passed. */
  public static string Quote(string arg) {
    if (arg.Length == 0) return "\"\"";
    bool plain = true;
    foreach (char c in arg) { if (c == ' ' || c == '\t' || c == '"' || c == '\n' || c == '\r') { plain = false; break; } }
    if (plain) return arg;
    var sb = new StringBuilder();
    sb.Append('"');
    int backslashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { backslashes++; continue; }
      if (c == '"') { sb.Append('\\', backslashes * 2 + 1); sb.Append('"'); backslashes = 0; continue; }
      sb.Append('\\', backslashes); sb.Append(c); backslashes = 0;
    }
    sb.Append('\\', backslashes * 2);
    sb.Append('"');
    return sb.ToString();
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  public static string Inspect(string name) {
    IntPtr job = OpenJobObjectW(4, false, name); // JOB_OBJECT_QUERY only
    if (job == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? "empty" : "unknown";
    try { return ActiveProcesses(job) == 0 ? "empty" : "populated"; }
    catch { return "unknown"; }
    finally { CloseHandle(job); }
  }
  public static IntPtr MakeJob(string name, long memoryLimit) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    int createdError = Marshal.GetLastWin32Error();
    if (job != IntPtr.Zero && createdError == 183) { CloseHandle(job); throw new Exception("job name already exists"); }
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject failed: " + Marshal.GetLastWin32Error());
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    // Kill on close; NO breakaway flags, so nothing inside may leave the job.
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (memoryLimit > 0) {
      info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
      info.JobMemoryLimit = new UIntPtr((ulong)memoryLimit);
    }
    int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(info, buffer, false);
      if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size)) throw new Exception("SetInformationJobObject failed: " + Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(buffer); }
    return job;
  }

  public static uint ActiveProcesses(IntPtr job) {
    int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, (uint)size, IntPtr.Zero)) throw new Exception("QueryInformationJobObject failed: " + Marshal.GetLastWin32Error());
      var info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(buffer, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      return info.ActiveProcesses;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static PROCESS_INFORMATION StartSuspended(string commandLine) {
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    PROCESS_INFORMATION pi;
    var cmd = new StringBuilder(commandLine);
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi)) {
      throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
    }
    return pi;
  }
}
"@

if ($QueryName) {
  if ($QueryName -cnotmatch '^Global\\so-[A-Za-z0-9._-]+-[a-f0-9]{64}$') { Write-Output "unknown"; exit 0 }
  Write-Output ([SoJob]::Inspect($QueryName)); exit 0
}
if ($JobName -cnotmatch '^Global\\so-[A-Za-z0-9._-]+-[a-f0-9]{64}$') { throw "invalid job custody name" }
$name = $Pipe
if ($name.StartsWith("\\.\pipe\")) { $name = $name.Substring(9) }
# Duplex control requires an overlapped handle: on .NET Framework a pending
# asynchronous read on a synchronous PipeStream can serialize a concurrent
# write. That would delay the empty reply until another order arrives.
$client = New-Object System.IO.Pipes.NamedPipeClientStream(".", $name, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
$client.Connect(5000)
$writer = New-Object System.IO.StreamWriter($client)
$writer.AutoFlush = $true
$reader = New-Object System.IO.StreamReader($client)

function Send([string] $line) { try { $writer.Write($line + "`n") } catch { } }

$job = [IntPtr]::Zero
$pi = $null
try {
  [string[]]$targetArguments = ConvertFrom-Json -InputObject ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded)))
  if ($targetArguments.Count -lt 1) { throw "the target argv is empty" }
  # Admission arrives only after the controller durably records this helper.
  $job = [SoJob]::MakeJob($JobName, $MemoryLimit)
  Send "ready"
  $admission = $reader.ReadLineAsync()
  if (-not $admission.Wait(15000) -or $admission.Result -cne "go") { throw "job admission refused" }
  $parts = @()
  foreach ($arg in $targetArguments) { $parts += [SoJob]::Quote([string]$arg) }
  $pi = [SoJob]::StartSuspended(($parts -join " "))
  if (-not [SoJob]::AssignProcessToJobObject($job, $pi.hProcess)) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    [void][SoJob]::TerminateProcess($pi.hProcess, 126)
    Send ("failed AssignProcessToJobObject failed with Win32 error " + $code + " - the target never ran")
    exit 126
  }
  if ([SoJob]::ResumeThread($pi.hThread) -eq [uint32]::MaxValue) { throw "ResumeThread failed" }
  Send "attached"
} catch {
  if ($pi -ne $null -and $pi.hProcess -ne [IntPtr]::Zero) { [void][SoJob]::TerminateProcess($pi.hProcess, 126) }
  if ($job -ne [IntPtr]::Zero) { [void][SoJob]::TerminateJobObject($job, 126); [void][SoJob]::CloseHandle($job) }
  Send ("failed " + $_.Exception.Message)
  exit 126
}

# Orders from the controller are read asynchronously on this one thread (a
# PowerShell runspace is single-threaded; ReadLineAsync polls without one). The
# pipe closing - the controller died - is itself the order to terminate.
$pendingRead = $reader.ReadLineAsync()
$pipeClosed = $false
function NextOrders {
  $found = @()
  while ($script:pendingRead -ne $null -and $script:pendingRead.IsCompleted) {
    $line = $null
    try { $line = $script:pendingRead.Result } catch { $line = $null }
    if ($line -eq $null) { $script:pipeClosed = $true; $script:pendingRead = $null; $found += "closed"; break }
    $found += $line.Trim()
    $script:pendingRead = $reader.ReadLineAsync()
  }
  return $found
}

$exitCode = 1
$rootExited = $false
$rootExitedAt = $null
while ($true) {
  if (-not $rootExited -and [SoJob]::WaitForSingleObject($pi.hProcess, 50) -eq 0) {
    $rootExited = $true
    $rootExitedAt = Get-Date
    $c = [uint32]0
    if ([SoJob]::GetExitCodeProcess($pi.hProcess, [ref]$c)) { $exitCode = [int]$c }
  }
  foreach ($order in (NextOrders)) {
    # A stop from the controller, or the controller's death (pipe closed):
    # end every member now. "release" needs nothing here - the helper exits
    # on its own the moment the job is proven empty.
    if ($order -eq "kill" -or $order -eq "closed") { [void][SoJob]::TerminateJobObject($job, 137); if (-not $rootExited) { $rootExited = $true; $rootExitedAt = Get-Date; $exitCode = 137 } }
  }
  if ($rootExited) {
    $active = [SoJob]::ActiveProcesses($job)
    if ($active -eq 0) { Send "empty"; break }
    # The root is gone but members remain (a detached grandchild): natural
    # exit cleans them up too, after a short grace for the ordinary case.
    if (((Get-Date) - $rootExitedAt).TotalMilliseconds -gt 2000) { [void][SoJob]::TerminateJobObject($job, 137) }
  }
  Start-Sleep -Milliseconds 50
}
[void][SoJob]::CloseHandle($pi.hThread)
[void][SoJob]::CloseHandle($pi.hProcess)
[void][SoJob]::CloseHandle($job)
# This is a dedicated helper process. A pending .NET pipe read can prevent
# PowerShell's normal host shutdown, and disposing its shared stream can
# wait for that read. The kernel has already proved the job empty and all
# owned process/job handles are closed. Exit the helper process directly;
# Windows closes the pipe and cancels pending IO without a disposal wait.
[Environment]::Exit($exitCode)
