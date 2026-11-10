; Inno Setup 6 script for the single-file installer. Installs for the current user (no admin rights); the first dialog offers "Install for all users" (needs admin).
;   Build with:  powershell -File windows\build-release.ps1 -NodeExe C:\path\to\node.exe
; (c) Kish IT - https://kish-it.com
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\dist\stage"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

[Setup]
AppId={{6F1D2B7A-3C54-4E0B-9A6E-4D2F7B1C8E55}
AppName=Mikrotik Traffic Control
AppVersion={#AppVersion}
AppPublisher=Kish IT
AppPublisherURL=https://kish-it.com
AppSupportURL=https://kish-it.com
AppCopyright=Copyright (c) Kish IT - kish-it.com
DefaultDirName={autopf}\Mikrotik Traffic Control
DefaultGroupName=Mikrotik Traffic Control
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
SetupIconFile={#StageDir}\windows\mtc.ico
UninstallDisplayIcon={app}\windows\mtc.ico
DisableProgramGroupPage=yes
LicenseFile={#StageDir}\LICENSE
OutputDir={#OutDir}
OutputBaseFilename=MikrotikTrafficControl-{#AppVersion}-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Mikrotik Traffic Control
ArchitecturesAllowed=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "startup"; Description: "Start with &Windows (tray icon)"; GroupDescription: "Options:"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Mikrotik Traffic Control"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File ""{app}\windows\Tray-MTC.ps1"" -OpenDashboard"; WorkingDir: "{app}\windows"; IconFilename: "{app}\windows\mtc.ico"
Name: "{group}\Uninstall"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Mikrotik Traffic Control"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File ""{app}\windows\Tray-MTC.ps1"" -OpenDashboard"; WorkingDir: "{app}\windows"; IconFilename: "{app}\windows\mtc.ico"; Tasks: desktopicon
Name: "{autostartup}\Mikrotik Traffic Control (tray)"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File ""{app}\windows\Tray-MTC.ps1"" -NoSplash"; WorkingDir: "{app}\windows"; IconFilename: "{app}\windows\mtc.ico"; Tasks: startup

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -STA -File ""{app}\windows\Tray-MTC.ps1"" -OpenDashboard"; Description: "Start Mikrotik Traffic Control and open the setup guide"; Flags: postinstall nowait skipifsilent runhidden runasoriginaluser

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\windows\Stop-MTC.ps1"""; Flags: runhidden; RunOnceId: "StopMTC"
