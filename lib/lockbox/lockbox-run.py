#!/usr/bin/python3
# lockbox-run.py: run one command inside an OS-level box (Linux Landlock + seccomp),
# or, in "watch" mode, run it unconfined under strace and log what the box would refuse.
#   lockbox-run.py --probe
#   lockbox-run.py --profile-b64 <base64 of JSON profile> -- <argv...>
# Standard library only. Meant to be started as: /usr/bin/python3 -I -S lockbox-run.py ...
import base64
import ctypes
import errno
import json
import os
import re
import signal
import stat
import struct
import sys
import tempfile
import threading
import time

# ---- Landlock constants (defined here: the installed header is old) ----
# (EXECUTE 1<<0, READ_DIR 1<<3 and IOCTL_DEV 1<<15 are deliberately not handled, so not listed)
FS_WRITE_FILE, FS_READ_FILE = 1 << 1, 1 << 2
FS_REMOVE_DIR, FS_REMOVE_FILE, FS_MAKE_CHAR, FS_MAKE_DIR = 1 << 4, 1 << 5, 1 << 6, 1 << 7
FS_MAKE_REG, FS_MAKE_SOCK, FS_MAKE_FIFO, FS_MAKE_BLOCK = 1 << 8, 1 << 9, 1 << 10, 1 << 11
FS_MAKE_SYM, FS_REFER, FS_TRUNCATE = 1 << 12, 1 << 13, 1 << 14
SCOPE_ABSTRACT_UNIX_SOCKET, SCOPE_SIGNAL = 1 << 0, 1 << 1
SYS_LANDLOCK_CREATE_RULESET, SYS_LANDLOCK_ADD_RULE, SYS_LANDLOCK_RESTRICT_SELF = 444, 445, 446
LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
LANDLOCK_RULE_PATH_BENEATH = 1
HANDLED_FS = (FS_WRITE_FILE | FS_READ_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR | FS_MAKE_DIR
              | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM | FS_REFER | FS_TRUNCATE)
SCOPED = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL
WRITE_ALL = HANDLED_FS
FILE_RIGHTS = FS_READ_FILE | FS_WRITE_FILE | FS_TRUNCATE
MAX_RULES = 20000
SKIP_ERRNOS = (errno.EACCES, errno.EPERM, errno.ENOTCONN, errno.ESTALE, errno.ELOOP)
O_PATH = getattr(os, "O_PATH", 0o10000000)

PR_GET_SECCOMP, PR_SET_NO_NEW_PRIVS, PR_SET_SECCOMP, SECCOMP_MODE_FILTER = 21, 38, 22, 2
RET_ALLOW = 0x7FFF0000
RET_ERRNO = 0x00050000
ARCHES = {"x86_64": (0xC000003E, 41), "aarch64": (0xC00000B7, 198)}  # audit arch, __NR_socket
STRACE = "/usr/bin/strace"
TRACE_SET = ("open,openat,openat2,creat,mkdir,mkdirat,rmdir,unlink,unlinkat,rename,renameat,renameat2,link,"
             "linkat,symlink,symlinkat,truncate,mknod,mknodat,chdir,fchdir,clone,clone3,fork,vfork,connect")

class Fail(Exception):
    pass

_libc = None

def libc():
    global _libc
    if _libc is None:
        _libc = ctypes.CDLL(None, use_errno=True)
        _libc.syscall.restype = ctypes.c_long
        _libc.prctl.restype = ctypes.c_int
        _libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    return _libc

def sysc(nr, *args):
    """Raw syscall; returns (result, errno)."""
    lc = libc()
    ctypes.set_errno(0)
    r = lc.syscall(ctypes.c_long(nr), *[ctypes.c_long(a) for a in args])
    return r, ctypes.get_errno()

def addr(buf):
    return ctypes.addressof(buf)

def errname(e):
    return errno.errorcode.get(e, str(e))

# ---------------------------------------------------------------- probe
def landlock_abi():
    if not sys.platform.startswith("linux"):
        return -1
    r, _ = sysc(SYS_LANDLOCK_CREATE_RULESET, 0, 0, LANDLOCK_CREATE_RULESET_VERSION)
    return int(r) if r >= 0 else -1

def probe():
    machine, abi, linux = os.uname().machine, landlock_abi(), sys.platform.startswith("linux")
    strace = STRACE if os.access(STRACE, os.X_OK) and os.path.isfile(STRACE) else None
    tiocsti = None
    try:
        with open("/proc/sys/dev/tty/legacy_tiocsti") as f:
            tiocsti = int(f.read().strip())
    except (OSError, ValueError):
        pass
    reason = None
    if machine not in ARCHES:
        reason = "unsupported machine " + machine
    elif abi < 6:
        reason = "Landlock ABI below 6" if abi >= 0 else "Landlock not available"
    return {"platform": "linux" if linux else sys.platform, "machine": machine, "landlockAbi": abi,
            "scopes": abi >= 6, "seccomp": linux and libc().prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != -1,
            "strace": strace, "tiocsti": tiocsti, "ok": reason is None, "reason": reason}

# ---------------------------------------------------------------- profile
def is_path(p):
    return isinstance(p, str) and p.startswith("/") and "\0" not in p

def str_list(v, name, paths=True):
    if not isinstance(v, list):
        raise Fail("bad profile: " + name)
    for x in v:
        if not (is_path(x) if paths else isinstance(x, str) and "\0" not in x):
            raise Fail("bad profile: " + name)
    return v

def validate(prof):
    if not isinstance(prof, dict) or prof.get("v") != 1 or type(prof.get("v")) is not int:
        raise Fail("bad profile: v")
    if prof.get("mode") not in ("enforce", "watch"):
        raise Fail("bad profile: mode")
    out = {"mode": prof["mode"]}
    for k in ("agent", "tool", "label"):
        out[k] = prof.get(k, "")
        if not isinstance(out[k], str) or "\0" in out[k]:
            raise Fail("bad profile: " + k)
    for k in ("writes", "writeHoles", "readHoles", "readAllow", "devWrites"):
        out[k] = str_list(prof.get(k, []), k)
    env = prof.get("env")
    out["env"] = None
    if env is not None:
        if not isinstance(env, dict) or not isinstance(env.get("set"), dict):
            raise Fail("bad profile: env")
        str_list(env.get("keep"), "env.keep", paths=False)
        for k, v in env["set"].items():
            if not isinstance(v, str) or "\0" in v or not k or "=" in k or "\0" in k:
                raise Fail("bad profile: env.set")
        out["env"] = {"keep": env["keep"], "set": env["set"]}
    out["cwdFile"] = prof.get("cwdFile")
    if out["cwdFile"] is not None and not is_path(out["cwdFile"]):
        raise Fail("bad profile: cwdFile")
    for k in ("blockUnixSockets", "blockIoUring"):
        out[k] = prof.get(k, True)
        if not isinstance(out[k], bool):
            raise Fail("bad profile: " + k)
    log = prof.get("log")
    out["log"] = None
    if log is not None or out["mode"] == "watch":
        if not isinstance(log, dict) or not is_path(log.get("path")):
            raise Fail("bad profile: log")
        mx = log.get("max")
        if type(mx) is not int or not 1 <= mx <= 1000:
            raise Fail("bad profile: log.max")
        out["log"] = {"path": log["path"], "max": mx}
    out["test"] = validate_test(prof.get("test", {}))
    return out

