"""Descriptor-bound disk snapshots. SFTP sees numbered immutable objects only."""

import os, stat, json, hashlib, uuid, time, ctypes, sys

TRANSFER_FILES = 10000
TRANSFER_BYTES = 1024**4


def tf_require(value, message):
    if not value:
        raise RuntimeError(message)


def tf_parts(path, absolute=False):
    tf_require(
        isinstance(path, str)
        and len(path) < 4096
        and "\\" not in path
        and "\0" not in path,
        "Unsafe transfer path",
    )
    tf_require(path.startswith("/") == absolute, "Unexpected transfer path kind")
    parts = path.split("/")[1:] if absolute else path.split("/")
    tf_require(
        all(p not in ("", ".", "..") for p in parts), "Unsafe transfer component"
    )
    return parts


def tf_walk(base, parts, create=False):
    fd = os.dup(base)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def tf_root(path, create=False):
    base = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        return tf_walk(base, tf_parts(path, True), create)
    finally:
        os.close(base)


def tf_stamp(st):
    return (
        st.st_dev,
        st.st_ino,
        st.st_mode,
        st.st_nlink,
        st.st_size,
        st.st_mtime_ns,
        st.st_ctime_ns,
    )


def tf_recheck(root_path, root, parts=None, retained=None):
    current = tf_root(root_path)
    try:
        tf_require(
            tf_stamp(os.fstat(current))[:2] == tf_stamp(os.fstat(root))[:2],
            "Remote workspace replaced",
        )
        if parts is not None:
            child = tf_walk(current, parts)
            try:
                tf_require(
                    tf_stamp(os.fstat(child))[:2] == tf_stamp(os.fstat(retained))[:2],
                    "Remote parent directory replaced",
                )
            finally:
                os.close(child)
    finally:
        os.close(current)


def tf_json(fd, name, value=None):
    if value is not None:
        target = os.open(
            name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd
        )
        with os.fdopen(target, "w") as f:
            json.dump(value, f)
            f.flush()
            os.fsync(f.fileno())
        os.fsync(fd)
    else:
        target = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(target, "rb") as f:
            st = os.fstat(f.fileno())
            tf_require(
                stat.S_ISREG(st.st_mode)
                and st.st_nlink == 1
                and st.st_size <= 8 * 1024 * 1024,
                "Unsafe transfer metadata",
            )
            return json.load(f)


def tf_private(fd):
    st = os.fstat(fd)
    tf_require(
        st.st_uid == os.getuid() and st.st_mode & 0o077 == 0,
        "Transfer workspace must be private and owned",
    )


def tf_ticket(root, token):
    tf_require(
        isinstance(token, str)
        and len(token) == 32
        and all(c in "0123456789abcdef" for c in token),
        "Invalid transfer ticket",
    )
    base = tf_root(root)
    try:
        tf_private(base)
        fd = tf_walk(base, [".transfers", token])
        tf_private(fd)
        return fd
    finally:
        os.close(base)


def tf_copy(source, path, destination, target):
    parts = tf_parts(path)
    parent = tf_walk(source, parts[:-1])
    try:
        fd = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent
        )
        with os.fdopen(fd, "rb") as src:
            before = os.fstat(src.fileno())
            tf_require(
                stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                "Only regular unlinked transfer files",
            )
            out = os.open(
                target,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=destination,
            )
            sha = hashlib.sha256()
            size = 0
            with os.fdopen(out, "wb") as dst:
                while True:
                    data = src.read(262144)
                    if not data:
                        break
                    size += len(data)
                    tf_require(
                        size <= before.st_size and size <= TRANSFER_BYTES,
                        "Transfer file grew or exceeds 1 TiB",
                    )
                    sha.update(data)
                    dst.write(data)
                dst.flush()
                os.fsync(dst.fileno())
            tf_require(
                size == before.st_size
                and tf_stamp(os.fstat(src.fileno())) == tf_stamp(before),
                "Transfer source changed while copying",
            )
            tf_require(
                tf_stamp(os.stat(parts[-1], dir_fd=parent, follow_symlinks=False))
                == tf_stamp(before),
                "Transfer source name changed",
            )
            current = tf_walk(source, parts[:-1])
            try:
                tf_require(
                    tf_stamp(os.fstat(current))[:2] == tf_stamp(os.fstat(parent))[:2],
                    "Transfer source parent changed",
                )
            finally:
                os.close(current)
            return {"size": size, "sha256": sha.hexdigest()}
    finally:
        os.close(parent)


