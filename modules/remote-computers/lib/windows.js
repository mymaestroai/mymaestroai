'use strict';
// PowerShell for Windows computers, as pure functions. Every script travels as ONE command line:
//   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64 of the UTF-16LE script>
// so there are no multi-line quirks. Caller text never goes into a script as text: it is either base64 that the script decodes
// (type) or an integer / a fixed word from a list that this file checks first (everything else).

const MAX_LINE = 30000;
const MAX_TYPE_CHARS = 2000;
const OK_LINE = 'MMOK';

class WindowsError extends Error {
  constructor(message, code) { super(message); this.name = 'WindowsError'; this.code = code || 'EBADARG'; }
}

function encodePs(script) {
  if (typeof script !== 'string' || !script) throw new WindowsError('A script is needed.');
  const line = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  if (line.length > MAX_LINE) throw new WindowsError('That is too long to send in one command.', 'ETOOLONG');
  return line;
}

const int = (v, name, min, max) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new WindowsError(`${name} must be a whole number from ${min} to ${max}.`);
  return v;
};

// The C# helper compiled on the computer. Only what the scripts below use.
const DPI_CS = `
using System; using System.Runtime.InteropServices;
public class MMDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
`;
const INPUT_CS = `
using System; using System.Runtime.InteropServices; using System.Threading;
public class MMIn {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  static void Send(INPUT i) { if (SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("The computer did not accept the input (is a secure screen showing?)."); }
  public static void Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); Send(i); }
  public static void Key(ushort vk, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.dwFlags = flags; Send(i); }
  public static void Uni(ushort ch, bool up) { INPUT i = new INPUT(); i.type = 1; i.u.ki.wScan = ch; i.u.ki.dwFlags = 4u | (up ? 2u : 0u); Send(i); }
  public static void Pause(int ms) { Thread.Sleep(ms); }
}
`;
const here = (cs) => `Add-Type -TypeDefinition @'\n${cs.trim()}\n'@`;

const screenCheck = (xy) => `Add-Type -AssemblyName System.Windows.Forms
$mmb = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
${xy ? 'if ($mmx -lt 0 -or $mmy -lt 0 -or $mmx -ge $mmb.Width -or $mmy -ge $mmb.Height) { throw "That place is outside the screen." }' : ''}`;

const head = ['$ErrorActionPreference = \'Stop\'', '$ProgressPreference = \'SilentlyContinue\''];
const tail = ['Write-Output \'' + OK_LINE + '\''];
const script = (...parts) => [...head, ...parts, ...tail].join('\n');

function screenshotScript({ maxWidth = 1600, quality = 70 } = {}) {
  const mw = int(maxWidth, 'maxWidth', 320, 1920), q = int(quality, 'quality', 10, 100);
  return [
    ...head,
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    here(DPI_CS),
    '[void][MMDpi]::SetProcessDPIAware()',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($full)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    '$g.Dispose()',
    `$nw = $b.Width; $nh = $b.Height; if ($nw -gt ${mw}) { $nh = [int][Math]::Round($b.Height * ${mw} / $b.Width); $nw = ${mw} }`,
    '$pic = New-Object System.Drawing.Bitmap($nw, $nh)',
    '$g2 = [System.Drawing.Graphics]::FromImage($pic)',
    '$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic',
    '$g2.DrawImage($full, 0, 0, $nw, $nh)',
    '$g2.Dispose()',
    '$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq \'image/jpeg\' } | Select-Object -First 1',
    '$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)',
    `$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${q})`,
    '$ms = New-Object System.IO.MemoryStream',
    '$pic.Save($ms, $codec, $ep)',
    'Write-Output ("MMSHOT $nw $nh $($b.Width) $($b.Height) " + [Convert]::ToBase64String($ms.ToArray()) + " MMEND")',
  ].join('\n');
}

function parseScreenshot(output) {
  const s = String(output == null ? '' : output);
  const bad = () => new WindowsError(`The computer did not return a picture: ${s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300)}`, 'EBADSHOT');
  const m = /(?:^|\n)MMSHOT (\d{1,5}) (\d{1,5}) (\d{1,5}) (\d{1,5}) /.exec(s);
  if (!m) throw bad();
  // The picture is the rest of the line. A terminal may have broken that line or added colour codes, so when the end mark MMEND is there
  // the text up to it is used, with line breaks and escape codes removed.
  const rest = s.slice(m.index + m[0].length);
  const end = rest.indexOf(' MMEND');
  const body = (end >= 0 ? rest.slice(0, end) : rest.split('\n')[0]).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw bad();
  const jpeg = Buffer.from(body, 'base64');
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new WindowsError('The computer returned something that is not a picture.', 'EBADSHOT');
  return { width: Number(m[1]), height: Number(m[2]), screenWidth: Number(m[3]), screenHeight: Number(m[4]), jpeg };
}

const BUTTONS = { left: [0x0002, 0x0004], right: [0x0008, 0x0010], middle: [0x0020, 0x0040] };

function clickScript({ x, y, button = 'left', double = false } = {}) {
  int(x, 'x', 0, 32767); int(y, 'y', 0, 32767);
  if (typeof button !== 'string' || !Object.prototype.hasOwnProperty.call(BUTTONS, button)) throw new WindowsError('button must be left, right or middle.');
  if (typeof double !== 'boolean') throw new WindowsError('double must be true or false.');
  const [down, up] = BUTTONS[button];
  const press = `[MMIn]::Mouse(${down}, 0); [MMIn]::Pause(30); [MMIn]::Mouse(${up}, 0)`;
  return script(
    here(INPUT_CS), `$mmx = ${x}; $mmy = ${y}`, '[void][MMIn]::SetProcessDPIAware()', screenCheck(true),
    '[void][MMIn]::SetCursorPos($mmx, $mmy)', '[MMIn]::Pause(40)',
    press, ...(double ? ['[MMIn]::Pause(60)', press] : []),
  );
}