# Test-only switches: they come ONLY from the profile (built by tests; the hub never sets it), never from the environment,
# because in watch mode the command runs with the agent's own environment.
TEST_BOOLS = ("noSeccomp", "forceProbe", "noReader")
TEST_INTS = ("graceMs", "slowJudgeMs", "pausePublishMs", "ctimeGraceMs")

def validate_test(t):
    if not isinstance(t, dict):
        raise Fail("bad profile: test")
    for k, v in t.items():
        if k == "strace":
            ok = is_path(v)
        elif k in TEST_BOOLS:
            ok = isinstance(v, bool)
        elif k == "noPunch":
            ok = v is False or v in ("default", "all")
        elif k in TEST_INTS:
            ok = type(v) is int and 0 <= v <= 600000
        else:
            ok = False
        if not ok:
            raise Fail("bad profile: test")
    return dict(t)

def make_env(prof):
    cur = os.environ
    if prof["env"] is None:
        env = dict(cur)
    else:
        env = {}
        for pat in prof["env"]["keep"]:
            if pat.endswith("*"):
                pre = pat[:-1]
                for k, v in cur.items():
                    if k.startswith(pre):
                        env[k] = v
            elif pat in cur:
                env[pat] = cur[pat]
        env.update(prof["env"]["set"])
    if prof["cwdFile"]:
        env["LOCKBOX_CWD_FILE"] = prof["cwdFile"]
    return env

def inside(p, root):
    """p equals root or lies below it (compares normalized absolute paths with a separator)."""
    if p == root or root == "/":
        return True
    return p.startswith(root.rstrip("/") + "/")

def real(p):
    return os.path.realpath(p)

# ---------------------------------------------------------------- enforce: Landlock
class PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

class Ruleset:
    def __init__(self):
        attr = struct.pack("<QQQ", HANDLED_FS, 0, SCOPED)
        buf = ctypes.create_string_buffer(attr, len(attr))
        r, e = sysc(SYS_LANDLOCK_CREATE_RULESET, addr(buf), len(attr), 0)
        if r < 0:
            raise Fail("landlock_create_ruleset failed: " + errname(e))
        self.fd = int(r)
        self.count = 0

    def add(self, path, rights, follow=True):
        flags = O_PATH | os.O_CLOEXEC | (0 if follow else os.O_NOFOLLOW)
        try:
            fd = os.open(path, flags)
        except FileNotFoundError:
            return
        except OSError as ex:
            if ex.errno in SKIP_ERRNOS:
                return   # an entry we can't open gets no rule: the box only gets tighter
            raise Fail("cannot open %s: %s" % (path, errname(ex.errno)))
        try:
            st = os.fstat(fd)
            if stat.S_ISLNK(st.st_mode):
                return
            # The folder actually opened must be the one named: a link swapped in on the way (by another command of
            # the same agent) would otherwise turn a rule for a root into a rule for wherever the link points.
            try:
                if os.readlink("/proc/self/fd/%d" % fd) != path:
                    return
            except OSError:
                return
            if not stat.S_ISDIR(st.st_mode):
                rights &= FILE_RIGHTS
            if not rights:
                return
            self.count += 1
            if self.count > MAX_RULES:
                raise Fail("more than %d rules" % MAX_RULES)
            pb = PathBeneath(rights, fd)
            r, e = sysc(SYS_LANDLOCK_ADD_RULE, self.fd, LANDLOCK_RULE_PATH_BENEATH, addr(pb), 0)
            if r < 0:
                raise Fail("landlock_add_rule %s failed: %s" % (path, errname(e)))
        finally:
            os.close(fd)

    def grant(self, rights, root, holes):
        if not os.path.lexists(root):
            return
        if not any(inside(h, root) for h in holes) or not os.path.isdir(root):
            self.add(root, rights, follow=True)
            return
        try:
            entries = list(os.scandir(root))
        except OSError as ex:
            if ex.errno in SKIP_ERRNOS:
                return   # a folder we can't list gets no rules: tighter, never wider
            raise Fail("cannot list %s: %s" % (root, errname(ex.errno)))
        for ent in entries:
            p = ent.path
            if p in holes or ent.is_symlink():
                continue
            if any(inside(h, p) for h in holes):
                self.grant(rights, p, holes)
            else:
                self.add(p, rights, follow=False)

    def restrict(self):
        r, e = sysc(SYS_LANDLOCK_RESTRICT_SELF, self.fd, 0)
        if r < 0:
            raise Fail("landlock_restrict_self failed: " + errname(e))

def expand_allow(patterns, limit=2000):
    """Read-only grants: each "*" stands for one folder name; links are never followed, missing paths are dropped."""
    out = []
    for pat in patterns:
        level = ["/"]
        for part in [x for x in os.path.normpath(pat).split("/") if x]:
            nxt = []
            for base in level:
                if part != "*":
                    p = os.path.join(base, part)
                    if os.path.isdir(p) and not os.path.islink(p):
                        nxt.append(p)
                    continue
                try:
                    for ent in os.scandir(base):
                        if ent.is_dir(follow_symlinks=False):
                            nxt.append(ent.path)
                except OSError:
                    pass
            level = nxt[:limit]
        out.extend(level)
    return out[:limit]

def build_ruleset(prof):
    rs = Ruleset()
    holes = [real(h) for h in prof["writeHoles"] + prof["readHoles"]]
    rholes = [real(h) for h in prof["readHoles"]]
    for p in prof["writes"]:
        # Granted as given (the hub sends real paths); a root that no longer resolves to itself is skipped.
        if real(p) == os.path.normpath(p):
            rs.grant(WRITE_ALL, os.path.normpath(p), holes)
    for p in prof["devWrites"]:
        if os.path.exists(p):
            rs.add(real(p), WRITE_ALL, follow=True)
    rs.grant(FS_READ_FILE, "/", rholes)
    for p in expand_allow(prof["readAllow"]):
        rs.add(p, FS_READ_FILE, follow=False)   # read-only, even inside a hole
    return rs

