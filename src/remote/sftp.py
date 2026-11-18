"""Minimal SFTP v3 object server. No shell, arbitrary pathname or symlink operation."""

import struct


def sf_string(value):
    value = value.encode() if isinstance(value, str) else value
    return struct.pack(">I", len(value)) + value


class SFTPObjects:
    def __init__(self, root, token):
        self.root, self.token = root, token
        self.fd = tf_ticket(root, token)
        self.meta = tf_json(self.fd, "ticket.json")
        self.metadata_stamp = tf_stamp(
            os.stat("ticket.json", dir_fd=self.fd, follow_symlinks=False)
        )
        tf_require(time.time() - self.meta["createdAt"] < 86400, "Expired SFTP ticket")
        rootfd = tf_root(root)
        try:
            tf_require(
                self.meta.get("rootIdentity") == list(tf_stamp(os.fstat(rootfd))[:2]),
                "SFTP workspace identity changed",
            )
        finally:
            os.close(rootfd)
        self.files = {item["object"]: item for item in self.meta["manifest"]}
        self.handles = {}

    def read_exact(self, size):
        value = sys.stdin.buffer.read(size)
        tf_require(len(value) == size, "Truncated SFTP packet")
        return value

    def send(self, kind, request, payload=b""):
        data = bytes([kind]) + struct.pack(">I", request) + payload
        sys.stdout.buffer.write(struct.pack(">I", len(data)) + data)
        sys.stdout.buffer.flush()

    def status(self, request, code, message=""):
        self.send(
            101, request, struct.pack(">I", code) + sf_string(message) + sf_string("")
        )

    def name(self, value):
        value = value.decode("utf8")
        if value in (".", "/", ""):
            return "."
        if value.startswith("/"):
            value = value[1:]
        tf_require(value in self.files, "Only declared snapshot objects are accessible")
        return value

    def attrs(self, size, directory=False):
        return struct.pack(
            ">IQI",
            5,
            size,
            (stat.S_IFDIR | 0o700) if directory else (stat.S_IFREG | 0o600),
        )

    def run(self):
        try:
            while True:
                length = sys.stdin.buffer.read(4)
                if not length:
                    break
                tf_require(len(length) == 4, "Truncated SFTP frame")
                size = struct.unpack(">I", length)[0]
                tf_require(1 <= size <= 512 * 1024, "SFTP packet limit")
                packet = self.read_exact(size)
                kind, offset = packet[0], 1

                def number():
                    nonlocal offset
                    value = struct.unpack_from(">I", packet, offset)[0]
                    offset += 4
                    return value

                def string():
                    nonlocal offset
                    count = number()
                    tf_require(count <= len(packet) - offset, "Malformed SFTP string")
                    value = packet[offset : offset + count]
                    offset += count
                    return value

                def position():
                    nonlocal offset
                    value = struct.unpack_from(">Q", packet, offset)[0]
                    offset += 8
                    return value

                if kind == 1:
                    self.send(2, 3)
                    continue
                request = number()
                try:
                    current = tf_ticket(self.root, self.token)
                    try:
                        tf_require(
                            tf_stamp(os.fstat(current))[:2]
                            == tf_stamp(os.fstat(self.fd))[:2],
                            "SFTP ticket identity changed",
                        )
                        tf_require(
                            tf_stamp(
                                os.stat(
                                    "ticket.json", dir_fd=current, follow_symlinks=False
                                )
                            )
                            == self.metadata_stamp,
                            "SFTP ticket metadata changed",
                        )
                    finally:
                        os.close(current)
                    if kind == 16:  # REALPATH
                        path = self.name(string())
                        self.send(
                            104,
                            request,
                            struct.pack(">I", 1)
                            + sf_string("/" if path == "." else "/" + path)
                            + sf_string(path)
                            + self.attrs(0, path == "."),
                        )
                    elif kind in (7, 17):  # LSTAT / STAT
                        path = self.name(string())
                        if path == ".":
                            self.send(105, request, self.attrs(0, True))
                        else:
                            st = os.stat(path, dir_fd=self.fd, follow_symlinks=False)
                            tf_require(
                                stat.S_ISREG(st.st_mode) and st.st_nlink == 1,
                                "Unsafe SFTP object",
                            )
                            self.send(105, request, self.attrs(st.st_size))
                    elif kind == 3:  # OPEN
                        name = self.name(string())
                        flags = number()
                        tf_require(
                            name != "." and len(self.handles) < 4, "SFTP handle limit"
                        )
                        writing = self.meta["mode"] == "upload"
                        tf_require(
                            (writing and flags & 2 and flags & 8 and not flags & 1)
                            or (not writing and flags == 1),
                            "SFTP mode is fixed by the reviewed ticket",
                        )
                        fd = os.open(
                            name,
                            (
                                os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                if writing
                                else os.O_RDONLY
                            )
                            | os.O_NOFOLLOW
                            | os.O_NONBLOCK,
                            0o600,
                            dir_fd=self.fd,
                        )
                        tf_require(
                            stat.S_ISREG(os.fstat(fd).st_mode)
                            and os.fstat(fd).st_nlink == 1,
                            "Unsafe SFTP handle",
                        )
                        handle = uuid.uuid4().hex.encode()
                        self.handles[handle] = {
                            "fd": fd,
                            "name": name,
                            "position": 0,
                            "writing": writing,
                        }
                        self.send(102, request, sf_string(handle))
                    elif kind in (4, 5, 6, 8, 10):
                        handle = string()
                        tf_require(handle in self.handles, "Unknown SFTP handle")
                        entry = self.handles[handle]
                        if kind == 4:  # CLOSE
                            if entry["writing"]:
                                tf_require(
                                    entry["position"]
                                    == self.files[entry["name"]]["size"],
                                    "Incomplete SFTP upload",
                                )
                                os.fsync(entry["fd"])
                            os.close(entry["fd"])
                            del self.handles[handle]
                            os.fsync(self.fd)
                            self.status(request, 0)
                        elif kind == 5:  # READ (bounded pipelining, offset checked)
                            at, length = position(), number()
                            tf_require(
                                not entry["writing"] and length <= 262144,
                                "Invalid SFTP read",
                            )
                            data = os.pread(entry["fd"], length, at)
                            if data:
                                self.send(103, request, sf_string(data))
                            else:
                                self.status(request, 1)
                        elif kind == 6:
                            at, data = position(), string()
                            tf_require(
                                entry["writing"]
                                and at == entry["position"]
                                and at + len(data) <= self.files[entry["name"]]["size"],
                                "Out-of-scope SFTP write",
                            )
                            written = 0
                            while written < len(data):
                                written += os.write(entry["fd"], data[written:])
                            entry["position"] += len(data)
                            self.status(request, 0)
                        elif kind == 8:
                            self.send(
                                105, request, self.attrs(os.fstat(entry["fd"]).st_size)
                            )
                        else:
                            self.status(
                                request, 8, "SFTP metadata mutation unsupported"
                            )
                    else:
                        self.status(
                            request,
                            8,
                            "Only fixed snapshot object transfers are supported",
                        )
                except FileNotFoundError:
                    self.status(request, 2)
                except Exception as error:
                    self.status(request, 4, str(error)[:256])
        finally:
            for entry in self.handles.values():
                os.close(entry["fd"])
            os.close(self.fd)


if __name__ == "__main__":
    SFTPObjects(sys.argv[1], sys.argv[2]).run()
