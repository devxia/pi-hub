"""Bounded fixed RPC runner. No eval, shell command RPC, archive extraction or job replay."""

import os, sys, json, time, socket, hashlib, stat, subprocess, fcntl, re, uuid

MAX = 8 * 1024 * 1024


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sync_dir(path):
    match = re.fullmatch(r"/proc/self/fd/([0-9]+)", path)
    if match:
        require(int(match[1]) in DIRS, "Unowned directory descriptor")
        os.fsync(int(match[1]))
        return
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, value):
    tmp = path + "." + uuid.uuid4().hex + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    sync_dir(os.path.dirname(path))


# Retain every directory descriptor for this short-lived RPC. Linux /proc paths refer
# only to these owned descriptors; no user-controlled symlink is followed.
DIRS = []


def directory(path, create=False):
    require(
        os.path.isabs(path) and os.path.normpath(path) == path and path != "/",
        "Invalid workspace",
    )
    match = re.match(r"^/proc/self/fd/([0-9]+)(?:/|$)", path)
    if match:
        base = int(match[1])
        require(base in DIRS, "Unowned descriptor")
        fd = os.dup(base)
        parts = path[match.end() :].split("/") if path[match.end() :] else []
    else:
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        parts = path.split("/")[1:]
    try:
        for part in parts:
            require(part not in ("", ".", ".."), "Invalid directory component")
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=fd,
            )
            os.close(fd)
            fd = nxt
        DIRS.append(fd)
        return "/proc/self/fd/" + str(fd)
    except BaseException:
        os.close(fd)
        raise


def real_directory(path):
    # For scheduler-visible paths only. The canonical name must still identify
    # the directory held by this runner at the moment of submission.
    real = os.path.realpath(path)
    check = directory(real)
    require(
        os.stat(check).st_ino == os.stat(path).st_ino
        and os.stat(check).st_dev == os.stat(path).st_dev,
        "Workspace directory changed",
    )
    return real


def publish_stage(source, target):
    import ctypes

    libc = ctypes.CDLL(None, use_errno=True)
    require(hasattr(libc, "renameat2"), "Atomic no-replace publication unavailable")
    require(
        libc.renameat2(-100, source.encode(), -100, target.encode(), 1) == 0,
        "Attempt publication failed or already exists",
    )


def relative(path):
    require(
        isinstance(path, str)
        and len(path) < 1024
        and all(p not in ("", ".", "..") for p in path.split("/"))
        and not path.startswith("/")
        and "\\" not in path
        and "\0" not in path,
        "Unsafe relative path",
    )
    return path


def read_json(path, limit=131072):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        require(
            stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size <= limit,
            "Unsafe or oversized control file",
        )
        data = f.read(limit + 1)
        require(len(data) <= limit, "Control file grew beyond its limit")
        return json.loads(data)