# ---------------------------------------------------------------- enforce: seccomp
def build_bpf(machine, block_unix, block_uring):
    arch, nr_socket = ARCHES[machine]
    prog, labels = [], {}  # prog: (code, jt, jf, k); jt/jf are ints or label names

    def ins(code, jt=0, jf=0, k=0): prog.append((code, jt, jf, k))

    def label(n): labels[n] = len(prog)

    LD, JEQ, JGE, RET = 0x20, 0x15, 0x35, 0x06
    ins(LD, k=4)
    ins(JEQ, 0, "eperm", arch)
    ins(LD, k=0)
    if machine == "x86_64":
        ins(JGE, "eperm", 0, 0x40000000)
    if block_unix:
        ins(JEQ, 0, "uend", nr_socket)
        ins(LD, k=16)
        ins(JEQ, "eacces", "allow", 1)
        label("uend")
    if block_uring:
        for nr in (425, 426, 427):
            ins(JEQ, "enosys", 0, nr)
    label("allow")
    ins(RET, k=RET_ALLOW)
    label("eperm")
    ins(RET, k=RET_ERRNO | 1)
    label("eacces")
    ins(RET, k=RET_ERRNO | 13)
    label("enosys")
    ins(RET, k=RET_ERRNO | 38)
    raw = b""
    for i, (code, jt, jf, k) in enumerate(prog):
        if isinstance(jt, str):
            jt = labels[jt] - i - 1
        if isinstance(jf, str):
            jf = labels[jf] - i - 1
        if not (0 <= jt <= 255 and 0 <= jf <= 255):
            raise Fail("seccomp jump out of range")
        raw += struct.pack("<HBBI", code, jt, jf, k)
    return raw, len(prog)

class SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]

def install_seccomp(machine, block_unix, block_uring):
    raw, n = build_bpf(machine, block_unix, block_uring)
    buf = ctypes.create_string_buffer(raw, len(raw))
    fp = SockFprog(n, addr(buf))
    lc = libc()
    ctypes.set_errno(0)
    if lc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, addr(fp), 0, 0) != 0:
        raise Fail("seccomp install failed: " + errname(ctypes.get_errno()))

SYS_CLOSE_RANGE = 436  # same number on x86_64 and aarch64

def close_inherited():
    """Close every descriptor above 2, however high the open-file limit is."""
    r, _ = sysc(SYS_CLOSE_RANGE, 3, 0xFFFFFFFF, 0)
    if r < 0:
        try:
            top = os.sysconf("SC_OPEN_MAX")
        except (OSError, ValueError):
            top = 1 << 20
        os.closerange(3, max(65536, top))

def restore_signals():
    """Python ignores SIGPIPE and SIGXFSZ, and an ignored signal stays ignored across exec: put back what bash would
    have got, so `git log | head` ends quietly as it does without the box."""
    for s in (signal.SIGPIPE, signal.SIGXFSZ):
        signal.signal(s, signal.SIG_DFL)
    signal.pthread_sigmask(signal.SIG_SETMASK, [])

def run_enforce(prof, argv):
    machine = os.uname().machine
    if machine not in ARCHES or not sys.platform.startswith("linux"):
        raise Fail("unknown machine " + machine)
    abi = landlock_abi()
    if abi < 6:
        raise Fail("Landlock ABI below 6")
    env = make_env(prof)
    rs = build_ruleset(prof)
    if libc().prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise Fail("no_new_privs failed: " + errname(ctypes.get_errno()))
    install_seccomp(machine, prof["blockUnixSockets"], prof["blockIoUring"])
    rs.restrict()
    close_inherited()
    restore_signals()
    try:
        os.execvpe(argv[0], argv, env)
    except OSError as ex:
        raise Fail("cannot run %s: %s" % (argv[0], errname(ex.errno)))

# ---------------------------------------------------------------- watch: strace parsing
SIMPLE_ESC = {"n": 10, "t": 9, "r": 13, "v": 11, "f": 12, "a": 7, "b": 8, "e": 27}

def unquote(tok):
    """Decode a strace C-style string token (starts with a double quote); None if it is not one."""
    m = re.match(r'"((?:[^"\\]|\\.)*)"', tok)
    if not m:
        return None

    def esc(e):
        s = e.group(1).decode("latin-1")
        if s[0] == "x":
            return bytes([int(s[1:], 16)])
        if s[0] in "01234567":
            return bytes([int(s, 8) & 255])
        return bytes([SIMPLE_ESC[s]]) if s in SIMPLE_ESC else s.encode("latin-1")

    body = m.group(1).encode("utf-8", "surrogateescape")
    return re.sub(rb"\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)", esc, body, flags=re.S).decode("utf-8", "surrogateescape")

def split_args(s):
    """Split a strace argument list on top-level commas (strings, braces and fd paths kept whole)."""
    out, depth, start, i, n, inq = [], 0, 0, 0, len(s), False
    while i < n:
        c = s[i]
        if inq:
            if c == "\\":
                i += 2
                continue
            if c == '"':
                inq = False
        elif c == '"':
            inq = True
        elif c in "{[(":
            depth += 1
        elif c in "}])":
            depth -= 1
        elif c == "<" and depth == 0 and s[start:i].strip().isdigit():
            k = s.find(">", i + 1)
            while k != -1 and k + 1 < n and s[k + 1] != ",":
                k = s.find(">", k + 1)
            if k == -1:
                k = n - 1
            i = k
        elif c == "," and depth == 0:
            out.append(s[start:i].strip())
            start = i + 1
        i += 1
    out.append(s[start:].strip())
    return out

LINE_RE = re.compile(r"^(?:(\d+)\s+)?(\w+)\((.*)\)\s+=\s+(-?\d+|\?)(?:<(.*?)>)?")
UNFIN_RE = re.compile(r"^(?:(\d+)\s+)?(\w+)\((.*?)\s*<unfinished \.\.\.>\s*$")
RESUMED_RE = re.compile(r"^(?:(\d+)\s+)?<\.\.\. (\w+) resumed>(.*)$")
FD_RE = re.compile(r"^(\d+)<(.*)>$")
SUN_RE = re.compile(r'sun_path=(@?)("(?:[^"\\]|\\.)*")')
WRITE_FLAGS = {"O_WRONLY", "O_RDWR", "O_CREAT", "O_TRUNC"}
# name -> (write (dirfd index, path index) pairs, read pairs)
PATH_CALLS = {
    "creat": (((None, 0),), ()), "mkdir": (((None, 0),), ()), "mkdirat": (((0, 1),), ()),
    "rmdir": (((None, 0),), ()), "unlink": (((None, 0),), ()), "unlinkat": (((0, 1),), ()),
    "rename": (((None, 0), (None, 1)), ()), "renameat": (((0, 1), (2, 3)), ()),
    "renameat2": (((0, 1), (2, 3)), ()), "link": (((None, 1),), ((None, 0),)),
    "linkat": (((2, 3),), ((0, 1),)), "symlink": (((None, 1),), ()), "symlinkat": (((1, 2),), ()),
    "truncate": (((None, 0),), ()), "mknod": (((None, 0),), ()), "mknodat": (((0, 1),), ()),
}
OPEN_CALLS = {"open": (None, 0, 1), "openat": (0, 1, 2), "openat2": (0, 1, 2)}

