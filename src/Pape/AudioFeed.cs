using NAudio.CoreAudioApi;
using NAudio.Dsp;
using NAudio.Wave;

namespace Pape;

/// <summary>
/// What the speakers are playing, as Wallpaper Engine's web API hands it to audio-reactive wallpapers:
/// 128 values, 64 left-channel bands then 64 right-channel bands, low to high, roughly 0..1.
/// Silence (WASAPI sends nothing while nothing plays) gives zeros.
/// </summary>
sealed class AudioFeed : IDisposable
{
    const int Size = 1024, Ring = 4096;
    WasapiLoopbackCapture? _capture;
    readonly float[] _left = new float[Ring], _right = new float[Ring];
    int _pos;
    long _lastData;
    readonly object _lock = new();

    public bool Running => _capture is not null;

    public void Start()
    {
        if (_capture is not null) return;
        try
        {
            _capture = new WasapiLoopbackCapture();
            _capture.DataAvailable += OnData;
            _capture.RecordingStopped += (_, e) => { if (e.Exception is not null) PortablePaths.Log("audio stopped: " + e.Exception.Message); };
            _capture.StartRecording();
        }
        catch (Exception ex)
        {
            PortablePaths.Log("audio capture unavailable: " + ex.Message);
            _capture?.Dispose();
            _capture = null;
        }
    }

    public void Stop()
    {
        if (_capture is null) return;
        try { _capture.StopRecording(); } catch { /* already stopped */ }
        _capture.Dispose();
        _capture = null;
    }

    void OnData(object? sender, WaveInEventArgs e)
    {
        var format = _capture?.WaveFormat;
        if (format is null || format.BitsPerSample != 32) return;   // the shared-mode mix format is 32-bit float
        var channels = format.Channels;
        var frames = e.BytesRecorded / (4 * channels);
        lock (_lock)
        {
            for (var i = 0; i < frames; i++)
            {
                var l = BitConverter.ToSingle(e.Buffer, i * channels * 4);
                var r = channels > 1 ? BitConverter.ToSingle(e.Buffer, i * channels * 4 + 4) : l;
                _left[_pos] = l;
                _right[_pos] = r;
                _pos = (_pos + 1) % Ring;
            }
            _lastData = Environment.TickCount64;
        }
    }

    public float[] Bands()
    {
        var result = new float[128];
        if (Environment.TickCount64 - _lastData > 250) return result;
        var l = new Complex[Size];
        var r = new Complex[Size];
        lock (_lock)
        {
            for (var i = 0; i < Size; i++)
            {
                var at = (_pos - Size + i + Ring) % Ring;
                var w = (float)FastFourierTransform.HannWindow(i, Size);
                l[i].X = _left[at] * w;
                r[i].X = _right[at] * w;
            }
        }
        FastFourierTransform.FFT(true, 10, l);
        FastFourierTransform.FFT(true, 10, r);
        Fill(l, result, 0);
        Fill(r, result, 64);
        return result;
    }

    static void Fill(Complex[] bins, float[] dest, int offset)
    {
        // 64 log-spaced bands over bins 1..511
        for (var b = 0; b < 64; b++)
        {
            var lo = (int)Math.Pow(511, b / 64.0);
            var hi = Math.Max(lo + 1, (int)Math.Pow(511, (b + 1) / 64.0));
            double sum = 0;
            for (var k = lo; k < hi && k < 512; k++) sum += Math.Sqrt(bins[k].X * bins[k].X + bins[k].Y * bins[k].Y);
            var mag = sum / (hi - lo);
            dest[offset + b] = (float)Math.Min(1, Math.Sqrt(mag) * 2.2);
        }
    }

    /// <summary>Names (lower case, no .exe) of other programs making sound right now.</summary>
    public static HashSet<string> AppsPlaying(HashSet<int> ignorePids)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var devices = new MMDeviceEnumerator();
            using var device = devices.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var sessions = device.AudioSessionManager.Sessions;
            for (var i = 0; i < sessions.Count; i++)
            {
                var s = sessions[i];
                if (s.AudioMeterInformation.MasterPeakValue < 0.01f) continue;
                var pid = (int)s.GetProcessID;
                if (pid == 0 || ignorePids.Contains(pid)) continue;
                try { using var p = System.Diagnostics.Process.GetProcessById(pid); names.Add(p.ProcessName.ToLowerInvariant()); }
                catch { /* exited */ }
            }
        }
        catch (Exception ex)
        {
            PortablePaths.Log("audio sessions: " + ex.Message);
        }
        return names;
    }

    public void Dispose() => Stop();
}
