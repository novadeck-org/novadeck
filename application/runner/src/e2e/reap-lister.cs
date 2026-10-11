// Lists the processes of an e2e sandbox on Windows, as Linux's /proc gives them (see
// reap.ts, which compiles and runs it): those that started at or after the sandbox, other
// than the caller and this one, whose working folder is inside the sandbox or whose HOME
// or USERPROFILE is its home, read from their parameters (the offsets are a 64-bit PEB's
// and its RTL_USER_PROCESS_PARAMETERS'), as JSON: their pids, names and starts in
// milliseconds since the epoch. A process it may not read, another user's or the system's,
// never counts, as a sandbox's is always this user's.
// Its arguments: the sandbox's start, root and home, and the caller's pid.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public static class NovadeckReap {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, IntPtr[] info, int length, out int written);
  static byte[] Read(IntPtr handle, IntPtr address, int size) {
    var buffer = new byte[size];
    IntPtr read;
    return ReadProcessMemory(handle, address, buffer, (IntPtr)size, out read) ? buffer : null;
  }
  static IntPtr Pointer(IntPtr handle, IntPtr address) {
    var bytes = Read(handle, address, 8);
    return bytes == null ? IntPtr.Zero : (IntPtr)BitConverter.ToInt64(bytes, 0);
  }
  static string[] Of(int pid) {
    IntPtr handle = OpenProcess(0x0410, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      var info = new IntPtr[6];
      int written;
      if (NtQueryInformationProcess(handle, 0, info, IntPtr.Size * 6, out written) != 0) return null;
      IntPtr parameters = Pointer(handle, info[1] + 0x20);
      if (parameters == IntPtr.Zero) return null;
      string cwd = "";
      var folder = Read(handle, parameters + 0x38, 16);
      if (folder != null) {
        var name = Read(handle, (IntPtr)BitConverter.ToInt64(folder, 8), BitConverter.ToUInt16(folder, 0));
        if (name != null) cwd = Encoding.Unicode.GetString(name);
      }
      IntPtr block = Pointer(handle, parameters + 0x80);
      var sized = Read(handle, parameters + 0x3F0, 8);
      long size = sized == null ? 0 : BitConverter.ToInt64(sized, 0);
      if (size <= 0 || size > (1 << 20)) size = 32768;
      var environment = Read(handle, block, (int)size);
      return new[] { cwd, environment == null ? "" : Encoding.Unicode.GetString(environment) };
    } finally {
      CloseHandle(handle);
    }
  }
  static string Quoted(string text) {
    return "\"" + text.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }
  public static int Main(string[] args) {
    var since = DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(args[0])).UtcDateTime;
    string root = args[1], home = args[2];
    int caller = int.Parse(args[3]), self = Process.GetCurrentProcess().Id;
    var found = new StringBuilder("[");
    foreach (var process in Process.GetProcesses()) {
      try {
        if (process.Id == self || process.Id == caller) continue;
        DateTime created;
        try { created = process.StartTime.ToUniversalTime(); } catch { continue; }
        if (created < since) continue;
        var read = Of(process.Id);
        if (read == null) continue;
        string cwd = read[0].TrimEnd('\\');
        bool inside = string.Equals(cwd, root, StringComparison.OrdinalIgnoreCase) ||
          cwd.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
        if (!inside) {
          bool own = false;
          foreach (var variable in read[1].Split('\0'))
            if (string.Equals(variable, "HOME=" + home, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(variable, "USERPROFILE=" + home, StringComparison.OrdinalIgnoreCase)) {
              own = true;
              break;
            }
          if (!own) continue;
        }
        long start = new DateTimeOffset(DateTime.SpecifyKind(created, DateTimeKind.Utc)).ToUnixTimeMilliseconds();
        if (found.Length > 1) found.Append(",");
        found.Append("{\"pid\":").Append(process.Id)
          .Append(",\"comm\":").Append(Quoted(process.ProcessName + ".exe"))
          .Append(",\"start\":").Append(start).Append("}");
      } catch {
        // Gone meanwhile.
      }
    }
    Console.Out.Write(found.Append("]").ToString());
    return 0;
  }
}