def command(argv):
    import selectors

    p = subprocess.Popen(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "HOME": os.environ.get("HOME", "/")},
    )
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ, "out")
    sel.register(p.stderr, selectors.EVENT_READ, "err")
    out = bytearray()
    err = bytearray()
    deadline = time.monotonic() + 12
    try:
        while sel.get_map():
            require(time.monotonic() < deadline, "Remote controller deadline exceeded")
            for key, _ in sel.select(min(0.2, max(0, deadline - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    sel.unregister(key.fileobj)
                    continue
                target = out if key.data == "out" else err
                target.extend(data)
                require(
                    len(target) <= (2 * 1024 * 1024 if key.data == "out" else 8192),
                    "Controller output limit",
                )
        code = p.wait(timeout=max(0.1, deadline - time.monotonic()))
        require(
            code == 0, err.decode(errors="replace")[:1000] or "Remote command failed"
        )
        return out.decode()
    except BaseException:
        p.kill()
        p.wait()
        raise
    finally:
        sel.close()
        p.stdout.close()
        p.stderr.close()


def controller_identity(cluster=None, execute=None):
    # show config obtains the controller's configuration over RPC.
    execute = execute or command
    prefix = ["scontrol", "--clusters=" + cluster] if cluster else ["scontrol"]
    fields = {}
    for line in execute([*prefix, "show", "config"]).splitlines():
        match = re.match(
            r"^\s*(SLURM_VERSION|ClusterName|SlurmctldHost\[[0-9]+\])\s*=\s*(.+?)\s*$",
            line,
        )
        if match:
            require(match[1] not in fields, "Ambiguous controller configuration")
            fields[match[1]] = match[2]
    configured = {
        value.split("(", 1)[0].strip()
        for key, value in fields.items()
        if key.startswith("SlurmctldHost[")
    }
    live = set(
        re.findall(
            r"^\s*Slurmctld\([^\r\n)]+\) at (\S+) is UP\s*$",
            execute([*prefix, "ping"]),
            re.MULTILINE,
        )
    )
    require(
        re.fullmatch(
            r"[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9_.+-]*", fields.get("SLURM_VERSION", "")
        )
        and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", fields.get("ClusterName", ""))
        and (cluster is None or cluster == fields["ClusterName"])
        and live
        and live <= configured,
        "Controller configuration and live identity do not match",
    )
    return {
        "version": fields["SLURM_VERSION"],
        "cluster": fields["ClusterName"],
        "configurationDigest": hashlib.sha256(
            json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    }


def acceptance(root, h, supervisor_hash, tool_hash):
    h = dict(h)
    for backend in ("linux", "slurm"):
        try:
            e = read_json(os.path.join(root, backend + "-capability.json"))
            require(
                e.get("schema") == 1
                and all(e.get(k) == h[k] for k in ("host", "user", "bootId"))
                and e.get("expiresAt", 0) > time.time() * 1000
                and e.get("expiresAt", 0) <= time.time() * 1000 + 86400000
                and e.get("supervisorHash") == supervisor_hash
                and isinstance(tool_hash, str)
                and e.get("toolHash") == tool_hash
                and isinstance(e.get("evidenceDigest"), str)
                and re.fullmatch("[a-f0-9]{64}", e["evidenceDigest"]),
                "Capability acceptance binding expired or differs",
            )
            evidence = read_json(
                os.path.join(root, relative(e.get("evidenceFile", ""))), 6 * 1024 * 1024
            )
            require(
                hashlib.sha256(
                    json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest()
                == e["evidenceDigest"]
                and evidence.get("checks") == e.get("checks")
                and evidence.get("complete") is True,
                "Capability evidence missing or changed",
            )
            if backend == "linux":
                require(
                    e.get("retention") in ("verified", "forbidden"),
                    "Invalid retention decision",
                )
                if e["retention"] == "verified":
                    require(
                        all(
                            e.get("checks", {}).get(k) is True
                            for k in (
                                "lastLogout",
                                "termTree",
                                "killTree",
                                "reapersECHILD",
                                "crashNoReplay",
                                "mainExitRace",
                                "helperLossUnknown",
                                "staleIdentity",
                            )
                        ),
                        "Incomplete Linux acceptance",
                    )
                    import ctypes

                    libc = ctypes.CDLL(None, use_errno=True)
                    require(
                        hasattr(os, "waitid")
                        and hasattr(os, "WNOWAIT")
                        and libc.prctl(36, 1, 0, 0, 0) == 0,
                        "Linux subreaper/waitid unavailable",
                    )
                h["retention"] = e["retention"]
            else:
                require(
                    e.get("cancel") in ("sluid", "constraints")
                    and all(
                        e.get("checks", {}).get(k) is True
                        for k in (
                            "controllerFilters",
                            "jobIdReuse",
                            "ownerMismatch",
                            "clusterMismatch",
                            "uniqueName",
                        )
                    )
                    and e.get("cancel") == evidence.get("cancel"),
                    "Incomplete Slurm acceptance",
                )
                controller = controller_identity()
                require(
                    controller == e.get("controller") == evidence.get("controller")
                    and e.get("controllerVersion") == controller["version"],
                    "Controller identity changed",
                )
                h["cancel"] = e["cancel"]
                h["controller"] = controller
        except (
            OSError,
            ValueError,
            RuntimeError,
            TypeError,
            KeyError,
            subprocess.SubprocessError,
        ):
            pass
    h["reason"] = (
        "Host-bound acceptance is required for managed Linux launch and scheduler cancellation. Missing, expired or changed evidence keeps that action disabled."
    )
    return h


def host():
    return {
        "host": socket.gethostname(),
        "user": __import__("pwd").getpwuid(os.getuid()).pw_name,
        "bootId": open("/proc/sys/kernel/random/boot_id").read().strip(),
        "python": sys.version.split()[0],
        "observedAt": int(time.time() * 1000),
        "retention": "unverified",
        "cancel": "unverified",
        "reason": "Logout retention and controller cancellation need host-specific acceptance evidence.",
    }


def slurm_cancel_argv(ref, mode):
    require(mode in ("sluid", "constraints"), "Controller cancellation is unverified")
    target = ref.get("sluid", "") if mode == "sluid" else ref["jobId"]
    require(
        re.fullmatch(
            (
                r"[A-Za-z0-9_-]{8,128}"
                if mode == "sluid"
                else r"[0-9]+(?:_[0-9]+)?(?:\+[0-9]+)?"
            ),
            target,
        ),
        "Invalid controller execution ID",
    )
    return [
        "scancel",
        "--ctld",
        "--user=" + ref["owner"],
        "--clusters=" + ref["cluster"],
        "--name=" + ref["name"],
        target,
    ]


def slurm_records(queries):
    records, errors = [], []
    for source, argv in queries:
        try:
            jobs = json.loads(command(argv))["jobs"]
            require(
                isinstance(jobs, list) and len(jobs) <= 500, "Scheduler record limit"
            )
            require(
                all(isinstance(job, dict) for job in jobs), "Invalid scheduler records"
            )
            records.extend(dict(job, _source=source) for job in jobs)
        except (
            OSError,
            ValueError,
            RuntimeError,
            TypeError,
            KeyError,
            subprocess.SubprocessError,
        ) as error:
            errors.append(source + ": " + str(error))
    return records, errors


def slurm_scalar(value):
    if type(value) in (str, int):
        return str(value)
    if (
        not isinstance(value, dict)
        or value.get("set") is False
        or value.get("infinite") is True
    ):
        return None
    for key in ("number", "current", "name"):
        if key in value:
            return slurm_scalar(value[key])
    return None


def slurm_single_ref(job):
    """Typed identity for the single jobs emitted by the managed submitter."""
    array = job.get("array") or {}
    het = job.get("het") or job.get("heterogeneous") or {}
    if not isinstance(array, dict) or not isinstance(het, dict):
        return None
    for value in (
        array.get("job_id", job.get("array_job_id")),
        het.get("job_id", job.get("het_job_id")),
    ):
        if slurm_scalar(value) not in (None, "0", "4294967294", "4294967295"):
            return None
    if slurm_scalar(array.get("task_string", job.get("array_task_string"))):
        return None
    timing = job.get("time") or {}
    if not isinstance(timing, dict):
        return None
    ref = {
        "jobId": slurm_scalar(job.get("job_id")),
        "cluster": slurm_scalar(job.get("cluster")),
        "owner": slurm_scalar(job.get("user_name", job.get("user"))),
        "name": slurm_scalar(job.get("name")),
        "submittedAt": slurm_scalar(timing.get("submission", job.get("submit_time"))),
        "directory": slurm_scalar(job.get("working_directory", job.get("work_dir"))),
        "sluid": slurm_scalar(job.get("sluid")),
        "restart": slurm_scalar(
            job.get("restart_cnt", job.get("restart_count", job.get("restarts")))
        ),
        "databaseIndex": slurm_scalar(job.get("database_index", job.get("db_index"))),
    }
    if not re.fullmatch(r"[1-9][0-9]*", ref["jobId"] or "") or not re.fullmatch(
        r"[1-9][0-9]*", ref["submittedAt"] or ""
    ):
        return None
    if not all(ref[key] for key in ("cluster", "owner", "name")):
        return None
    return ref


def slurm_state(job):
    value = job.get("state", job.get("job_state"))
    if isinstance(value, dict):
        value = value.get("current")
    if isinstance(value, list):
        return slurm_scalar(value[0]) if len(value) == 1 else None
    value = slurm_scalar(value)
    return value.split()[0].rstrip("+") if value else None


def slurm_exact(expected, actual, require_known_generation=False):
    return (
        actual is not None
        and all(
            expected[key] == actual[key]
            for key in ("jobId", "cluster", "owner", "name", "submittedAt")
        )
        and all(
            expected.get(key) is None
            or (
                actual.get(key) is None
                and (not require_known_generation or key == "databaseIndex")
            )
            or str(expected[key]) == actual[key]
            for key in ("restart", "sluid", "databaseIndex")
        )
    )


def streams(path, r):
    result = {"logs": {}}
    retained = re.fullmatch(r"/proc/self/fd/([0-9]+)", path)
    require(retained and int(retained[1]) in DIRS, "Unowned attempt descriptor")
    output = tf_walk(int(retained[1]), ["output"])
    try:
        for name in ("stdout.log", "stderr.log"):
            try:
                fd = os.open(
                    name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=output
                )
            except FileNotFoundError:
                continue
            with os.fdopen(fd, "rb") as f:
                st = os.fstat(f.fileno())
                require(stat.S_ISREG(st.st_mode) and st.st_nlink == 1, "Unsafe log")
                identity = str(st.st_dev) + ":" + str(st.st_ino)
                cursor = r.get("logCursors", {}).get(name, {})
                offset = cursor.get("offset", 0)
                reset = (
                    cursor.get("identity") != identity
                    or not isinstance(offset, int)
                    or offset < 0
                    or offset > st.st_size
                )
                if not reset and offset:
                    f.seek(max(0, offset - 32))
                    reset = hashlib.sha256(
                        f.read(min(32, offset))
                    ).hexdigest() != cursor.get("preceding")
                if reset:
                    offset = max(0, st.st_size - 32768)
                f.seek(offset)
                data = f.read(32768)
                end = offset + len(data)
                f.seek(max(0, end - 32))
                preceding = hashlib.sha256(f.read(min(32, end))).hexdigest()
                result["logs"][name] = {
                    "text": data.decode(errors="replace"),
                    "reset": reset,
                    "cursor": {
                        "identity": identity,
                        "offset": end,
                        "preceding": preceding,
                    },
                }
        try:
            progress = relative(r.get("progressFile", "progress.json"))
            progress_parent = tf_walk(output, tf_parts(progress)[:-1])
            try:
                fd = os.open(
                    tf_parts(progress)[-1],
                    os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                    dir_fd=progress_parent,
                )
            finally:
                os.close(progress_parent)
            with os.fdopen(fd, "rb") as f:
                st = os.fstat(f.fileno())
                require(
                    stat.S_ISREG(st.st_mode)
                    and st.st_nlink == 1
                    and st.st_size <= 16384,
                    "Unsafe progress file",
                )
                result["progress"] = json.loads(f.read(16385))
                result["progressObservedAt"] = st.st_mtime_ns / 1000000
        except (FileNotFoundError, ValueError):
            pass
        return result
    finally:
        os.close(output)


def main(body):
    r = body["request"]
    kind = r["kind"]
    root = None
    if kind in ("acceptanceStart", "acceptanceStatus", "acceptancePublish"):
        return acceptance_main(body)
    if kind in ("uploadPrepare", "uploadCommit", "downloadPrepare", "transferRelease"):
        return transfer_main(body)
    if kind == "probe":
        h = host()
        candidate = body["root"]
        try:
            root = directory(candidate)
            require(
                os.stat(root).st_uid == os.getuid()
                and os.stat(root).st_mode & 0o077 == 0,
                "Existing workspace must be private and owned",
            )
        except FileNotFoundError:
            while True:
                candidate = os.path.dirname(candidate)
                try:
                    parent = directory(candidate)
                    break
                except FileNotFoundError:
                    continue
            require(
                os.access(parent, os.W_OK | os.X_OK), "Workspace parent is not writable"
            )
        h = (
            acceptance(
                root,
                h,
                hashlib.sha256(body["supervisor"].encode()).hexdigest(),
                body.get("toolHash"),
            )
            if root
            else h
        )
        import shutil

        stats = os.statvfs(root or parent)
        h["diagnostics"] = {
            "workspaceExists": root is not None,
            "freeBytes": stats.f_bavail * stats.f_frsize,
            "commands": {
                name: shutil.which(name)
                for name in (
                    "python3",
                    "sbatch",
                    "squeue",
                    "sacct",
                    "scancel",
                    "scontrol",
                )
            },
            "waitidWNOWAIT": hasattr(os, "waitid") and hasattr(os, "WNOWAIT"),
        }
        if r.get("backend") == "slurm":
            require(
                all(
                    h["diagnostics"]["commands"][name]
                    for name in ("sbatch", "squeue", "sacct", "scontrol")
                ),
                "Required Slurm commands are unavailable",
            )
            h["controller"] = h.get("controller") or controller_identity()
            require(
                "--json" in command(["squeue", "--help"])
                and "--json" in command(["sacct", "--help"])
                and "--parsable" in command(["sbatch", "--help"]),
                "Required Slurm structured output flags are unavailable",
            )
        h["supervisorHash"] = hashlib.sha256(body["supervisor"].encode()).hexdigest()
        return h
    if kind not in ("slurmQueue", "linuxQueue", "externalObserve"):
        root = directory(body["root"], kind == "stage")
        require(
            os.stat(root).st_uid == os.getuid() and os.stat(root).st_mode & 0o077 == 0,
            "Workspace must be private and owned by this user",
        )
    if kind == "slurmQueue":
        active = ["squeue", "--json", "--me"]
        queries = [("active", active)]
        if r.get("identifier"):
            job = r["identifier"]
            require(
                re.fullmatch(r"[0-9]+(?:_[0-9]+)?(?:\+[0-9]+)?", job), "Invalid JobID"
            )
            active.append("--jobs=" + job)
            queries.append(
                (
                    "accounting",
                    [
                        "sacct",
                        "--json",
                        "--duplicates",
                        "--user=" + host()["user"],
                        "--jobs=" + job,
                        "--starttime=1970-01-01",
                    ],
                )
            )
        jobs, errors = slurm_records(queries)
        require(len(errors) < len(queries), "; ".join(errors))
        return {
            "jobs": jobs,
            "observationErrors": errors,
            "observedAt": int(time.time() * 1000),
        }
    if kind == "linuxQueue":
        h = host()
        rows = []
        for pid in ([r["identifier"]] if r.get("identifier") else os.listdir("/proc")):
            if not pid.isdigit() or len(rows) >= 500:
                continue
            try:
                if os.stat("/proc/" + pid).st_uid != os.getuid():
                    continue
                with open("/proc/" + pid + "/stat") as f:
                    raw = f.read()
                rest = raw.rsplit(")", 1)[1].split()
                start = rest[19]
                rows.append(
                    {
                        "name": raw.split("(", 1)[1].rsplit(")", 1)[0][:120],
                        "phase": "running",
                        "ref": {
                            "kind": "linux-external",
                            "host": h["host"],
                            "user": h["user"],
                            "bootId": h["bootId"],
                            "pid": int(pid),
                            "start": start,
                            "pgid": int(rest[2]),
                        },
                    }
                )
            except (OSError, IndexError):
                continue
        return {"rows": rows, "observedAt": int(time.time() * 1000)}
    if kind == "externalObserve":
        ref = r["ref"]
        h = host()
        phase = "unknown"
        detail = "External execution is absent; completion is unknown."
        if ref["kind"] == "linux-external":
            require(
                all(ref.get(k) == h[k] for k in ("host", "user", "bootId")),
                "External host identity changed",
            )
            try:
                with open("/proc/" + str(int(ref["pid"])) + "/stat") as f:
                    proc = f.read().rsplit(")", 1)[1].split()
                require(
                    proc[19] == ref["start"]
                    and os.stat("/proc/" + str(ref["pid"])).st_uid == os.getuid(),
                    "External process identity changed",
                )
                if proc[0] != "Z":
                    phase = "running"
                    detail = "Read only process identity is present; no managed cancellation authority."
            except (OSError, RuntimeError, IndexError):
                pass
        else:
            require(
                ref["kind"] == "slurm"
                and re.fullmatch(r"[0-9]+(?:_[0-9]+)?(?:\+[0-9]+)?", ref["jobId"])
                and ref["owner"] == h["user"],
                "Invalid external scheduler reference",
            )
            require(
                re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", ref["cluster"]),
                "Invalid cluster",
            )
            cluster = "--clusters=" + ref["cluster"]
            records, errors = slurm_records(
                [
                    (
                        "active",
                        ["squeue", "--json", cluster, "--me", "--name=" + ref["name"]],
                    ),
                    (
                        "accounting",
                        [
                            "sacct",
                            "--json",
                            cluster,
                            "--duplicates",
                            "--jobs=" + ref["jobId"],
                        ],
                    ),
                ]
            )
        logs = r.get("logs", [])
        require(isinstance(logs, list) and len(logs) <= 2, "External log count limit")
        text = []
        for name in logs:
            require(
                isinstance(name, str) and os.path.isabs(name),
                "Explicit absolute external log required",
            )
            parent = directory(os.path.dirname(name))
            fd = os.open(
                os.path.join(parent, os.path.basename(name)),
                os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            )
            with os.fdopen(fd, "rb") as f:
                st = os.fstat(f.fileno())
                require(
                    stat.S_ISREG(st.st_mode)
                    and st.st_nlink == 1
                    and st.st_uid == os.getuid(),
                    "Unsafe external log",
                )
                f.seek(max(0, st.st_size - 16384))
                text.append(name + "\n" + f.read(16384).decode(errors="replace"))
        return {
            "phase": phase,
            "detail": detail,
            "log": "\n".join(text),
            "records": records if ref["kind"] == "slurm" else [],
            "activeUnavailable": ref["kind"] == "slurm"
            and any(error.startswith("active:") for error in errors),
        }
    aid = r.get("attemptId", "")
    require(
        re.fullmatch("[a-zA-Z0-9-]{1,128}", aid) is not None, "Invalid attempt identity"
    )
    attempts = directory(os.path.join(root, "attempts"), kind == "stage")
    path = os.path.join(attempts, aid)
    path = directory(path)
    identity = read_json(os.path.join(path, "attempt.json"))
    require(identity["executionId"] == r["executionId"], "Execution identity mismatch")
    if kind == "observe":
        receipt = os.path.join(path, "receipt.json")
        state = (
            read_json(receipt)
            if os.path.exists(receipt)
            else {
                "phase": "unknown",
                "detail": "No authoritative receipt; execution is not replayed.",
            }
        )
        if state.get("phase") in ("succeeded", "failed", "cancelled"):
            require(
                state.get("ref")
                and state.get("scopeEnded") is True
                and state.get("mainExit") is not None
                and state.get("normalCompletion") is True,
                "No authoritative scope completion identity",
            )
        if "ref" in state:
            require(
                state.get("executionId") == identity["executionId"]
                and state.get("attemptId") == identity["attemptId"],
                "Receipt execution binding mismatch",
            )
            if state.get("scopeEnded") is True:
                if state["phase"] in ("succeeded", "failed", "cancelled"):
                    require(
                        state.get("mainExit") is not None,
                        "No authoritative scope completion",
                    )
            else:
                h = host()
                ref = state["ref"]
                try:
                    require(
                        all(ref.get(k) == h[k] for k in ("host", "user", "bootId")),
                        "Host identity changed",
                    )
                    for key in ("supervisor", "helper"):
                        with open("/proc/" + str(ref[key]["pid"]) + "/stat") as f:
                            proc = f.read().rsplit(")", 1)[1].split()
                        require(
                            proc[19] == ref[key]["start"] and proc[0] != "Z",
                            "Controller identity ended",
                        )
                except (OSError, RuntimeError, IndexError):
                    state["phase"] = "unknown"
                    state["detail"] = (
                        "Controller identity is unavailable; no completion or replay can be inferred."
                    )
        if os.path.exists(os.path.join(path, "slurm.json")):
            state["ref"] = read_json(os.path.join(path, "slurm.json"))
        state.update(streams(path, r))
        return state
    if kind == "linuxLaunch":
        # Only a host-bound, separately accepted retention receipt can enable launch.
        h = acceptance(
            root,
            host(),
            hashlib.sha256(body["supervisor"].encode()).hexdigest(),
            body.get("toolHash"),
        )
        require(
            h["retention"] == "verified",
            "Linux logout retention is unverified for this host boot",
        )
        lock = os.open(
            os.path.join(path, "launch.lock"),
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
        fcntl.flock(lock, fcntl.LOCK_EX)
        require(
            not os.path.exists(os.path.join(path, "launch-intent.json")),
            "Launch intent already exists: reconcile, never relaunch",
        )
        atomic(
            os.path.join(path, "launch-intent.json"),
            {
                "executionId": r["executionId"],
                "operation": r["operation"],
                "inputDigest": identity.get("inputDigest"),
                "argv": r["argv"],
                "environment": r.get("environment", {}),
                "createdAt": time.time(),
            },
        )
        fd = os.open(
            os.path.join(path, "supervisor.py"),
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
        )
        with os.fdopen(fd, "rb") as f:
            st = os.fstat(f.fileno())
            require(
                stat.S_ISREG(st.st_mode)
                and st.st_nlink == 1
                and st.st_size <= 131072
                and hashlib.sha256(f.read(131073)).hexdigest()
                == hashlib.sha256(body["supervisor"].encode()).hexdigest(),
                "Installed supervisor integrity changed",
            )
        # The only creator transfers the held lock to the detached supervisor.
        p = subprocess.Popen(
            [sys.executable, os.path.join(path, "supervisor.py"), path, str(lock)],
            pass_fds=(lock, int(path.rsplit("/", 1)[1])),
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        os.close(lock)
        return {
            "phase": "unknown",
            "detail": "Launch intent published; awaiting supervisor receipt.",
        }
    if kind == "linuxCancel":
        endpoint = os.path.join(path, "control.sock")
        require(len(endpoint.encode()) < 104, "Control endpoint path too long")
        s = socket.socket(socket.AF_UNIX)
        s.settimeout(10)
        try:
            s.connect(endpoint)
            s.sendall(json.dumps(r).encode() + b"\n")
            data = s.recv(65536)
            return json.loads(data)
        finally:
            s.close()
    if kind == "slurmSubmit":
        lock = os.open(
            os.path.join(path, "launch.lock"),
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
        fcntl.flock(lock, fcntl.LOCK_EX)
        require(
            not os.path.exists(os.path.join(path, "launch-intent.json")),
            "Submission intent exists; recover without resubmission",
        )
        atomic(
            os.path.join(path, "launch-intent.json"),
            {
                "operation": r["operation"],
                "marker": identity["marker"],
                "inputDigest": identity.get("inputDigest"),
                "createdAt": time.time(),
            },
        )
        import shlex

        actual = real_directory(path)
        exports = "".join(
            "export " + key + "=" + shlex.quote(value) + "\n"
            for key, value in r.get("environment", {}).items()
        )
        resources = r.get("resources", {})
        flags = []
        for key, flag in {
            "partition": "partition",
            "account": "account",
            "qos": "qos",
            "minutes": "time",
            "memoryMB": "mem",
            "cpus": "cpus-per-task",
            "gpus": "gpus",
            "nodes": "nodes",
        }.items():
            if key in resources:
                flags.append("--" + flag + "=" + str(resources[key]))
        script = (
            "#!/bin/sh\n"
            + exports
            + "export PI_HUB_OUTPUT="
            + shlex.quote(os.path.join(actual, "output"))
            + "\nexec "
            + shlex.join(r["argv"])
            + "\n"
        )
        script_path = os.path.join(path, "job.sh")
        fd = os.open(
            script_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(fd, "w") as f:
            f.write(script)
            f.flush()
            os.fsync(f.fileno())
        accepted = command(
            [
                "sbatch",
                "--parsable",
                "--job-name=" + identity["marker"],
                "--chdir=" + os.path.join(actual, "input"),
                "--output=" + os.path.join(actual, "output", "stdout.log"),
                "--error=" + os.path.join(actual, "output", "stderr.log"),
                *flags,
                os.path.join(actual, "job.sh"),
            ]
        ).strip()
        require(
            re.fullmatch(r"[0-9]+(?:;[A-Za-z0-9_.-]+)?", accepted),
            "Unknown sbatch receipt",
        )
        parts = accepted.split(";")
        ref = {
            "kind": "slurm",
            "jobId": parts[0],
            "cluster": parts[1] if len(parts) > 1 else "",
            "owner": host()["user"],
            "submittedAt": "",
            "name": identity["marker"],
        }
        atomic(os.path.join(path, "slurm.json"), ref)
        return {
            "phase": "queued",
            "ref": ref,
            "detail": "Accepted by sbatch; controller identity must be reconciled before cancellation.",
        }
    if kind in ("slurmObserve", "slurmRecover"):
        records, errors = slurm_records(
            [
                (
                    "active",
                    ["squeue", "--json", "--me", "--name=" + identity["marker"]],
                ),
                (
                    "accounting",
                    [
                        "sacct",
                        "--json",
                        "--duplicates",
                        "--user=" + host()["user"],
                        "--starttime",
                        time.strftime(
                            "%Y-%m-%dT%H:%M:%S",
                            time.localtime(
                                identity.get("remoteCreatedAt", identity["createdAt"])
                                / 1000
                                - 60
                            ),
                        ),
                        "--name",
                        identity["marker"],
                    ],
                ),
            ]
        )
        return dict(
            records=records,
            activeUnavailable=any(error.startswith("active:") for error in errors),
            observationErrors=errors,
            remoteCreatedAt=identity.get("remoteCreatedAt"),
            **streams(path, r)
        )
    if kind == "slurmCancel":
        h = acceptance(
            root,
            host(),
            hashlib.sha256(body["supervisor"].encode()).hexdigest(),
            body.get("toolHash"),
        )
        ref = r["ref"]
        require(
            h["cancel"] in ("constraints", "sluid")
            and ref["name"] == identity["marker"]
            and ref["owner"] == h["user"]
            and ref["cluster"] == h["controller"]["cluster"]
            and re.fullmatch(r"[1-9][0-9]*", ref["jobId"])
            and re.fullmatch(r"[1-9][0-9]*", ref["submittedAt"]),
            "Cancellation scope mismatch",
        )
        op = r["operation"]
        require(
            re.fullmatch("[a-zA-Z0-9-]{1,128}", op["requestId"])
            and re.fullmatch("[0-9a-f]{64}", op["digest"]),
            "Invalid cancellation operation",
        )
        lock = os.open(
            os.path.join(path, "cancel.lock"),
            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
            0o600,
        )
        fcntl.flock(lock, fcntl.LOCK_EX)
        record = os.path.join(path, "action-" + op["requestId"] + ".json")
        if os.path.exists(record):
            require(read_json(record)["operation"] == op, "Request digest mismatch")
            return {
                "phase": "unknown",
                "detail": "Cancellation intent exists; controller action is never replayed.",
            }
        records, errors = slurm_records(
            [
                (
                    "active",
                    [
                        "squeue",
                        "--json",
                        "--me",
                        "--clusters=" + ref["cluster"],
                        "--name=" + ref["name"],
                    ],
                )
            ]
        )
        require(
            not errors and len(records) == 1, "No unique active cancellation identity"
        )
        observed = slurm_single_ref(records[0])
        require(
            slurm_exact(ref, observed, require_known_generation=True)
            and observed["directory"] == os.path.join(real_directory(path), "input")
            and slurm_state(records[0])
            in ("PENDING", "CONFIGURING", "RUNNING", "COMPLETING", "SUSPENDED"),
            "Active execution identity or generation changed",
        )
        argv = slurm_cancel_argv(observed, h["cancel"])
        atomic(
            record,
            {
                "operation": op,
                "executionId": r["executionId"],
                "ref": ref,
                "observation": observed,
                "createdAt": time.time(),
            },
        )
        command(argv)
        return {
            "phase": "cancelling",
            "detail": "Cancellation accepted; awaiting authoritative terminal state.",
        }
    raise RuntimeError("Unsupported runner method")


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(MAX + 1)
        require(len(raw) <= MAX, "Input limit")
        value = main(json.loads(raw))
        encoded = json.dumps({"ok": True, "value": value})
        require(len(encoded) <= MAX, "Output limit")
        print(encoded)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:2048]}))
        sys.exit(0)
