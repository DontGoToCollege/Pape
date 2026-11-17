using System.Runtime.InteropServices;
using static Pape.Native;

namespace Pape;

/// <summary>Hidden top-level window for hotkeys, display power, display changes and Explorer restarts.</summary>
sealed class MessageWindow : NativeWindow
{
    static readonly uint TaskbarCreated = RegisterWindowMessage("TaskbarCreated");
    static Guid _displayState = new("6FE69556-704A-47A0-8F24-C28D936FDA47");   // GUID_CONSOLE_DISPLAY_STATE
    readonly Engine _engine;

    public MessageWindow(Engine engine)
    {
        _engine = engine;
        CreateHandle(new CreateParams { Caption = "Pape messages" });
        RegisterPowerSettingNotification(Handle, ref _displayState, 0);
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case 0x0312: // WM_HOTKEY
                _engine.OnHotkey((int)m.WParam);
                break;
            case 0x0218 when (int)m.WParam == 0x8013: // WM_POWERBROADCAST / PBT_POWERSETTINGCHANGE
                _engine.OnDisplayPower(Marshal.ReadInt32(m.LParam, 20) != 0);   // after the GUID and DataLength
                break;
            case 0x007E: // WM_DISPLAYCHANGE
                _engine.OnDisplayChange();
                break;
            default:
                if (TaskbarCreated != 0 && m.Msg == (int)TaskbarCreated) _engine.OnExplorerRestart();
                break;
        }
        base.WndProc(ref m);
    }
}