def tf_hash(fd, name):
    src = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    with os.fdopen(src, "rb") as f:
        before = os.fstat(f.fileno())
        tf_require(
            stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "Unsafe SFTP object"
        )
        sha = hashlib.sha256()
        size = 0
        while True:
            data = f.read(262144)
            if not data:
                break
            size += len(data)
            tf_require(
                size <= before.st_size and size <= TRANSFER_BYTES,
                "SFTP object changed size",
            )
            sha.update(data)
        tf_require(
            size == before.st_size
            and tf_stamp(os.fstat(f.fileno())) == tf_stamp(before),
            "SFTP object changed during verification",
        )
        return {"size": size, "sha256": sha.hexdigest()}


def tf_manifest(files, directories):
    tf_require(
        isinstance(files, list)
        and isinstance(directories, list)
        and len(files) + len(directories) <= TRANSFER_FILES,
        "Transfer manifest limit",
    )
    paths, objects = set(), set()
    total = 0
    for item in files:
        tf_parts(item["path"])
        obj = item["object"]
        tf_require(
            isinstance(obj, str)
            and len(obj) == 8
            and obj.isdigit()
            and obj not in objects
            and item["path"] not in paths,
            "Duplicate transfer entry",
        )
        tf_require(
            isinstance(item["size"], int)
            and item["size"] >= 0
            and isinstance(item["sha256"], str)
            and len(item["sha256"]) == 64
            and all(c in "0123456789abcdef" for c in item["sha256"]),
            "Invalid transfer digest",
        )
        total += item["size"]
        tf_require(total <= TRANSFER_BYTES, "Transfer exceeds 1 TiB")
        paths.add(item["path"])
        objects.add(obj)
    for path in directories:
        tf_parts(path)
        tf_require(path not in paths, "File/directory collision")
    return total


def tf_enumerate(fd, selections):
    files, dirs = set(), set()

    def visit(path):
        parts = tf_parts(path)
        parent = tf_walk(fd, parts[:-1])
        try:
            st = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                sub = os.open(
                    parts[-1],
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                    dir_fd=parent,
                )
                try:
                    dirs.add(path)
                    before = tf_stamp(os.fstat(sub))
                    for name in sorted(os.listdir(sub)):
                        visit(path + "/" + name)
                    tf_require(
                        tf_stamp(os.fstat(sub)) == before,
                        "Result directory changed during enumeration",
                    )
                finally:
                    os.close(sub)
            else:
                tf_require(
                    stat.S_ISREG(st.st_mode) and st.st_nlink == 1,
                    "Result symlinks and special files are forbidden",
                )
                files.add(path)
            tf_require(
                len(files) + len(dirs) <= TRANSFER_FILES, "Result manifest limit"
            )
        finally:
            os.close(parent)

    for selection in selections:
        visit(selection)
    return sorted(files), sorted(dirs)


def tf_publish(parent, source, target):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        result = libc.renameatx_np(parent, source.encode(), parent, target.encode(), 4)
    else:
        tf_require(hasattr(libc, "renameat2"), "Atomic no-replace unavailable")
        result = libc.renameat2(parent, source.encode(), parent, target.encode(), 1)
    tf_require(result == 0, "Attempt already exists or atomic publication failed")
    os.fsync(parent)


