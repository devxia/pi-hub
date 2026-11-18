"""Linux foreground process scope. Helper identity stays unreaped until signal gate closes."""

import os, sys, json, time, signal, socket, select, ctypes, errno, uuid, re, stat


def atomic(path, value):
    tmp = path + "." + uuid.uuid4().hex
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    parent = os.path.dirname(path)
    match = re.fullmatch(r"/proc/self/fd/([0-9]+)", parent)
    fd = (
        os.dup(int(match[1]))
        if match
        else os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    )
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def load(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_size > 131072:
            raise RuntimeError("Unsafe controller record")
        return json.loads(f.read(131073))


def subreaper():
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "Subreaper unavailable")


def start(pid):
    with open("/proc/" + str(pid) + "/stat") as f:
        return f.read().rsplit(")", 1)[1].split()[19]


def drain():
    while True:
        try:
            os.waitpid(-1, 0)
        except InterruptedError:
            continue
        except ChildProcessError:
            return


def helper(path, argv, environment, ready, go, identity, endpoint):
    os.setsid()
    subreaper()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.write(ready, b"1")
    if os.read(go, 1) != b"1":
        os._exit(1)
    os.close(go)
    child = os.fork()
    if child == 0:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        os.chdir(os.path.join(path, "input"))
        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": os.environ.get("HOME", "/"),
            "LANG": "C.UTF-8",
            "PI_HUB_OUTPUT": os.path.join(os.path.realpath(path), "output"),
        }
        env.update(environment)
        out = os.open(
            os.path.join(path, "output", "stdout.log"),
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
            0o600,
        )
        err = os.open(
            os.path.join(path, "output", "stderr.log"),
            os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW,
            0o600,
        )
        os.dup2(out, 1)
        os.dup2(err, 2)
        os.close(ready)
        try:
            os.execvpe(argv[0], argv, env)
        except BaseException:
            os._exit(127)
    atomic(os.path.join(path, "workload.json"), {"pid": child, "start": start(child)})
    os.write(ready, b"2")
    os.close(ready)
    while True:
        try:
            _, status = os.waitpid(child, 0)
            break
        except InterruptedError:
            continue
    atomic(
        os.path.join(path, "main-exit.json"),
        {
            "attemptId": identity["attemptId"],
            "executionId": identity["executionId"],
            "endpoint": endpoint,
            "rawStatus": status,
            "code": os.waitstatus_to_exitcode(status),
            "observedAt": time.time(),
        },
    )
    drain()  # ECHILD, not a /proc children scan, proves the helper has reaped its scope.
    atomic(
        os.path.join(path, "helper-complete.json"),
        {
            "attemptId": identity["attemptId"],
            "executionId": identity["executionId"],
            "endpoint": endpoint,
            "pid": os.getpid(),
            "start": start(os.getpid()),
            "echild": True,
            "mainStatus": status,
        },
    )
    os._exit(0)


