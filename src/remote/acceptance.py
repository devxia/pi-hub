"""Explicit live-host acceptance. Exercises the packaged supervisor; never manufactures passes.

Invoked only by `pi-hub-remote-acceptance --authorize-owned-resources` over the
same controlled SSH configuration as the product. All resources are under a
fresh private workspace/acceptance/<UUID>; no existing job/process is selected.
"""

import os, sys, json, time, subprocess, socket, hashlib, uuid, signal, fcntl, re


def ac_require(value, message):
    if not value:
        raise RuntimeError(message)


def ac_atomic(path, value):
    temporary = path + "." + uuid.uuid4().hex
    with open(temporary, "x") as file:
        os.chmod(temporary, 0o600)
        json.dump(value, file)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def ac_read(path, limit=131072):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        import stat

        source = os.fstat(file.fileno())
        ac_require(
            stat.S_ISREG(source.st_mode)
            and source.st_nlink == 1
            and source.st_size <= limit,
            "Unsafe or oversized evidence file",
        )
        data = file.read(limit + 1)
        ac_require(len(data) <= limit, "Evidence file grew beyond its limit")
        return json.loads(data)


def ac_evidence_digest(evidence):
    return hashlib.sha256(
        json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def ac_finish(bundle, evidence):
    ac_atomic(os.path.join(bundle, "evidence.json"), evidence)
    ac_atomic(
        os.path.join(bundle, "complete.json"),
        {
            "complete": evidence["complete"],
            "evidenceDigest": ac_evidence_digest(evidence),
        },
    )


def ac_wait(test, seconds=12):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        result = test()
        if result:
            return result
        time.sleep(0.05)
    raise RuntimeError("Acceptance deadline exceeded")


def ac_alive(identity):
    try:
        with open("/proc/" + str(identity["pid"]) + "/stat") as file:
            fields = file.read().rsplit(")", 1)[1].split()
        return fields[19] == identity["start"] and fields[0] != "Z"
    except (OSError, IndexError):
        return False


def ac_signal(identity, sig, group=False):
    if ac_alive(identity):
        if group:
            ac_require(
                os.getpgid(identity["pid"]) == identity["pid"], "Process group changed"
            )
            os.killpg(identity["pid"], sig)
        else:
            os.kill(identity["pid"], sig)


def ac_start(bundle, name, program):
    path = os.path.join(bundle, name)
    os.mkdir(path, 0o700)
    for directory in ("input", "output"):
        os.mkdir(os.path.join(path, directory), 0o700)
    identity = {"attemptId": str(uuid.uuid4()), "executionId": str(uuid.uuid4())}
    ac_atomic(os.path.join(path, "attempt.json"), identity)
    ac_atomic(
        os.path.join(path, "launch-intent.json"),
        {"argv": [sys.executable, "-c", program]},
    )
    lock = os.open(os.path.join(path, "launch.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    process = subprocess.Popen(
        [
            sys.executable,
            os.path.join(bundle, "supervisor.py"),
            "/proc/self/fd/" + str(descriptor),
            str(lock),
        ],
        pass_fds=(descriptor, lock),
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    os.close(lock)
    os.close(descriptor)
    ac_wait(
        lambda: os.path.exists(os.path.join(path, "receipt.json"))
        and ac_read(os.path.join(path, "receipt.json")).get("ref", {}).get("workload")
    )
    return path, process


def ac_cancel(path, force=False, request=None, override=None):
    controller = ac_read(os.path.join(path, "controller.json"))
    action = {
        **controller,
        "force": force,
        "operation": request or {"requestId": str(uuid.uuid4()), "digest": "a" * 64},
    }
    # controller.json has a live generation ref; workload is published before this request.
    receipt = ac_read(os.path.join(path, "receipt.json"))
    action["ref"] = receipt["ref"]
    if override:
        action.update(override)
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(3)
            connection.connect(f"/proc/self/fd/{fd}/control.sock")
            connection.sendall(json.dumps(action).encode() + b"\n")
            return json.loads(connection.recv(65536))
    finally:
        os.close(fd)


def ac_final(path):
    return ac_wait(
        lambda: (lambda result: result if result.get("scopeEnded") else None)(
            ac_read(os.path.join(path, "receipt.json"))
        )
    )


def ac_cleanup(bundle):
    records = []
    for name in os.listdir(bundle):
        path = os.path.join(bundle, name)
        if not os.path.isdir(path) or not os.path.exists(
            os.path.join(path, "controller.json")
        ):
            continue
        receipt = os.path.join(path, "receipt.json")
        controller = os.path.join(path, "controller.json")
        ref = ac_read(receipt if os.path.exists(receipt) else controller)["ref"]
        ac_signal(ref["helper"], signal.SIGKILL, True)
        # Leave the live supervisor time to adopt and reap the helper tree first.
        deadline = time.monotonic() + 3
        while ac_alive(ref["supervisor"]) and time.monotonic() < deadline:
            time.sleep(0.05)
        ac_signal(ref["supervisor"], signal.SIGKILL)
        deadline = time.monotonic() + 3
        while (
            ac_alive(ref["helper"])
            or ac_alive(ref["supervisor"])
            or (ref.get("workload") and ac_alive(ref["workload"]))
        ) and time.monotonic() < deadline:
            time.sleep(0.05)
        records.append(
            {
                "scenario": name,
                "supervisorAbsent": not ac_alive(ref["supervisor"]),
                "helperAbsent": not ac_alive(ref["helper"]),
                "workloadAbsent": bool(ref.get("workload"))
                and not ac_alive(ref["workload"]),
            }
        )
    return records


def ac_logind(*args):
    result = subprocess.run(
        ["loginctl", *args, "--no-pager"],
        capture_output=True,
        text=True,
        timeout=5,
        env={"PATH": "/usr/bin:/bin", "LANG": "C"},
    )
    ac_require(
        result.returncode == 0 and len(result.stdout) <= 16384,
        "Could not read logind session identity: " + result.stderr[:1000],
    )
    return result.stdout


def ac_sessions():
    rows = [
        line.split()
        for line in ac_logind("list-sessions", "--no-legend").splitlines()
        if line.strip()
    ]
    ac_require(
        all(len(row) >= 2 and row[1].isdigit() for row in rows),
        "Unrecognized logind session list",
    )
    return [row[0] for row in rows if int(row[1]) == os.getuid()]


def ac_ssh_session():
    import ctypes

    systemd = ctypes.CDLL("libsystemd.so.0")
    session = ctypes.c_char_p()
    status = systemd.sd_pid_get_session(os.getpid(), ctypes.byref(session))
    ac_require(
        status >= 0 and session.value, "This SSH connection has no logind session"
    )
    try:
        identity = session.value.decode()
    finally:
        ctypes.CDLL(None).free(session)
    keys = ("User", "Remote", "Service", "Scope")
    details = dict(
        line.split("=", 1)
        for line in ac_logind(
            "show-session", identity, *("--property=" + key for key in keys)
        ).splitlines()
        if "=" in line
    )
    ac_require(
        details.get("User") == str(os.getuid())
        and details.get("Remote") == "yes"
        and details.get("Service") == "sshd"
        and details.get("Scope"),
        "The acceptance SSH connection is not in an owned remote logind session",
    )
    return {"id": identity, **details}


def ac_linux(bundle, request):
    evidence = {"checks": {}, "scenarios": {}}
    processes = []
    try:
        path, process = ac_start(
            bundle,
            "natural",
            "import os,time; p=os.fork(); time.sleep(.4 if p==0 else .05); os._exit(0)",
        )
        processes.append(process)
        result = ac_final(path)
        evidence["scenarios"]["natural"] = result
        evidence["checks"]["reapersECHILD"] = (
            result.get("normalCompletion") is True
            and result["phase"] == "succeeded"
            and result["helperCompletion"].get("echild") is True
        )
        tree = "import os,time; p=os.fork(); time.sleep(120)"
        for name, force in (("termTree", False), ("killTree", True)):
            path, process = ac_start(bundle, name, tree)
            processes.append(process)
            response = ac_cancel(path, force)
            result = ac_final(path)
            evidence["scenarios"][name] = {"response": response, "receipt": result}
            evidence["checks"][name] = (
                result.get("scopeEnded") is True
                and not ac_alive(result["ref"]["workload"])
                and not ac_alive(result["ref"]["helper"])
                and result.get("actions")
                == [int(signal.SIGKILL if force else signal.SIGTERM)]
                and len(result.get("actionResults", [])) == 1
                and result["actionResults"][0].get("delivered") is True
                and result["actionResults"][0].get("endpoint")
                == result["ref"]["endpoint"]
                and result["actionResults"][0].get("pgid") == result["ref"]["pgid"]
            )
        # A stale endpoint/helper generation must not signal a newly identified object.
        path, process = ac_start(bundle, "staleIdentity", "import time;time.sleep(120)")
        processes.append(process)
        receipt = ac_read(os.path.join(path, "receipt.json"))
        stale = json.loads(json.dumps(receipt["ref"]))
        stale["helper"]["start"] = "0"
        rejected = ac_cancel(path, override={"ref": stale})
        stale_endpoint = json.loads(json.dumps(receipt["ref"]))
        stale_endpoint["endpoint"] = "expired-generation"
        rejected_endpoint = ac_cancel(path, override={"ref": stale_endpoint})
        untouched = ac_alive(receipt["ref"]["helper"]) and ac_alive(
            receipt["ref"]["workload"]
        )
        ac_cancel(path, True)
        ended = ac_final(path)
        evidence["scenarios"]["staleIdentity"] = {
            "refRejection": rejected,
            "endpointRejection": rejected_endpoint,
            "untouched": untouched,
            "receipt": ended,
        }
        evidence["checks"]["staleIdentity"] = (
            untouched
            and rejected.get("phase") == "unknown"
            and rejected_endpoint.get("phase") == "unknown"
        )
        # Helper loss after a zero main exit must never become success.
        path, process = ac_start(
            bundle,
            "helperLoss",
            "import os,time; p=os.fork(); time.sleep(120) if p==0 else os._exit(0)",
        )
        processes.append(process)
        ac_wait(lambda: os.path.exists(os.path.join(path, "main-exit.json")))
        ref = ac_read(os.path.join(path, "controller.json"))["ref"]
        ac_signal(ref["helper"], signal.SIGKILL, True)
        lost = ac_final(path)
        evidence["scenarios"]["helperLoss"] = lost
        evidence["checks"]["helperLossUnknown"] = (
            lost["phase"] == "unknown" and lost.get("normalCompletion") is False
        )
        # Real durable action, then duplicate while TERM-ignoring workload keeps gate open.
        path, process = ac_start(
            bundle,
            "crashNoReplay",
            "import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(120)",
        )
        processes.append(process)
        time.sleep(0.2)
        operation = {"requestId": str(uuid.uuid4()), "digest": "b" * 64}
        first = ac_cancel(path, request=operation)
        second = ac_cancel(path, request=operation)
        ref = ac_read(os.path.join(path, "controller.json"))["ref"]
        ac_signal(ref["supervisor"], signal.SIGKILL)
        process.wait(timeout=3)
        replay_record = ac_read(
            os.path.join(path, "action-" + operation["requestId"] + ".json")
        )
        evidence["scenarios"]["crashNoReplay"] = {
            "first": first,
            "duplicate": second,
            "durableAction": replay_record,
            "controllerEnded": not ac_alive(ref["supervisor"]),
        }
        evidence["checks"]["crashNoReplay"] = (
            first["phase"] == "cancelling"
            and second["phase"] == "unknown"
            and replay_record["operation"] == operation
            and os.path.exists(os.path.join(path, "launch-intent.json"))
        )
        ac_signal(ref["helper"], signal.SIGKILL, True)
        # Race real natural exit against a real control connection; no terminal attribution from delivery.
        outcomes = []
        for index in range(5):
            path, process = ac_start(
                bundle, "race-" + str(index), "import time;time.sleep(.08)"
            )
            processes.append(process)
            try:
                response = ac_cancel(path)
            except (OSError, ValueError):
                response = {"phase": "unknown"}
            outcomes.append({"response": response, "receipt": ac_final(path)})
        evidence["scenarios"]["mainExitRace"] = outcomes
        evidence["checks"]["mainExitRace"] = all(
            item["receipt"]["phase"] in ("succeeded", "failed", "unknown")
            and item["receipt"].get("scopeEnded") is True
            for item in outcomes
        )
        for process in processes:
            process.wait(timeout=3)
        window = request.get("logoutWindowSeconds")
        ac_require(
            isinstance(window, int) and 30 <= window <= 3600,
            "Explicit known-policy logout window (30–3600 seconds) required",
        )
        path, process = ac_start(
            bundle, "lastLogout", "import time;time.sleep(" + str(window + 180) + ")"
        )
        session = ac_ssh_session()
        baseline = ac_sessions()
        receipt = ac_read(os.path.join(path, "receipt.json"))
        evidence["scenarios"]["lastLogout"] = {
            "sshSession": session,
            "baselineSessions": baseline,
            "logindUser": ac_logind("show-user", str(os.getuid()), "--property=Linger"),
            "policyWindowSeconds": window,
            "initialReceipt": receipt,
        }
        evidence["checks"]["lastLogout"] = False
        ac_require(
            baseline == [session["id"]],
            "Start from the only login session for this test account",
        )
        ac_atomic(os.path.join(bundle, "evidence.json"), evidence)
        # Sampler deliberately survives this SSH command, then records an actual empty logind session list.
        sampler = subprocess.Popen(
            [sys.executable, __file__, "sample", bundle],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"pending": True, "samplerPid": sampler.pid, "quietSeconds": window + 55}
    except BaseException as error:
        evidence["error"] = str(error)
        evidence["cleanup"] = ac_cleanup(bundle)
        ac_atomic(os.path.join(bundle, "evidence.json"), evidence)
        return {"pending": False, "complete": False, "error": str(error)}


def ac_sample(bundle):
    evidence = ac_read(os.path.join(bundle, "evidence.json"), 6 * 1024 * 1024)
    baseline = evidence["scenarios"]["lastLogout"]
    ref = baseline["initialReceipt"]["ref"]
    observations = []
    window = baseline["policyWindowSeconds"]
    deadline = time.monotonic() + window + 30
    empty_since = None
    try:
        while time.monotonic() < deadline:
            time.sleep(2)
            sessions = ac_sessions()
            alive = {
                key: ac_alive(ref[key]) for key in ("supervisor", "helper", "workload")
            }
            observations.append(
                {"at": time.time(), "sessions": sessions, "alive": alive}
            )
            ac_require(
                all(alive.values()), "A measured execution identity ended during logout"
            )
            ac_require(
                not sessions
                or (empty_since is None and sessions == baseline["baselineSessions"]),
                "A different login session interrupted the logout observation",
            )
            if not sessions:
                empty_since = empty_since or time.monotonic()
                if time.monotonic() - empty_since >= window:
                    evidence["checks"]["lastLogout"] = True
                    break
    except BaseException as error:
        evidence["lastLogoutError"] = str(error)
    evidence["scenarios"]["lastLogout"]["observations"] = observations
    try:
        ac_cancel(os.path.join(bundle, "lastLogout"), True)
        evidence["scenarios"]["lastLogout"]["receipt"] = ac_final(
            os.path.join(bundle, "lastLogout")
        )
    except (OSError, ValueError, RuntimeError) as error:
        evidence["checks"]["lastLogout"] = False
        evidence["lastLogoutCleanupError"] = str(error)
    finally:
        evidence["cleanup"] = ac_cleanup(bundle)
        evidence["complete"] = all(
            evidence.get("checks", {}).get(k) is True
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
        ) and all(
            item["helperAbsent"] and item["supervisorAbsent"] and item["workloadAbsent"]
            for item in evidence["cleanup"]
        )
        ac_finish(bundle, evidence)


def ac_slurm(bundle, request):
    """Exercise the production argv against explicitly authorized, bounded jobs."""
    evidence = {"checks": {}, "commands": [], "submissions": []}
    mode = request.get("mode", "constraints")
    mismatch = request.get("mismatchCluster")
    owner = host()["user"]
    marker = "hub_accept_" + uuid.uuid4().hex
    owned = []

    def execute(argv):
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=12,
            env={"PATH": "/usr/bin:/bin", "LANG": "C", "HOME": bundle},
        )
        ac_require(
            len(result.stdout) <= 32768 and len(result.stderr) <= 8192,
            "Acceptance controller output limit",
        )
        entry = {
            "argv": argv,
            "code": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
        if len(evidence["commands"]) >= 100:
            raise RuntimeError("Acceptance controller observation limit")
        evidence["commands"].append(entry)
        ac_require(
            result.returncode == 0, "Controller command failed: " + result.stderr
        )
        return result.stdout

    def submit(cluster, name):
        item = {"cluster": cluster, "name": name, "startedAt": int(time.time())}
        evidence["submissions"].append(item)
        ac_atomic(os.path.join(bundle, "submissions.json"), evidence["submissions"])
        output = execute(
            [
                "sbatch",
                "--parsable",
                "--clusters=" + cluster,
                "--job-name=" + name,
                "--chdir=" + bundle,
                "--time=5",
                "--ntasks=1",
                "--cpus-per-task=1",
                "--output=" + os.path.join(bundle, name + ".out"),
                "--error=" + os.path.join(bundle, name + ".err"),
                "--wrap=exec /bin/sleep 180",
            ]
        ).strip()
        parts = output.split(";")
        ac_require(
            re.fullmatch(r"[1-9][0-9]*", parts[0])
            and (len(parts) == 1 or (len(parts) == 2 and parts[1] == cluster)),
            "Ambiguous sbatch receipt; do not resubmit",
        )
        item["jobId"] = parts[0]
        owned.append(item)
        ac_atomic(os.path.join(bundle, "submissions.json"), evidence["submissions"])
        return item

    def observe(item, source):
        prefix = ["--json", "--clusters=" + item["cluster"]]
        argv = (
            ["squeue", *prefix, "--me", "--name=" + item["name"]]
            if source == "active"
            else ["sacct", *prefix, "--duplicates", "--jobs=" + item["jobId"]]
        )
        jobs = json.loads(execute(argv))["jobs"]
        ac_require(
            isinstance(jobs, list) and len(jobs) <= 100,
            "Invalid acceptance observation",
        )
        candidates = []
        for job in jobs:
            ref = slurm_single_ref(job)
            if (
                ref
                and ref["jobId"] == item["jobId"]
                and ref["cluster"] == item["cluster"]
                and ref["name"] == item["name"]
                and ref["owner"] == owner
                and ref["directory"] == bundle
                and item["startedAt"] - 5
                <= int(ref["submittedAt"])
                <= item["startedAt"] + 60
            ):
                candidates.append((ref, slurm_state(job)))
        ac_require(len(candidates) <= 1, "Ambiguous acceptance execution")
        return candidates[0] if candidates else (None, None)

    def poll(test, duration=30):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            result = test()
            if result:
                return result
            time.sleep(2)
        raise RuntimeError("Controller did not report the expected execution state")

    def active(item, expected=None):
        ref, state = observe(item, "active")
        if expected:
            ac_require(
                slurm_exact(expected, ref)
                and state in ("RUNNING", "PENDING", "CONFIGURING"),
                "Negative check did not preserve the exact active job",
            )
        return ref if state in ("RUNNING", "PENDING", "CONFIGURING") else None

    def cancelled(item, expected):
        ref, state = observe(item, "accounting")
        if ref:
            ac_require(
                slurm_exact(expected, ref), "Accounting execution identity changed"
            )
        return (
            ref is not None
            and state == "CANCELLED"
            and observe(item, "active")[0] is None
        )

    def cancel(ref, **different):
        argv = slurm_cancel_argv({**ref, **different}, mode)
        # An arbitrary command failure cannot prove that the controller applied a filter.
        output = execute(argv)
        ac_require(
            not output.strip() and not evidence["commands"][-1]["stderr"].strip(),
            "Controller did not return a clean cancellation response",
        )

    try:
        ac_require(mode in ("constraints", "sluid"), "Unknown cancellation mode")
        controller = controller_identity(execute=execute)
        cluster = controller["cluster"]
        ac_require(
            isinstance(mismatch, str)
            and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", mismatch)
            and mismatch != cluster,
            "An explicitly authorized second cluster is required for clusterMismatch",
        )
        evidence["controller"] = controller
        evidence["mismatchController"] = controller_identity(mismatch, execute)
        first = submit(cluster, marker)
        second = submit(cluster, marker + "_other")
        witness = submit(mismatch, marker + "_witness")
        for item in (first, second, witness):
            item["ref"] = poll(lambda: active(item))
        primary, unrelated, remote = (item["ref"] for item in (first, second, witness))
        if mode == "sluid":
            ids = {ref["sluid"] for ref in (primary, unrelated, remote)}
            ac_require(
                len(ids) == 3
                and all(
                    re.fullmatch(r"[A-Za-z0-9_-]{8,128}", value or "") for value in ids
                ),
                "Controller does not expose distinct stable IDs",
            )
        cancel(primary, name=marker + "_wrong")
        evidence["checks"]["uniqueName"] = bool(active(first, primary))
        # Same controller and numeric ID scope, with a deliberately unrelated job/name pair.
        cancel(unrelated, name=marker)
        evidence["checks"]["jobIdReuse"] = bool(active(second, unrelated))
        wrong_owner = "root" if owner != "root" else "nobody"
        cancel(primary, owner=wrong_owner)
        evidence["checks"]["ownerMismatch"] = bool(active(first, primary))
        cancel(primary, cluster=mismatch)
        active(first, primary)
        active(witness, remote)
        cancel(remote)
        poll(lambda: cancelled(witness, remote))
        witness["cancelled"] = True
        evidence["checks"]["clusterMismatch"] = bool(active(first, primary))
        cancel(primary)
        poll(lambda: cancelled(first, primary))
        first["cancelled"] = True
        evidence["checks"]["controllerFilters"] = bool(active(second, unrelated))
        evidence["cancel"] = mode
        evidence["complete"] = all(evidence["checks"].values())
    except (
        OSError,
        ValueError,
        RuntimeError,
        TypeError,
        KeyError,
        subprocess.SubprocessError,
    ) as error:
        evidence["error"] = str(error)
    finally:
        cleanup = []
        for item in owned:
            outcome = {
                "jobId": item["jobId"],
                "cluster": item["cluster"],
                "verifiedTerminal": False,
            }
            try:
                if not item.get("cancelled"):
                    current, state = observe(item, "active")
                    known = item.get("ref")
                    if current:
                        ac_require(
                            not known or slurm_exact(known, current),
                            "Cleanup identity changed",
                        )
                        # Cleanup remains scoped to the exact owned test job. A stable
                        # ID cannot be used if this version never exposed it.
                        argv = slurm_cancel_argv(
                            current, mode if current["sluid"] else "constraints"
                        )
                        execute(argv)
                        known = current
                    ac_require(
                        known, "Cleanup could not recover a typed owned identity"
                    )
                    poll(lambda: cancelled(item, known))
                outcome["verifiedTerminal"] = True
            except (
                OSError,
                ValueError,
                RuntimeError,
                TypeError,
                KeyError,
                subprocess.SubprocessError,
            ) as error:
                outcome["error"] = str(error)
            cleanup.append(outcome)
        evidence["cleanup"] = cleanup
        evidence["complete"] = evidence.get("complete", False) and all(
            item["verifiedTerminal"] for item in cleanup
        )
        ac_finish(bundle, evidence)
    return {
        "pending": False,
        "token": os.path.basename(bundle),
        "complete": evidence["complete"],
    }


def acceptance_main(body):
    request = body["request"]
    ac_require(
        re.fullmatch(r"[a-f0-9]{64}", body.get("toolHash", "")),
        "Missing acceptance source binding",
    )
    rootfd = tf_root(body["root"], True)
    try:
        tf_private(rootfd)
        parent = tf_walk(rootfd, ["acceptance"], True)
        tf_private(parent)
        try:
            token = request.get("token", uuid.uuid4().hex)
            ac_require(
                len(token) == 32 and all(c in "0123456789abcdef" for c in token),
                "Invalid acceptance ticket",
            )
            if request["kind"] == "acceptanceStart":
                os.mkdir(token, 0o700, dir_fd=parent)
            bundlefd = tf_walk(parent, [token])
            tf_private(bundlefd)
            bundle = os.path.realpath("/proc/self/fd/" + str(bundlefd))
            try:
                if request["kind"] == "acceptanceStart":
                    for name, content in (
                        ("supervisor.py", body["supervisor"]),
                        ("acceptance.py", body["acceptance"]),
                    ):
                        with open(os.path.join(bundle, name), "x") as file:
                            os.chmod(file.name, 0o600)
                            file.write(content)
                    # __file__ is not defined in python -c; child executes the exact stored harness.
                    global __file__
                    __file__ = os.path.join(bundle, "acceptance.py")
                    ac_atomic(
                        os.path.join(bundle, "binding.json"),
                        {
                            "backend": request["backend"],
                            "host": host(),
                            "supervisorHash": hashlib.sha256(
                                body["supervisor"].encode()
                            ).hexdigest(),
                            "toolHash": body["toolHash"],
                            "startedAt": time.time(),
                        },
                    )
                    result = (
                        ac_linux(bundle, request)
                        if request["backend"] == "linux"
                        else ac_slurm(bundle, request)
                    )
                    return {**result, "token": token}
                if request["kind"] == "acceptanceStatus":
                    evidence = ac_read(
                        os.path.join(bundle, "evidence.json"), 6 * 1024 * 1024
                    )
                    completion = os.path.join(bundle, "complete.json")
                    complete = os.path.exists(completion) and ac_read(completion) == {
                        "complete": True,
                        "evidenceDigest": ac_evidence_digest(evidence),
                    }
                    return {"complete": complete, "evidence": evidence, "token": token}
                if request["kind"] == "acceptancePublish":
                    evidence = ac_read(
                        os.path.join(bundle, "evidence.json"), 6 * 1024 * 1024
                    )
                    binding = ac_read(os.path.join(bundle, "binding.json"))
                    h = host()
                    ac_require(
                        all(
                            binding["host"][k] == h[k]
                            for k in ("host", "user", "bootId")
                        )
                        and binding["supervisorHash"]
                        == hashlib.sha256(body["supervisor"].encode()).hexdigest()
                        and binding.get("toolHash") == body["toolHash"]
                        and 0 <= time.time() - binding["startedAt"] < 86400,
                        "Acceptance host boot or source changed",
                    )
                    backend = binding["backend"]
                    required = (
                        "lastLogout",
                        "termTree",
                        "killTree",
                        "reapersECHILD",
                        "crashNoReplay",
                        "mainExitRace",
                        "helperLossUnknown",
                        "staleIdentity",
                    )
                    required = (
                        required
                        if backend == "linux"
                        else (
                            "controllerFilters",
                            "jobIdReuse",
                            "ownerMismatch",
                            "clusterMismatch",
                            "uniqueName",
                        )
                    )
                    digest = ac_evidence_digest(evidence)
                    ac_require(
                        ac_read(os.path.join(bundle, "complete.json"))
                        == {
                            "complete": True,
                            "evidenceDigest": digest,
                        }
                        and evidence.get("complete") is True
                        and all(
                            evidence.get("checks", {}).get(key) is True
                            for key in required
                        ),
                        "Actual acceptance is incomplete; no verified receipt published",
                    )
                    receipt = {
                        "schema": 1,
                        **{key: h[key] for key in ("host", "user", "bootId")},
                        "supervisorHash": hashlib.sha256(
                            body["supervisor"].encode()
                        ).hexdigest(),
                        "toolHash": body["toolHash"],
                        "expiresAt": int(binding["startedAt"] * 1000) + 86400000,
                        "retention": "verified",
                        "checks": evidence["checks"],
                        "evidenceDigest": digest,
                        "evidenceFile": "acceptance/" + token + "/evidence.json",
                    }
                    if backend == "slurm":
                        receipt.pop("retention")
                        receipt.update(
                            cancel=evidence["cancel"],
                            controller=evidence["controller"],
                            controllerVersion=evidence["controller"]["version"],
                        )
                        ac_require(
                            controller_identity() == evidence["controller"],
                            "Controller changed during acceptance",
                        )
                    ac_atomic(
                        os.path.join(body["root"], backend + "-capability.json"),
                        receipt,
                    )
                    return receipt
                raise RuntimeError("Unsupported acceptance method")
            finally:
                os.close(bundlefd)
        finally:
            os.close(parent)
    finally:
        os.close(rootfd)


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "sample":
    ac_sample(sys.argv[2])