def norm(p):
    p = os.path.normpath(p)
    return "/" + p.lstrip("/") if p.startswith("//") else p

class Judge:
    """Parses strace output line by line and records what the box would have refused."""

    def __init__(self, prof, cwd0):
        self.p, self.cwd0 = prof, cwd0
        self.writes = [real(w) for w in prof["writes"]]
        self.holes = [real(h) for h in prof["writeHoles"] + prof["readHoles"]]
        self.rholes = [real(h) for h in prof["readHoles"]]
        self.allow = expand_allow(prof["readAllow"])
        self.dev = [real(d) for d in prof["devWrites"]]
        self.cwds, self.pending, self.seen, self.entries, self.rcache = {}, {}, set(), [], {}
        self.more = 0
        self.slow_ms = prof["test"].get("slowJudgeMs", 0)   # test-only: sleep per judged line
        self.max = prof["log"]["max"] if prof["log"] else 50
        self.lock = threading.Lock()

    # -- judgement
    def parent_real(self, p):
        d, b = os.path.split(p)
        if d not in self.rcache:
            self.rcache[d] = real(d) if len(self.rcache) < 5000 else d
        r = self.rcache[d]
        return norm(os.path.join(r, b))

    def write_refused(self, p):
        p = self.parent_real(p)
        if p == "/proc" or p.startswith("/proc/") or p == "/sys" or p.startswith("/sys/"):
            return False
        if any(inside(p, d) for d in self.dev):
            return False
        for w in self.writes:
            if inside(p, w) and not any(inside(h, w) and inside(p, h) for h in self.holes):
                return False
        return True

    def read_refused(self, p):
        p = self.parent_real(p)
        if not any(inside(p, h) for h in self.rholes):
            return False
        if any(inside(p, a) for a in self.allow):
            return False
        for w in self.writes:
            if inside(p, w) and any(inside(w, h) for h in self.rholes if inside(p, h)):
                return False
        return True

    def add(self, rule, op, path):
        key = (rule, op, path)
        with self.lock:
            if key in self.seen:
                return
            if len(self.seen) < 200000:
                self.seen.add(key)
            if len(self.entries) < self.max:
                self.entries.append({"op": op, "path": path, "rule": rule})
            else:
                self.more += 1

    # -- helpers
    def cwd(self, pid):
        return self.cwds.get(pid, self.cwd0)

    def dirpath(self, pid, tok):
        if tok is None or tok == "AT_FDCWD":
            return self.cwd(pid)
        m = FD_RE.match(tok)
        return m.group(2) if m else None

    def resolve(self, pid, dirtok, ptok):
        p = unquote(ptok)
        if not p:
            return None
        if p.startswith("/"):
            return norm(p)
        base = self.dirpath(pid, dirtok)
        return norm(os.path.join(base, p)) if base else None

    # -- parsing
    def feed(self, line):
        if self.slow_ms:
            time.sleep(self.slow_ms / 1000.0)
        line = line.rstrip("\n")
        m = RESUMED_RE.match(line)
        if m:
            pid = int(m.group(1) or 0)
            pre = self.pending.pop((pid, m.group(2)), None)
            if pre is None:
                return
            line = "%s(%s%s" % (m.group(2), pre, m.group(3))
            self.call(pid, line)
            return
        m = UNFIN_RE.match(line)
        if m:
            if len(self.pending) < 10000:
                self.pending[(int(m.group(1) or 0), m.group(2))] = m.group(3)
            return
        m = re.match(r"^(\d+)\s+(.*)$", line)
        self.call(int(m.group(1)) if m else 0, m.group(2) if m else line)

    def call(self, pid, text):
        m = LINE_RE.match(text)
        if not m:
            return
        name, argstr, rets, retpath = m.group(2), m.group(3), m.group(4), m.group(5)
        if rets == "?":
            return
        ret = int(rets)
        if ret < 0:
            return
        if pid not in self.cwds and not self.cwds:
            self.cwds[pid] = self.cwd0
        if name in ("clone", "clone3", "fork", "vfork"):
            if ret > 0:
                self.cwds[ret] = self.cwd(pid)
            return
        args = split_args(argstr)
        if name in ("chdir", "fchdir") and args:
            p = self.resolve(pid, None, args[0]) if name == "chdir" else self.dirpath(pid, args[0])
            if p and (name == "chdir" or FD_RE.match(args[0])):
                self.cwds[pid] = p
        elif name in OPEN_CALLS:
            self.do_open(pid, name, args, retpath)
        elif name in PATH_CALLS:
            ws, rs = PATH_CALLS[name]
            for di, pi in rs:
                self.judge(pid, name, args, di, pi, False)
            for di, pi in ws:
                self.judge(pid, name, args, di, pi, True)
        # Only a unix-socket connect that SUCCEEDED is logged: glibc opens one to ask nscd or systemd about users
        # (bash does with no USER in its environment), fails to connect and carries on; enforce refusing that
        # socket changes nothing, so logging its creation would only be noise.
        elif name == "connect" and self.p["blockUnixSockets"]:
            if "sa_family=AF_UNIX" in argstr or "sa_family=AF_LOCAL" in argstr:
                sm = SUN_RE.search(argstr)
                path = (sm.group(1) + (unquote(sm.group(2)) or "")) if sm else ""
                self.add("unix-socket", "connect", path)
        # io_uring_setup is not traced or logged: enforce refuses it with ENOSYS and libuv (every Node program,
        # which probes it at start) falls back to threads, so a line per Node command would only be noise.

    def judge(self, pid, name, args, di, pi, is_write, override=None):
        if pi >= len(args):
            return
        path = override or self.resolve(pid, args[di] if di is not None and di < len(args) else None, args[pi])
        if not path:
            return
        if is_write:
            if self.write_refused(path):
                self.add("write-outside", name, path)
        elif self.read_refused(path):
            self.add("secret-read", name, path)

    def do_open(self, pid, name, args, retpath):
        di, pi, fi = OPEN_CALLS[name]
        if fi >= len(args):
            return
        flags = set(re.findall(r"O_\w+", args[fi]))
        override = norm(retpath) if retpath and retpath.startswith("/") else None
        if flags & WRITE_FLAGS:
            self.judge(pid, name, args, di, pi, True, override)
        elif not flags & {"O_PATH", "O_DIRECTORY"}:
            self.judge(pid, name, args, di, pi, False, override)