def main(path, lock):
    subreaper()
    intent = load(os.path.join(path, "launch-intent.json"))
    identity = load(os.path.join(path, "attempt.json"))
    endpoint = uuid.uuid4().hex
    read, write = os.pipe()
    go_read, go_write = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read)
        os.close(go_write)
        os.close(lock)
        helper(
            path,
            intent["argv"],
            intent.get("environment", {}),
            write,
            go_read,
            identity,
            endpoint,
        )
        os._exit(1)
    os.close(write)
    os.close(go_read)
    if os.read(read, 1) != b"1":
        raise RuntimeError("Helper failed before receipt")
    ref = {
        "kind": "linux",
        "host": __import__("socket").gethostname(),
        "user": __import__("pwd").getpwuid(os.getuid()).pw_name,
        "bootId": open("/proc/sys/kernel/random/boot_id").read().strip(),
        "supervisor": {"pid": os.getpid(), "start": start(os.getpid())},
        "helper": {"pid": child, "start": start(child)},
        "pgid": child,
        "endpoint": endpoint,
    }
    receipt = {
        "attemptId": identity["attemptId"],
        "executionId": identity["executionId"],
        "phase": "queued",
        "ref": ref,
        "detail": "Supervisor and private controller prepared; workload release pending.",
    }
    server = socket.socket(socket.AF_UNIX)
    server.bind(os.path.join(path, "control.sock"))
    os.chmod(os.path.join(path, "control.sock"), 0o600)
    server.listen(4)
    server.setblocking(False)
    atomic(
        os.path.join(path, "controller.json"),
        {
            "attemptId": identity["attemptId"],
            "executionId": identity["executionId"],
            "ref": ref,
        },
    )
    atomic(os.path.join(path, "receipt.json"), receipt)
    pidfd = os.pidfd_open(child, 0) if hasattr(os, "pidfd_open") else None
    # Durable controller identity and the bound private endpoint precede workload spawn.
    os.write(go_write, b"1")
    os.close(go_write)
    if os.read(read, 1) != b"2":
        raise RuntimeError("Workload handoff failed")
    os.close(read)
    ref["workload"] = load(os.path.join(path, "workload.json"))
    receipt.update(
        phase="running",
        ref=ref,
        detail="Foreground scope is running; completion requires both reapers to reach ECHILD.",
    )
    atomic(os.path.join(path, "receipt.json"), receipt)
    gate = True
    actions = []
    action_results = []
    try:
        while True:
            # WNOWAIT retains a zombie helper and prevents process/group identity reuse.
            terminal = os.waitid(os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            if terminal is not None:
                gate = False
                break
            ready, _, _ = select.select([server], [], [], 0.1)
            if not ready:
                continue
            conn, _ = server.accept()
            conn.settimeout(2)
            try:
                data = b""
                while b"\n" not in data and len(data) <= 65536:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    data += chunk
                if len(data) > 65536:
                    raise RuntimeError("Control input limit")
                r = json.loads(data)
                op = r["operation"]
                if (
                    r.get("executionId") != identity["executionId"]
                    or r.get("attemptId") != identity["attemptId"]
                    or r.get("ref") != ref
                    or not re.fullmatch("[a-zA-Z0-9-]{1,128}", op["requestId"])
                    or not re.fullmatch("[0-9a-f]{64}", op["digest"])
                ):
                    raise RuntimeError("Control identity mismatch")
                record = os.path.join(path, "action-" + op["requestId"] + ".json")
                if os.path.exists(record):
                    old = load(record)
                    if old["operation"] != op:
                        raise RuntimeError("Request digest mismatch")
                    result = {
                        "phase": "unknown",
                        "detail": "Action intent already exists; signal is never replayed.",
                    }
                else:
                    if (
                        not gate
                        or os.waitid(
                            os.P_PID, child, os.WEXITED | os.WNOHANG | os.WNOWAIT
                        )
                        is not None
                    ):
                        raise RuntimeError("Scope ended before cancellation")
                    if (
                        start(child) != ref["helper"]["start"]
                        or os.getpgid(child) != child
                    ):
                        raise RuntimeError("Helper identity changed")
                    sig = signal.SIGKILL if r.get("force") is True else signal.SIGTERM
                    atomic(
                        record,
                        {
                            "operation": op,
                            "signal": sig,
                            "executionId": identity["executionId"],
                            "endpoint": endpoint,
                            "createdAt": time.time(),
                        },
                    )
                    # The durable intent precedes the only signal. No replay after any crash.
                    delivery = {
                        "operation": op,
                        "attemptId": identity["attemptId"],
                        "executionId": identity["executionId"],
                        "endpoint": endpoint,
                        "pgid": child,
                        "signal": int(sig),
                        "reportedAt": time.time(),
                    }
                    try:
                        os.killpg(child, sig)
                    except OSError as error:
                        atomic(
                            record + ".result",
                            dict(delivery, delivered=False, errno=error.errno),
                        )
                        raise
                    actions.append(sig)
                    if sig == signal.SIGKILL:
                        gate = False
                    delivery["delivered"] = True
                    action_results.append(delivery)
                    atomic(record + ".result", delivery)
                    result = {
                        "attemptId": identity["attemptId"],
                        "executionId": identity["executionId"],
                        "phase": "cancelling",
                        "ref": ref,
                        "detail": "Signal dispatched; waiting for ECHILD. Cancellation cause is not inferred from signal delivery.",
                    }
                    atomic(os.path.join(path, "receipt.json"), result)
                conn.sendall(json.dumps(result).encode())
            except BaseException as e:
                try:
                    conn.sendall(
                        json.dumps(
                            {"phase": "unknown", "detail": str(e)[:1024]}
                        ).encode()
                    )
                except OSError:
                    pass
            finally:
                conn.close()
        gate = False
        _, helper_status = os.waitpid(child, 0)
        drain()  # supervisor reaps helper plus adopted descendants to ECHILD.
        main_path = os.path.join(path, "main-exit.json")
        exit = load(main_path) if os.path.exists(main_path) else None
        complete_path = os.path.join(path, "helper-complete.json")
        complete = load(complete_path) if os.path.exists(complete_path) else None
        normal = (
            os.WIFEXITED(helper_status)
            and os.WEXITSTATUS(helper_status) == 0
            and complete
            and exit
            and all(
                complete.get(k) == identity[k] and exit.get(k) == identity[k]
                for k in ("attemptId", "executionId")
            )
            and complete.get("endpoint") == endpoint
            and exit.get("endpoint") == endpoint
            and complete.get("pid") == child
            and complete.get("start") == ref["helper"]["start"]
            and complete.get("echild") is True
            and complete.get("mainStatus") == exit.get("rawStatus")
        )
        phase = (
            (
                "succeeded"
                if exit["code"] == 0
                else ("unknown" if exit["code"] < 0 and actions else "failed")
            )
            if normal
            else "unknown"
        )
        atomic(
            os.path.join(path, "receipt.json"),
            {
                "attemptId": identity["attemptId"],
                "executionId": identity["executionId"],
                "phase": phase,
                "ref": ref,
                "scopeEnded": True,
                "mainExit": exit,
                "helperStatus": helper_status,
                "helperCompletion": complete,
                "normalCompletion": bool(normal),
                "actions": actions,
                "actionResults": action_results,
                "detail": "Scope ended after supervisor ECHILD; "
                + (
                    "normal helper ECHILD completion verified."
                    if normal
                    else "unexpected helper exit: success/cancellation cause is unknown."
                ),
            },
        )
    finally:
        server.close()
        if pidfd is not None:
            os.close(pidfd)
        os.close(lock)


if __name__ == "__main__":
    try:
        main(sys.argv[1], int(sys.argv[2]))
    except BaseException:
        sys.exit(
            1
        )  # Missing final receipt remains unknown. Never restart an existing intent.