function typeScript({ text } = {}) {
  if (typeof text !== 'string' || !text) throw new WindowsError('There is no text to type.');
  if (text.length > MAX_TYPE_CHARS) throw new WindowsError(`Type at most ${MAX_TYPE_CHARS} characters at a time.`);
  const b64 = Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf16le').toString('base64');
  return script(
    here(INPUT_CS),
    `$mmt = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}'))`,
    'foreach ($c in $mmt.ToCharArray()) {',
    '  if ($c -eq [char]10) { [MMIn]::Key(13, 0); [MMIn]::Key(13, 2) }',
    '  elseif ($c -eq [char]9) { [MMIn]::Key(9, 0); [MMIn]::Key(9, 2) }',
    '  else { [MMIn]::Uni([uint16]$c, $false); [MMIn]::Uni([uint16]$c, $true) }',
    '  [MMIn]::Pause(4)',
    '}',
  );
}

// Names -> [virtual-key code, extended key]. Nothing outside this list can be pressed.
const KEYS = new Map();
const addKey = (names, vk, ext = 0) => { for (const n of names) KEYS.set(n, [vk, ext]); };
addKey(['enter', 'return'], 0x0d); addKey(['esc', 'escape'], 0x1b); addKey(['tab'], 0x09); addKey(['space'], 0x20);
addKey(['backspace'], 0x08); addKey(['delete', 'del'], 0x2e, 1); addKey(['insert', 'ins'], 0x2d, 1);
addKey(['home'], 0x24, 1); addKey(['end'], 0x23, 1); addKey(['pageup', 'pgup'], 0x21, 1); addKey(['pagedown', 'pgdn'], 0x22, 1);
addKey(['left'], 0x25, 1); addKey(['up'], 0x26, 1); addKey(['right'], 0x27, 1); addKey(['down'], 0x28, 1);
for (let i = 1; i <= 12; i++) addKey([`f${i}`], 0x6f + i);
for (let i = 0; i < 26; i++) addKey([String.fromCharCode(97 + i)], 0x41 + i);
for (let i = 0; i < 10; i++) addKey([String(i)], 0x30 + i);
const MODS = new Map([['ctrl', [0x11, 0]], ['control', [0x11, 0]], ['alt', [0x12, 0]], ['shift', [0x10, 0]], ['win', [0x5b, 1]], ['windows', [0x5b, 1]]]);

// 'ctrl+shift+esc' -> [[vk, ext], ...] in the order they are pressed (modifiers first, then the key); throws on a name that is not allowed.
function parseKeys(keys) {
  if (typeof keys !== 'string' || !keys.trim() || keys.length > 60) throw new WindowsError('keys must be like "ctrl+c", "enter" or "alt+tab".');
  const parts = keys.toLowerCase().split('+').map((p) => p.trim());
  if (parts.length > 5 || parts.some((p) => !p)) throw new WindowsError('keys must be like "ctrl+c", "enter" or "alt+tab".');
  const last = parts[parts.length - 1], mods = parts.slice(0, -1);
  const out = [];
  const seen = new Set();
  for (const m of mods) {
    if (!MODS.has(m)) throw new WindowsError(`"${m.replace(/[^\x20-\x7e]/g, '?').slice(0, 20)}" is not a modifier I can press (use ctrl, alt, shift or win).`);
    const vk = MODS.get(m)[0];
    if (seen.has(vk)) throw new WindowsError('A modifier is repeated.');
    seen.add(vk); out.push(MODS.get(m));
  }
  if (KEYS.has(last)) out.push(KEYS.get(last));
  else if (MODS.has(last) && !mods.length) out.push(MODS.get(last));   // a lone "win" or "shift"
  else throw new WindowsError(`"${last.replace(/[^\x20-\x7e]/g, '?').slice(0, 20)}" is not a key I can press. Allowed: enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, arrows, f1 to f12, a letter or a digit.`);
  return out;
}

function keyScript({ keys } = {}) {
  const seq = parseKeys(keys);
  const down = seq.map(([vk, ext]) => `[MMIn]::Key(${vk}, ${ext})`);
  const up = [...seq].reverse().map(([vk, ext]) => `[MMIn]::Key(${vk}, ${ext | 2})`);
  return script(here(INPUT_CS), ...down, '[MMIn]::Pause(30)', ...up);
}

function scrollScript({ x, y, amount } = {}) {
  int(amount, 'amount', -20, 20);
  if (amount === 0) throw new WindowsError('amount must not be 0.');
  const move = x !== undefined || y !== undefined;
  if (move) { int(x, 'x', 0, 32767); int(y, 'y', 0, 32767); }
  return script(
    here(INPUT_CS), '[void][MMIn]::SetProcessDPIAware()',
    ...(move ? [`$mmx = ${x}; $mmy = ${y}`, screenCheck(true), '[void][MMIn]::SetCursorPos($mmx, $mmy)', '[MMIn]::Pause(40)'] : []),
    `[MMIn]::Mouse(0x0800, ${amount * 120})`,
  );
}

// The cmd shell the agent starts echoes its banner, our line and its prompt around the output, so MMOK is looked for as a line of its own.
const sawOk = (output) => /(?:^|\n)MMOK\r?(?:\n|$)/.test(String(output == null ? '' : output));

module.exports = { encodePs, screenshotScript, parseScreenshot, clickScript, typeScript, keyScript, scrollScript, parseKeys, sawOk, WindowsError, MAX_LINE, MAX_TYPE_CHARS, OK_LINE, KEYS };