def read_stream(fd, judge):
    with os.fdopen(fd, "rb", buffering=65536) as f:
        for raw in f:
            try:
                judge.feed(raw.decode("utf-8", "surrogateescape"))
            except Exception:
                pass

# ---------------------------------------------------------------- watch: running and logging
def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

def write_log(prof, entries, more):
    if not entries and not more:
        return
    base = {"agent": prof["agent"], "tool": prof["tool"], "mode": "watch", "cmd": prof["label"]}
    if more:
        entries = entries + [{"op": "more", "path": "", "rule": "more", "count": more}]
    lines = [json.dumps({"ts": iso_now(), **base, **e}) for e in entries]
    try:
        path = prof["log"]["path"]
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        try:
            if os.stat(path).st_size > 5 * 1024 * 1024:
                os.replace(path, path + ".1")   # one older file kept; the log never grows without end
        except OSError:
            pass
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_CLOEXEC, 0o600)
        try:
            data = ("\n".join(lines) + "\n").encode("utf-8", "surrogateescape")
            while data:
                data = data[os.write(fd, data):]
        finally:
            os.close(fd)
    except Exception as ex:
        reason = errname(ex.errno) if isinstance(ex, OSError) and ex.errno else type(ex).__name__
        sys.stderr.write("lockbox: watch log not written (%s)\n" % reason)

def trace_bin(prof):
    """The strace to run; the profile's test.strace (test-only) replaces it."""
    return prof["test"].get("strace") or STRACE

def strace_works(prof, seccomp=True):
    if seccomp and prof["test"].get("noSeccomp"):
        return False   # test-only switch: pretend --seccomp-bpf does not work here
    if prof["test"].get("forceProbe"):
        return True   # test-only switch: skip the probe (lets a test reach the refused-attach path)
    true_bin = next((p for p in ("/usr/bin/true", "/bin/true") if os.path.exists(p)), None)
    sbin = trace_bin(prof)
    if not os.access(sbin, os.X_OK) or not true_bin:
        return False
    pid = os.fork()
    if pid == 0:
        try:
            dn = os.open("/dev/null", os.O_RDWR)
            for i in (0, 1, 2):
                os.dup2(dn, i)
            # the exact options of the real run: an strace without -DDD, or a refused -DDD attach, fails here
            os.execv(sbin, [sbin, "-DDD", "-I2"] + (["--seccomp-bpf"] if seccomp else []) +
                     ["-f", "-qq", "-o", "/dev/null", "-e", "trace=none", "--", true_bin])
        finally:
            os._exit(127)
    _, status = os.waitpid(pid, 0)
    return os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0

def exit_like(status):
    if os.WIFSIGNALED(status):
        sig = os.WTERMSIG(status)
        # SIGKILL and SIGSTOP cannot have a handler set (EINVAL): killing ourselves with them still works
        try:
            signal.signal(sig, signal.SIG_DFL)
        except (OSError, ValueError):
            pass
        try:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, {sig})
        except (OSError, ValueError):
            pass
        os.kill(os.getpid(), sig)
        sys.exit(128 + sig)
    sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)

WATCH_GRACE = 10.0

def watch_grace(prof):
    """Seconds to wait for strace to end after the command did. The profile's test.graceMs may only lower it."""
    ms = prof["test"].get("graceMs")
    return WATCH_GRACE if ms is None else min(WATCH_GRACE, ms / 1000.0)

def proc_start(pid):
    """Start time (field 22 of /proc/<pid>/stat) and state, or None when the process is gone."""
    try:
        with open("/proc/%d/stat" % pid, "rb") as f:
            data = f.read().decode("utf-8", "replace")
        rest = data.rsplit(")", 1)[1].split()
        return rest[19], rest[0]
    except (OSError, IndexError):
        return None

def exe_of(pid):
    """The real path of a process's program; a program file replaced on disk reads '... (deleted)', which is dropped."""
    p = os.readlink("/proc/%d/exe" % pid)
    if p.endswith(" (deleted)"):
        p = p[:-len(" (deleted)")]
    return os.path.realpath(p)

class Strace:
    """Our strace process, found by its exact trace file name; pid plus start time so a reused pid never matches."""
    def __init__(self, trace_path, not_pid, sbin):
        self.trace_path = trace_path.encode("utf-8", "surrogateescape")
        self.not_pid = not_pid
        self.pid = None
        self.start = None
        self.tracee = "unknown"   # what from_tracee found: 'traced', 'untraced' or 'unknown'
        self.exe = os.path.realpath(sbin)
        self.py = os.path.realpath(sys.executable)

    def check(self, pid):
        """True (and remembered) when pid is our strace: its exe and its trace path, the same process before and after."""
        try:
            before = proc_start(pid)   # the start time is read before and after the checks: same process both times
            if not before:
                return False
            if exe_of(pid) != self.exe:
                return False
            with open("/proc/%d/cmdline" % pid, "rb") as f:
                args = f.read().split(b"\0")
            if self.trace_path not in args:
                return False
            after = proc_start(pid)
            if after and after[0] == before[0]:
                self.pid, self.start = pid, after[0]
                return True
        except (OSError, ValueError):
            pass
        return False

    def from_tracee(self, child, limit=2.0):
        """The cheap way: strace attaches to our child before the command starts, so the child's TracerPid names it.
        Returns 'traced' (our strace found), 'untraced' (the child runs the command and our strace is not its tracer: the
        attach failed) or 'unknown' (the child is gone, or the limit was reached). Right after the fork the child is
        still a copy of this helper (the interpreter) and then strace itself: both mean "not started yet"."""
        end = time.monotonic() + limit
        while time.monotonic() < end:
            try:
                with open("/proc/%d/status" % child, "rb") as f:
                    st = f.read()
            except OSError:
                return "unknown"
            tp = next((l for l in st.split(b"\n") if l.startswith(b"TracerPid:")), b"TracerPid:\t0")
            try:
                tracer = int(tp.split(b":")[1].strip() or b"0")
            except ValueError:
                return "unknown"
            if tracer and self.check(tracer):
                return "traced"
            state = next((l for l in st.split(b"\n") if l.startswith(b"State:")), b"")
            if b"Z" in state.split(b":")[-1][:3]:
                return "unknown"
            try:
                exe = exe_of(child)
            except OSError:
                return "unknown"
            if exe != self.exe and exe != self.py:
                return "untraced"   # the command runs and our strace is not tracing it
            time.sleep(0.0005)
        return "unknown"

    def scan(self):
        """The fallback: every process is looked at (only when the cheap way found nothing)."""
        if self.pid is not None:
            return True
        for name in os.listdir("/proc"):
            if not name.isdigit() or int(name) == self.not_pid:
                continue
            try:
                if exe_of(int(name)) != self.exe:
                    continue
            except OSError:
                continue
            if self.check(int(name)):
                return True
        return False

    def alive(self):
        if self.pid is None:
            return False
        st = proc_start(self.pid)
        return bool(st) and st[0] == self.start and st[1] not in ("Z", "X")

