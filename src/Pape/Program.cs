namespace Pape;

static class Program
{
    /// <summary>
    /// Pape.exe            start (or show the running copy's library window)
    /// Pape.exe --tray     start without opening the library window (used by Start with Windows)
    /// Pape.exe --exit     ask the running copy to quit (used by publish.ps1)
    /// Pape.exe --smoke    self-check with throwaway data and off-screen windows; writes Pape-Data\smoke.txt
    /// </summary>
    [STAThread]
    static void Main(string[] args)
    {
        bool Has(string flag) => args.Contains(flag, StringComparer.OrdinalIgnoreCase);
        var smoke = Has("--smoke");

        if (Has("--exit"))
        {
            if (EventWaitHandle.TryOpenExisting("Pape-exit", out var exit)) exit.Set();
            return;
        }

        Mutex? single = null;
        if (!smoke)
        {
            single = new Mutex(true, "Pape-single-instance", out var first);
            if (!first)
            {
                if (EventWaitHandle.TryOpenExisting("Pape-show", out var show)) show.Set();
                return;
            }
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => PortablePaths.Log("unhandled: " + e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => PortablePaths.Log("fatal: " + e.ExceptionObject);
        Application.Run(new Engine(smoke, showUi: !Has("--tray")));
        GC.KeepAlive(single);
    }
}