def tf_discard(parent, name, owned):
    """Remove an unpublished directory through its retained descriptor only."""
    tf_private(owned)
    expected = tf_stamp(os.fstat(owned))[:2]
    tf_require(
        tf_stamp(os.stat(name, dir_fd=parent, follow_symlinks=False))[:2] == expected,
        "Unpublished transfer directory replaced",
    )
    for entry in os.listdir(owned):
        st = os.stat(entry, dir_fd=owned, follow_symlinks=False)
        if stat.S_ISDIR(st.st_mode):
            child = tf_walk(owned, [entry])
            try:
                tf_require(
                    tf_stamp(os.fstat(child))[:2] == tf_stamp(st)[:2],
                    "Unpublished transfer directory changed",
                )
                tf_discard(owned, entry, child)
            finally:
                os.close(child)
        else:
            tf_require(
                stat.S_ISREG(st.st_mode) and st.st_nlink == 1,
                "Unexpected unpublished transfer object",
            )
            os.unlink(entry, dir_fd=owned)
    tf_require(
        tf_stamp(os.stat(name, dir_fd=parent, follow_symlinks=False))[:2] == expected,
        "Unpublished transfer directory replaced",
    )
    os.rmdir(name, dir_fd=parent)
    os.fsync(parent)


def transfer_main(body):
    r = body["request"]
    kind = r["kind"]
    root_path = body["root"]
    root = tf_root(root_path, kind == "uploadPrepare")
    try:
        tf_private(root)
        if kind in ("uploadPrepare", "downloadPrepare"):
            transfers = tf_walk(root, [".transfers"], True)
            token = uuid.uuid4().hex
            try:
                os.mkdir(token, 0o700, dir_fd=transfers)
                ticket = tf_walk(transfers, [token])
            except BaseException:
                os.close(transfers)
                raise
            try:
                if kind == "uploadPrepare":
                    total = tf_manifest(r["manifest"], r.get("directories", []))
                    meta = dict(
                        r, mode="upload", totalBytes=total, createdAt=time.time()
                    )
                else:
                    tf_require(
                        r["attemptId"].replace("-", "").isalnum(), "Invalid attempt ID"
                    )
                    attempt = tf_walk(root, ["attempts", r["attemptId"]])
                    try:
                        identity = tf_json(attempt, "attempt.json")
                        tf_require(
                            identity["executionId"] == r["executionId"],
                            "Result execution identity changed",
                        )
                        output = tf_walk(attempt, ["output"])
                        try:
                            names, directories = tf_enumerate(output, r["paths"])
                            files, total = [], 0
                            for name in names:
                                obj = str(len(files)).zfill(8)
                                actual = tf_copy(output, name, ticket, obj)
                                total += actual["size"]
                                tf_require(
                                    total <= TRANSFER_BYTES,
                                    "Result transfer exceeds 1 TiB",
                                )
                                files.append(dict(actual, path=name, object=obj))
                            tf_recheck(
                                root_path,
                                root,
                                ["attempts", r["attemptId"], "output"],
                                output,
                            )
                            tf_require(
                                tf_json(attempt, "attempt.json") == identity,
                                "Attempt identity changed during snapshot",
                            )
                            tf_require(
                                tf_enumerate(output, r["paths"])
                                == (names, directories),
                                "Results changed during snapshot",
                            )
                        finally:
                            os.close(output)
                    finally:
                        os.close(attempt)
                    meta = dict(
                        mode="download",
                        manifest=files,
                        directories=directories,
                        totalBytes=total,
                        createdAt=time.time(),
                    )
                meta["rootIdentity"] = tf_stamp(os.fstat(root))[:2]
                tf_recheck(root_path, root, [".transfers", token], ticket)
                tf_json(ticket, "ticket.json", meta)
                return {
                    "token": token,
                    "files": meta["manifest"],
                    "directories": meta.get("directories", []),
                    "totalBytes": meta["totalBytes"],
                }
            except Exception as error:
                try:
                    tf_discard(transfers, token, ticket)
                except (OSError, RuntimeError) as cleanup:
                    raise RuntimeError(
                        f"{error}; unpublished ticket retained: {cleanup}"
                    ) from error
                raise
            finally:
                os.close(ticket)
                os.close(transfers)
        ticket = tf_ticket(root_path, r["token"])
        try:
            meta = tf_json(ticket, "ticket.json")
            tf_require(
                meta.get("rootIdentity") == list(tf_stamp(os.fstat(root))[:2]),
                "Transfer workspace identity changed",
            )
            tf_require(
                kind == "transferRelease" or time.time() - meta["createdAt"] < 86400,
                "Transfer ticket expired",
            )
            if kind == "uploadCommit":
                tf_require(meta["mode"] == "upload", "Wrong ticket mode")
                aid = meta["attemptId"]
                tf_require(aid.replace("-", "").isalnum(), "Invalid attempt identity")
                attempts = tf_walk(root, ["attempts"], True)
                stage_name = ".stage-" + r["token"]
                try:
                    os.mkdir(stage_name, 0o700, dir_fd=attempts)
                    stage = tf_walk(attempts, [stage_name])
                except BaseException:
                    os.close(attempts)
                    raise
                try:
                    input_fd = tf_walk(stage, ["input"], True)
                    try:
                        for name in meta.get("directories", []):
                            directory = tf_walk(input_fd, tf_parts(name), True)
                            os.close(directory)
                        for item in meta["manifest"]:
                            actual = tf_hash(ticket, item["object"])
                            tf_require(
                                all(actual[k] == item[k] for k in ("size", "sha256")),
                                "SFTP input digest mismatch; no attempt published",
                            )
                            parts = tf_parts(item["path"])
                            parent = tf_walk(input_fd, parts[:-1], True)
                            try:
                                copied = tf_copy(
                                    ticket, item["object"], parent, parts[-1]
                                )
                                tf_require(
                                    copied == actual,
                                    "SFTP input changed before publication",
                                )
                                os.fsync(parent)
                            finally:
                                os.close(parent)
                        os.fsync(input_fd)
                    finally:
                        os.close(input_fd)
                    output = tf_walk(stage, ["output"], True)
                    os.close(output)
                    identity = dict(meta["identity"])
                    identity["remoteCreatedAt"] = int(time.time() * 1000)
                    tf_json(stage, "attempt.json", identity)
                    tf_json(stage, "manifest.json", meta["manifest"])
                    supervisor = body["supervisor"].encode()
                    tf_require(
                        hashlib.sha256(supervisor).hexdigest()
                        == meta["supervisorHash"],
                        "Supervisor integrity mismatch",
                    )
                    script = os.open(
                        "supervisor.py",
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                        0o600,
                        dir_fd=stage,
                    )
                    with os.fdopen(script, "wb") as f:
                        f.write(supervisor)
                        f.flush()
                        os.fsync(f.fileno())
                    os.fsync(stage)
                    tf_recheck(root_path, root, ["attempts"], attempts)
                    tf_recheck(root_path, root, ["attempts", stage_name], stage)
                    tf_recheck(root_path, root, [".transfers", r["token"]], ticket)
                    tf_require(
                        tf_json(ticket, "ticket.json") == meta,
                        "Transfer metadata changed",
                    )
                    tf_publish(attempts, stage_name, aid)
                    return {
                        "staged": True,
                        "remoteCreatedAt": identity["remoteCreatedAt"],
                    }
                except Exception as error:
                    try:
                        tf_discard(attempts, stage_name, stage)
                    except (OSError, RuntimeError) as cleanup:
                        raise RuntimeError(
                            f"{error}; unpublished stage retained: {cleanup}"
                        ) from error
                    raise
                finally:
                    os.close(stage)
                    os.close(attempts)
            tf_require(kind == "transferRelease", "Unknown transfer action")
            tf_recheck(root_path, root, [".transfers", r["token"]], ticket)
            # Tickets only contain numbered objects and metadata; never traverse arbitrary trees.
            for name in os.listdir(ticket):
                tf_require(
                    name == "ticket.json" or (len(name) == 8 and name.isdigit()),
                    "Unexpected transfer object; retained for review",
                )
                st = os.stat(name, dir_fd=ticket, follow_symlinks=False)
                tf_require(
                    stat.S_ISREG(st.st_mode) and st.st_nlink == 1,
                    "Changed transfer object; retained for review",
                )
                os.unlink(name, dir_fd=ticket)
            transfers = tf_walk(root, [".transfers"])
            try:
                os.rmdir(r["token"], dir_fd=transfers)
                os.fsync(transfers)
            finally:
                os.close(transfers)
            return {"released": True}
        finally:
            os.close(ticket)
    finally:
        os.close(root)