PUNCH_STEP = 1 << 20

def punch_hole(fd, upto, start=0):
    """Free the disk space of bytes [start, upto) of the file (size kept); True only when the call returned 0."""
    if upto <= start:
        return True
    try:
        fa = libc().fallocate
        fa.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int64, ctypes.c_int64]
        fa.restype = ctypes.c_int
        return fa(fd, 0x02 | 0x01, start, upto - start) == 0   # FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE
    except Exception:
        return False

def remove_dir(d):
    """Remove a watch folder: only the files we put there, then the folder; any failure is ignored."""
    for name in ("trace", "probe"):
        try:
            os.unlink(os.path.join(d, name))
        except OSError:
            pass
    try:
        os.rmdir(d)
    except OSError:
        pass

def punch_works(prof, d, tag):
    """Does hole punching work in folder d? tag: "default" or "shm" (only the test switch looks at it)."""
    sw = prof["test"].get("noPunch")
    if sw == "all" or (sw == "default" and tag == "default"):
        return False
    fd, p = None, os.path.join(d, "probe")
    try:
        fd = os.open(p, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
        os.write(fd, b"x" * 8192)
        return punch_hole(fd, 4096)
    except Exception:
        return False
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(p)
        except OSError:
            pass

def watch_parent(base):
    """The private folder that holds this user's trace folders under base (made 0700 when missing); None when it is
    not safe to use (not a real folder of ours, or open to others). Keeping every trace folder in it means the sweep of
    old ones lists one small folder, never a crowded /tmp."""
    p = os.path.join(base, "lockbox-watch-%d" % os.getuid())
    try:
        os.mkdir(p, 0o700)
    except FileExistsError:
        pass
    except OSError:
        return None
    try:
        st = os.lstat(p)
    except OSError:
        return None
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        return None
    return p

def make_trace_dir(base):
    parent = watch_parent(base)
    if parent:
        return tempfile.mkdtemp(prefix="w-", dir=parent)
    return tempfile.mkdtemp(prefix="lockbox-watch-", dir=base)

SHM_MIN_FREE = 256 << 20

def choose_trace_dir(prof):
    """The trace folder: in the default temp dir if hole punching works there, else in /dev/shm if it works there and has
    256 MiB free. With neither, nothing is left behind and OSError(ENOTSUP) is raised: a trace that cannot give back disk
    space is never run unbounded."""
    try:
        base = make_trace_dir(tempfile.gettempdir())   # a full or read-only temp dir falls through to /dev/shm
    except OSError:
        base = None
    if base and punch_works(prof, base, "default"):
        return base
    shm = None
    try:
        sv = os.statvfs("/dev/shm")
        if sv.f_bavail * sv.f_frsize >= SHM_MIN_FREE:
            shm = make_trace_dir("/dev/shm")
            if punch_works(prof, shm, "shm"):
                if base:
                    remove_dir(base)
                return shm
    except OSError:
        pass
    if shm:
        remove_dir(shm)
    if base:
        remove_dir(base)
    raise OSError(errno.ENOTSUP, "no trace folder here can give back disk space")

def sweep_old(prof):
    """Remove trace folders of ours, older than a day (the newest of the folder's and its trace file's mtime), that no
    live process names in its command line. A folder whose ctime is under 60 s old is never touched, so a clock jump
    cannot remove a new one. Only the private lockbox-watch-<uid> folders are listed (a crowded /tmp is never listed)."""
    now, uid, old = time.time(), os.getuid(), []
    ctime_grace = prof["test"].get("ctimeGraceMs", 60000) / 1000.0
    for base in {tempfile.gettempdir(), "/dev/shm"}:
        parent = os.path.join(base, "lockbox-watch-%d" % uid)
        try:
            st = os.lstat(parent)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_mode & 0o077:
                continue
            names = os.listdir(parent)
        except OSError:
            continue
        base = parent
        for n in names:
            if not n.startswith("w-"):
                continue
            p = os.path.join(base, n)
            try:
                st = os.lstat(p)
                if not (stat.S_ISDIR(st.st_mode) and st.st_uid == uid) or now - st.st_ctime < ctime_grace:
                    continue
                newest = st.st_mtime
                try:
                    newest = max(newest, os.lstat(os.path.join(p, "trace")).st_mtime)
                except OSError:
                    pass
                if now - newest > 86400:
                    old.append(p)
            except OSError:
                pass
    if not old:
        return
    cmdlines = []
    for name in os.listdir("/proc"):
        if name.isdigit():
            try:
                with open("/proc/%s/cmdline" % name, "rb") as f:
                    cmdlines.append(f.read())
            except OSError:
                pass
    for p in old:
        pb = p.encode("utf-8", "surrogateescape")
        if not any(pb in c for c in cmdlines):
            remove_dir(p)

def tail_trace(trace_path, judge, finish, now, state, start=0):
    """Feed the complete lines of the trace file to the judge. `finish`: read to the end of the file, then return;
    `now`: return after the line being judged. state["pos"] is the offset just past the last line that was judged."""
    fd = None
    while fd is None:
        for flags in (os.O_RDWR, os.O_RDONLY):   # read-write so judged parts can be given back to the disk
            try:
                fd = os.open(trace_path, flags | os.O_CLOEXEC)
                break
            except OSError:
                pass
        if fd is None:
            if finish.is_set() or now.is_set():
                return
            finish.wait(0.002)   # strace has not created the file yet (wakes at once when the command has ended)
    try:
        buf = b""             # bytes from state["pos"] on that are not judged yet
        read_at = start       # next byte to read
        cur = start           # offset just past the last judged line
        punched = start
        punched_al = start & ~4095
        state["pos"] = cur
        while True:
            final = finish.is_set()
            while True:
                if now.is_set():
                    return
                try:
                    chunk = os.pread(fd, 65536, read_at)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                read_at += len(chunk)
                buf += chunk
                i = 0
                while True:
                    j = buf.find(b"\n", i)
                    if j < 0:
                        break
                    try:
                        judge.feed(buf[i:j].decode("utf-8", "surrogateescape") + "\n")
                    except Exception:
                        pass
                    cur += j + 1 - i
                    i = j + 1
                    state["pos"] = cur   # moved only past a line that was judged
                    if now.is_set():
                        return
                buf = buf[i:]
                if cur - punched >= PUNCH_STEP:
                    ca = cur & ~4095
                    if punch_hole(fd, ca, punched_al):   # only the new range; a failed one is tried again next time
                        punched_al = ca
                    punched = cur
            if final:
                return
            finish.wait(0.05)
    finally:
        os.close(fd)

def list_tracees(spid):
    names = set()
    try:
        entries = os.listdir("/proc")
    except OSError:
        return 0, []
    count = 0
    for name in entries:
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/status" % name, "rb") as f:
                tp = next((l for l in f.read().split(b"\n") if l.startswith(b"TracerPid:")), b"")
            if tp.split(b":")[1].strip() != str(spid).encode():
                continue
            count += 1
            with open("/proc/%s/comm" % name, "rb") as f:
                names.add(f.read().decode("utf-8", "replace").strip())
        except (OSError, IndexError):
            continue
    return count, sorted(names)[:10]

def remove_trace(trace_path, tmpdir):
    for fn, p in ((os.unlink, trace_path), (os.rmdir, tmpdir)):
        try:
            fn(p)
        except OSError:
            pass

NOT_REVIEWED = "the job's command ended; these processes are still running; their later actions are not reviewed"

def continue_watching(prof, judge, trace_path, tmpdir, strace, count, start, gate, leftovers=True, logged=0, more0=0):
    """Runs in a detached child: reads the trace on from the cursor until strace is gone and the file is read to its end.
    The helper already logged judge.entries[:logged] and a 'more' count of more0: only what came after is written."""
    try:
        os.setsid()
        dn = os.open("/dev/null", os.O_RDWR)
        for i in (0, 1, 2):
            os.dup2(dn, i)
        try:
            os.read(gate, 1)   # the helper writes its own log lines first; this is released when it closes its end
        except OSError:
            pass
        close_inherited()
        for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(s, signal.SIG_DFL)
        finish, now = threading.Event(), threading.Event()
        # the helper's judge is kept as it is (its folders per process, its entries): the cap of log.max entries holds
        # for the whole command. What the helper already judged is not judged again: start where it stopped
        th = threading.Thread(target=tail_trace, args=(trace_path, judge, finish, now, {}, start), daemon=True)
        th.start()
        while strace.alive():
            time.sleep(0.2)
        finish.set()
        th.join()   # strace is gone, so the file is finite
        write_log(prof, list(judge.entries[logged:]), max(0, judge.more - more0))
        if leftovers:
            write_log(prof, [{"op": "watch", "path": "", "rule": "watch-leftovers-ended", "count": count}], 0)
        remove_trace(trace_path, tmpdir)
    except BaseException:
        pass
    finally:
        os._exit(0)

def run_unwatched(argv, env):
    sys.stdout.flush()
    restore_signals()
    try:
        os.execvpe(argv[0], argv, env)
    except OSError as ex:
        raise Fail("cannot run %s: %s" % (argv[0], errname(ex.errno)))

def run_watch(prof, argv):
    # Watch runs the command as today: today's environment, not the allow-list enforce would use (UV_USE_IO_URING=0
    # only keeps Node's file work visible to the trace).
    env = dict(os.environ)
    if prof["cwdFile"]:
        env["LOCKBOX_CWD_FILE"] = prof["cwdFile"]
    env["UV_USE_IO_URING"] = "0"
    fallback = False
    seccomp = strace_works(prof, True)
    if not seccomp:
        if strace_works(prof, False):
            fallback = True
        else:
            write_log(prof, [{"op": "watch", "path": "", "rule": "watch-unavailable"}], 0)
            run_unwatched(argv, env)
    if fallback:
        write_log(prof, [{"op": "watch", "path": "", "rule": "watch-fallback",
                          "reason": "seccomp-bpf tracing is not available here, so this job is watched in the slower mode"}], 0)
    target = {"pid": None, "pidfd": None}
    sigstate = {"hit": False}
    sigs = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)

    def forward(sig, _frame):
        sigstate["hit"] = True   # a cancel at any time also ends the grace wait
        try:
            if target["pidfd"] is not None:
                signal.pidfd_send_signal(target["pidfd"], sig)   # fails safely (ESRCH) once the child is reaped
            elif target["pid"]:
                os.kill(target["pid"], sig)                      # no pidfd: only while the child is not reaped
        except (OSError, AttributeError):
            pass

    # Watching must never fail the job: whatever goes wrong before the command started, it runs unwatched.
    tmpdir = trace_path = None
    try:
        judge = Judge(prof, os.getcwd())
        tmpdir = choose_trace_dir(prof)
        trace_path = os.path.join(tmpdir, "trace")
        # blocked from here to just after the fork: a cancel that arrives meanwhile waits and is then forwarded
        signal.pthread_sigmask(signal.SIG_BLOCK, sigs)
        for s in sigs:
            signal.signal(s, forward)
        # -DDD: strace in a session of its own, so a cancel that signals the command's process group cannot reach it
        # (with seccomp-bpf, strace ending ends everything it traces)
        sbin = trace_bin(prof)
        cmd = [sbin, "-DDD", "-I2"] + (["--seccomp-bpf"] if seccomp else []) + [
            "-f", "-qq", "-y", "-s", "4096", "-e", "signal=none", "-e", "trace=" + TRACE_SET, "-o", trace_path, "--"] + argv
        pid = os.fork()
    except Exception as ex:
        if tmpdir:
            remove_trace(trace_path, tmpdir)
        write_log(prof, [{"op": "watch", "path": "", "rule": "watch-failed",
                          "reason": "the watch could not be set up (%s), so this job ran unwatched" % type(ex).__name__}], 0)
        # a cancel must never be swallowed by our own handler: default actions back, then unblock (a cancel that is
        # already pending then ends the helper before the command runs, which is right)
        for s in sigs:
            try:
                signal.signal(s, signal.SIG_DFL)
            except Exception:
                pass
        try:
            signal.pthread_sigmask(signal.SIG_UNBLOCK, sigs)
        except Exception:
            pass
        run_unwatched(argv, env)   # clears the signal mask before exec
    if pid == 0:
        try:
            for s in sigs:
                signal.signal(s, signal.SIG_DFL)   # no handler of ours can run in the child
            restore_signals()                      # clears the mask
            os.execve(sbin, cmd, env)
        finally:
            os._exit(127)
    # From here on the command is running: nothing below may fail the job or start it again.
    pidfd = None
    try:
        pidfd = os.pidfd_open(pid)   # a zombie child still works
    except Exception:
        pidfd = None
    try:
        ms = prof["test"].get("pausePublishMs", 0)
        if ms > 0:
            time.sleep(ms / 1000.0)   # test-only: widens the window between the fork and the publishing, signals blocked
    except Exception:
        pass
    target["pidfd"], target["pid"] = pidfd, pid
    try:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, sigs)   # a signal that came meanwhile is delivered (forwarded) now
    except Exception:
        pass
    strace = reader = None
    finish, now = threading.Event(), threading.Event()
    state = {"pos": 0}
    try:
        strace = Strace(trace_path, pid, sbin)
        if not prof["test"].get("noReader"):   # test-only switch: the reader never starts
            reader = threading.Thread(target=tail_trace, args=(trace_path, judge, finish, now, state), daemon=True)
            reader.start()
    except Exception:
        reader = None
    try:
        if strace is not None:
            strace.tracee = strace.from_tracee(pid)
    except Exception:
        pass
    status = 1 << 8
    if pidfd is None:
        # without a pidfd: keep the ended child unreaped until forwarding by pid is switched off, so a reused pid is never hit
        try:
            os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
        except Exception:
            pass
        target["pid"] = None
    while True:
        try:
            _, status = os.waitpid(pid, 0)  # Python retries after a signal handler ran
            break
        except InterruptedError:
            continue
        except Exception:
            break
    target["pid"] = None            # the pid is reaped: never signal it again (the pidfd fails safely too)
    try:
        sweep_old(prof)   # old folders of earlier runs; after the command, so a huge temp dir never delays its start
    except Exception:
        pass
    try:
        if strace is None:
            raise RuntimeError("no strace lookup")
        watch_end(prof, judge, strace, finish, now, reader, trace_path, tmpdir, state, sigstate)
    except Exception:
        # whatever went wrong, the folder does not stay (unlinking is safe even while strace still writes)
        remove_trace(trace_path, tmpdir)
    target["pidfd"] = None
    if pidfd is not None:
        try:
            os.close(pidfd)
        except OSError:
            pass
    exit_like(status)

def watch_end(prof, judge, strace, finish, now, reader, trace_path, tmpdir, state, sigstate):
    # strace is found once, now that the command has ended: alive means leftovers keep it running (with -D the command
    # only starts after strace attached, so a strace that was there and has gone is simply finished)
    deadline = time.monotonic() + watch_grace(prof)
    strace.scan()
    t0 = time.monotonic()
    while strace.alive() and time.monotonic() < deadline and not sigstate["hit"]:
        # strace usually ends a few ms after the command: look often at first, so a normal command is not held up
        time.sleep(0.001 if time.monotonic() - t0 < 0.1 else 0.02)
    leftovers = strace.alive()
    # "watch-failed" only when sure: the child ran the command and our strace was never its tracer, and the scan found none
    failed = []
    if strace.tracee == "untraced" and strace.pid is None:
        failed = [{"op": "watch", "path": "", "rule": "watch-failed",
                   "reason": "strace could not attach (the job may already be traced), so this job ran unwatched"}]
    if not leftovers:
        # strace is gone: the reader reads the trace to its end
        finish.set()
        if reader is not None:
            reader.join(1.5)
        if reader is not None and not reader.is_alive():
            write_log(prof, list(judge.entries) + failed, judge.more)
            remove_trace(trace_path, tmpdir)
            return
    # Leftovers keep strace running, a backlog of lines is still being judged, or no reader ever started: the reader (if
    # any) stops after the current line (the cursor is exact) and a continuation reads on from there.
    now.set()
    if reader is not None:
        reader.join(1.0)
    reader_alive = reader is not None and reader.is_alive()
    entries = list(judge.entries)
    logged, more0 = len(entries), judge.more
    entries = entries + failed
    entry = None
    count = 0
    if leftovers:
        count, names = list_tracees(strace.pid)
        entry = {"op": "watch", "path": "", "rule": "watch-leftovers", "count": count, "names": names}

    def give_up():
        # nothing more can be reviewed: say what is known, free the files (strace, if still running, keeps its open file)
        if entry is not None:
            entry["note"] = NOT_REVIEWED
            write_log(prof, entries + [entry], more0)
        else:
            write_log(prof, entries + [{"op": "watch", "path": "", "rule": "watch-incomplete",
                                        "reason": "the end of the trace could not be reviewed in time"}], more0)
        remove_trace(trace_path, tmpdir)

    if reader_alive:
        give_up()   # forking while another thread may hold a lock could deadlock the child
        return
    sys.stdout.flush()
    sys.stderr.flush()
    r = w = None
    try:
        r, w = os.pipe()
        cpid = os.fork()
    except OSError:
        for fd in (r, w):
            if fd is not None:
                os.close(fd)
        give_up()
        return
    if cpid == 0:
        os.close(w)
        continue_watching(prof, judge, trace_path, tmpdir, strace, count, state["pos"], r, leftovers, logged, more0)
    os.close(r)
    if entry is not None:
        entry["note"] = "the job's command ended; these processes are still running and are still being watched until they end"
    try:
        write_log(prof, entries + ([entry] if entry is not None else []), more0)
    finally:
        os.close(w)   # releases the continuation

# ---------------------------------------------------------------- main
def parse_args(args):
    if "--" not in args:
        raise Fail("bad arguments")
    i = args.index("--")
    head, argv = args[:i], args[i + 1:]
    if len(head) != 2 or head[0] != "--profile-b64" or not argv or any("\0" in a for a in argv):
        raise Fail("bad arguments")
    try:
        prof = json.loads(base64.b64decode(head[1], validate=True).decode("utf-8"))
    except Exception:
        raise Fail("bad profile: not base64 JSON")
    return validate(prof), argv

def main():
    args = sys.argv[1:]
    if args == ["--probe"]:
        sys.stdout.write(json.dumps(probe()) + "\n")
        return 0
    try:
        prof, argv = parse_args(args)
        if prof["mode"] == "enforce":
            run_enforce(prof, argv)
        else:
            run_watch(prof, argv)
    except SystemExit:
        raise
    except BaseException as ex:
        reason = str(ex).replace("\n", " ")[:200] if isinstance(ex, Fail) else type(ex).__name__
        sys.stderr.write("lockbox: could not build the box (%s); the command was not run.\n" % reason)
        return 126
    return 0

if __name__ == "__main__":
    sys.exit(main())
