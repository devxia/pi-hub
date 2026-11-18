// N-API boundary: every path component is opened relative to a retained directory fd.
#include <dirent.h>
#include <fcntl.h>
#include <node_api.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstdio>
#ifndef __APPLE__
#include <sys/syscall.h>
#endif
#include <algorithm>
#include <cctype>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
struct FD {
  int n;
  explicit FD(int v) : n(v) {
    if (v < 0) throw std::runtime_error(strerror(errno));
  }
  ~FD() {
    if (n >= 0) close(n);
  }
  FD(const FD&) = delete;
  FD& operator=(const FD&) = delete;
};
static void ok(bool v, const char* m) {
  if (!v) throw std::runtime_error(m);
}
static std::string str(napi_env e, napi_value v) {
  size_t n;
  ok(napi_get_value_string_utf8(e, v, nullptr, 0, &n) == napi_ok, "Expected string");
  std::string s(n + 1, 0);
  napi_get_value_string_utf8(e, v, s.data(), s.size(), &n);
  s.resize(n);
  ok(s.find('\0') == std::string::npos, "NUL in path");
  return s;
}
static napi_value string(napi_env e, const std::string& s) {
  napi_value v;
  napi_create_string_utf8(e, s.data(), s.size(), &v);
  return v;
}
static napi_value prop(napi_env e, napi_value v, const char* k) {
  napi_value x;
  ok(napi_get_named_property(e, v, k, &x) == napi_ok, "Missing field");
  return x;
}
static std::vector<std::string> parts(const std::string& p, bool absolute) {
  ok(!p.empty() && (absolute ? p[0] == '/' : p[0] != '/'), "Invalid path");
  std::vector<std::string> out;
  size_t at = absolute ? 1 : 0;
  while (at < p.size()) {
    auto end = p.find('/', at);
    auto s = p.substr(at, end == std::string::npos ? p.size() - at : end - at);
    ok(!s.empty() && s != "." && s != ".." && s.find('\\') == std::string::npos,
       "Traversal rejected");
    out.push_back(s);
    if (end == std::string::npos) break;
    at = end + 1;
  }
  return out;
}
static bool same(const struct stat& a, const struct stat& b) {
  return a.st_ino == b.st_ino && a.st_dev == b.st_dev;
}
static std::string identity(int fd) {
  struct stat s;
  ok(fstat(fd, &s) == 0, "Directory identity unavailable");
  return std::to_string(s.st_dev) + ":" + std::to_string(s.st_ino);
}
static int walk(int base, const std::vector<std::string>& p, size_t count, bool create = false) {
  int current = dup(base);
  ok(current >= 0, "dup failed");
  try {
    for (size_t i = 0; i < count; i++) {
      if (create) {
        if (mkdirat(current, p[i].c_str(), 0700) < 0 && errno != EEXIST)
          throw std::runtime_error(strerror(errno));
        ok(fsync(current) == 0, "Directory sync failed");
      }
      int next = openat(current, p[i].c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0) throw std::runtime_error("Unsafe directory component");
      close(current);
      current = next;
    }
    return current;
  } catch (...) {
    close(current);
    throw;
  }
}
static int rootfd(const std::string& p) {
  FD root(open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  auto v = parts(p, true);
  return walk(root.n, v, v.size());
}
static void recheck(const std::string& root, int rootfd, const std::vector<std::string>& p,
                    int parent) {
  FD now(rootfd < 0 ? -1 : ::open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  auto rv = parts(root, true);
  FD r(walk(now.n, rv, rv.size()));
  ok(identity(r.n) == identity(rootfd), "Root directory changed");
  FD q(walk(r.n, p, p.size() - 1));
  ok(identity(q.n) == identity(parent), "Input parent changed");
}
static napi_value snapshot(napi_env e, napi_callback_info info) {
  try {
    size_t argc = 2;
    napi_value a[2];
    napi_get_cb_info(e, info, &argc, a, nullptr, nullptr);
    ok(argc == 2, "snapshot arguments");
    auto root = str(e, a[0]);
    FD base(rootfd(root));
    uint32_t count;
    napi_get_array_length(e, a[1], &count);
    ok(count <= 256, "Input count limit");
    napi_value out;
    napi_create_array_with_length(e, count, &out);
    size_t total = 0;
    for (uint32_t i = 0; i < count; i++) {
      napi_value name;
      napi_get_element(e, a[1], i, &name);
      auto path = str(e, name);
      auto p = parts(path, false);
      FD parent(walk(base.n, p, p.size() - 1));
      struct stat before;
      ok(fstatat(parent.n, p.back().c_str(), &before, AT_SYMLINK_NOFOLLOW) == 0 &&
             S_ISREG(before.st_mode) && before.st_nlink == 1,
         "Only regular input files");
      ok(before.st_size >= 0 && (total += before.st_size) <= 16 * 1024 * 1024, "Input size limit");
      FD file(openat(parent.n, p.back().c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
      struct stat opened;
      ok(fstat(file.n, &opened) == 0 && same(before, opened), "Input changed while opening");
      std::vector<char> bytes(before.st_size);
      size_t at = 0;
      while (at < bytes.size()) {
        auto n = read(file.n, bytes.data() + at, bytes.size() - at);
        if (n < 0 && errno == EINTR) continue;
        ok(n > 0, "Input changed while reading");
        at += n;
      }
      struct stat after;
      ok(fstat(file.n, &after) == 0 && after.st_size == before.st_size &&
             after.st_mtime == before.st_mtime && after.st_ctime == before.st_ctime,
         "Input changed during read");
#ifdef __APPLE__
      ok(after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec &&
             after.st_ctimespec.tv_nsec == before.st_ctimespec.tv_nsec,
         "Input changed during read");
#else
      ok(after.st_mtim.tv_nsec == before.st_mtim.tv_nsec &&
             after.st_ctim.tv_nsec == before.st_ctim.tv_nsec,
         "Input changed during read");
#endif
      struct stat named;
      ok(fstatat(parent.n, p.back().c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 &&
             same(named, opened),
         "Input name changed");
      recheck(root, base.n, p, parent.n);
      napi_value row, buffer;
      napi_create_object(e, &row);
      napi_set_named_property(e, row, "path", name);
      napi_create_buffer_copy(e, bytes.size(), bytes.data(), nullptr, &buffer);
      napi_set_named_property(e, row, "bytes", buffer);
      napi_set_element(e, out, i, row);
    }
    return out;
  } catch (const std::exception& x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
static std::string stamp(const struct stat& s) {
#ifdef __APPLE__
  auto mt = s.st_mtimespec, ct = s.st_ctimespec;
#else
  auto mt = s.st_mtim, ct = s.st_ctim;
#endif
  return std::to_string(s.st_dev) + ":" + std::to_string(s.st_ino) + ":" +
         std::to_string(s.st_mode) + ":" + std::to_string(s.st_size) + ":" +
         std::to_string(mt.tv_sec) + ":" + std::to_string(mt.tv_nsec) + ":" +
         std::to_string(ct.tv_sec) + ":" + std::to_string(ct.tv_nsec);
}
struct Input {
  int root = -1, parent = -1, file = -1;
  std::string rootPath, path;
  struct stat before{};
  ~Input() { closeAll(); }
  void closeAll() {
    if (file >= 0) close(file);
    if (parent >= 0) close(parent);
    if (root >= 0) close(root);
    file = parent = root = -1;
  }
};
static void inputFinal(napi_env, void* data, void*) { delete static_cast<Input*>(data); }
static Input* inputHandle(napi_env e, napi_value object) {
  void* p;
  ok(napi_get_value_external(e, prop(e, object, "handle"), &p) == napi_ok, "Invalid input handle");
  auto* i = static_cast<Input*>(p);
  ok(i->file >= 0, "Input already closed");
  return i;
}
static napi_value openInput(napi_env e, napi_callback_info info) {
  Input* i = nullptr;
  try {
    size_t argc = 2;
    napi_value a[2];
    napi_get_cb_info(e, info, &argc, a, nullptr, nullptr);
    ok(argc == 2, "openInput arguments");
    i = new Input;
    i->rootPath = str(e, a[0]);
    i->path = str(e, a[1]);
    auto p = parts(i->path, false);
    i->root = rootfd(i->rootPath);
    i->parent = walk(i->root, p, p.size() - 1);
    ok(fstatat(i->parent, p.back().c_str(), &i->before, AT_SYMLINK_NOFOLLOW) == 0 &&
           S_ISREG(i->before.st_mode) && i->before.st_nlink == 1 && i->before.st_size >= 0,
       "Only regular unlinked input files");
    i->file = openat(i->parent, p.back().c_str(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    ok(i->file >= 0, "Input open failed");
    struct stat opened;
    ok(fstat(i->file, &opened) == 0 && stamp(opened) == stamp(i->before),
       "Input changed while opening");
    napi_value row, handle, fd, size;
    napi_create_object(e, &row);
    napi_create_external(e, i, inputFinal, nullptr, &handle);
    napi_set_named_property(e, row, "handle", handle);
    napi_create_int32(e, i->file, &fd);
    napi_set_named_property(e, row, "fd", fd);
    napi_create_double(e, static_cast<double>(i->before.st_size), &size);
    napi_set_named_property(e, row, "size", size);
    napi_set_named_property(e, row, "sourceStamp", string(e, stamp(i->before)));
    return row;
  } catch (const std::exception& x) {
    delete i;
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
static napi_value finishInput(napi_env e, napi_callback_info info) {
  Input* i = nullptr;
  try {
    size_t argc = 2;
    napi_value a[2];
    napi_get_cb_info(e, info, &argc, a, nullptr, nullptr);
    ok(argc == 2, "finishInput arguments");
    i = inputHandle(e, a[0]);
    bool verify = false;
    napi_get_value_bool(e, a[1], &verify);
    if (verify) {
      struct stat after, named;
      auto p = parts(i->path, false);
      ok(fstat(i->file, &after) == 0 && stamp(after) == stamp(i->before),
         "Input changed during streaming read");
      ok(fstatat(i->parent, p.back().c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 &&
             stamp(named) == stamp(i->before),
         "Input name changed during streaming read");
      recheck(i->rootPath, i->root, p, i->parent);
    }
    i->closeAll();
    napi_value value;
    napi_get_undefined(e, &value);
    return value;
  } catch (const std::exception& x) {
    if (i) i->closeAll();
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
static bool excludedName(std::string name) {
  std::transform(name.begin(), name.end(), name.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  static const std::vector<std::string> names = {
      ".git",   ".scratch",         "node_modules", ".ssh",   ".aws",   ".pi-hub",    "dist",
      "output", "outputs",          "__pycache__",  ".cache", "id_rsa", "id_ed25519", "id_ecdsa",
      "id_dsa", "credentials.json", "auth.json"};
  if (std::find(names.begin(), names.end(), name) != names.end() || name == ".env" ||
      name.rfind(".env.", 0) == 0)
    return true;
  for (auto suffix : {".pem", ".key", ".p12", ".pfx"})
    if (name.size() >= strlen(suffix) &&
        name.compare(name.size() - strlen(suffix), strlen(suffix), suffix) == 0)
      return true;
  return false;
}
static void enumerateAt(int base, const std::string& path, std::vector<std::string>& files,
                        std::vector<std::string>& dirs, size_t& count) {
  auto p = parts(path, false);
  for (const auto& part : p) ok(!excludedName(part), "Excluded input selection");
  FD parent(walk(base, p, p.size() - 1));
  struct stat st;
  ok(fstatat(parent.n, p.back().c_str(), &st, AT_SYMLINK_NOFOLLOW) == 0, "Input unavailable");
  ok(++count <= 100000, "Manifest entry limit (100000)");
  if (S_ISDIR(st.st_mode)) {
    FD dir(openat(parent.n, p.back().c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    struct stat opened;
    ok(fstat(dir.n, &opened) == 0 && same(st, opened), "Input directory changed");
    dirs.push_back(path);
    DIR* d = fdopendir(dup(dir.n));
    ok(d, "Input enumeration failed");
    std::vector<std::string> names;
    while (auto* entry = readdir(d)) {
      std::string n = entry->d_name;
      if (n != "." && n != ".." && !excludedName(n)) names.push_back(n);
    }
    closedir(d);
    std::sort(names.begin(), names.end());
    for (const auto& name : names) enumerateAt(base, path + "/" + name, files, dirs, count);
    struct stat after;
    ok(fstat(dir.n, &after) == 0 && stamp(st) == stamp(after),
       "Input directory changed during enumeration");
  } else {
    ok(S_ISREG(st.st_mode) && st.st_nlink == 1,
       "Only regular files/directories, no symlinks or hardlinks");
    files.push_back(path);
  }
}
static napi_value enumerate(napi_env e, napi_callback_info info) {
  try {
    size_t argc = 2;
    napi_value a[2];
    napi_get_cb_info(e, info, &argc, a, nullptr, nullptr);
    ok(argc == 2, "enumerate arguments");
    auto path = str(e, a[0]);
    FD base(rootfd(path));
    uint32_t count;
    napi_get_array_length(e, a[1], &count);
    ok(count <= 10000, "Selection count limit");
    std::vector<std::string> files, dirs;
    size_t total = 0;
    for (uint32_t n = 0; n < count; n++) {
      napi_value item;
      napi_get_element(e, a[1], n, &item);
      enumerateAt(base.n, str(e, item), files, dirs, total);
    }
    FD current(rootfd(path));
    ok(identity(current.n) == identity(base.n), "Input root changed");
    napi_value result;
    napi_create_object(e, &result);
    for (auto pair : {std::make_pair("files", files), std::make_pair("directories", dirs)}) {
      std::sort(pair.second.begin(), pair.second.end());
      pair.second.erase(std::unique(pair.second.begin(), pair.second.end()), pair.second.end());
      napi_value list;
      napi_create_array_with_length(e, pair.second.size(), &list);
      for (size_t n = 0; n < pair.second.size(); n++)
        napi_set_element(e, list, n, string(e, pair.second[n]));
      napi_set_named_property(e, result, pair.first, list);
    }
    return result;
  } catch (const std::exception& x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}

static void tree(int fd, const std::string& prefix, std::string& revision, size_t& count,
                 size_t& total) {
  struct stat before, after;
  ok(fstat(fd, &before) == 0, "Target unavailable");
  DIR* d = fdopendir(dup(fd));
  ok(d, "Target directory unavailable");
  rewinddir(d);
  std::vector<std::string> names;
  while (auto* entry = readdir(d)) {
    std::string name = entry->d_name;
    if (name != "." && name != "..") names.push_back(name);
  }
  closedir(d);
  std::sort(names.begin(), names.end());
  revision += prefix + "=" + stamp(before) + "\n";
  for (const auto& name : names) {
    ok(++count <= 100000, "Overwrite target entry limit");
    struct stat st;
    ok(fstatat(fd, name.c_str(), &st, AT_SYMLINK_NOFOLLOW) == 0, "Overwrite target changed");
    auto path = prefix + "/" + name;
    if (S_ISDIR(st.st_mode)) {
      FD sub(openat(fd, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
      tree(sub.n, path, revision, count, total);
    } else {
      ok(S_ISREG(st.st_mode) && st.st_nlink == 1 && st.st_size >= 0 &&
             (total += st.st_size) <= 1099511627776ULL,
         "Overwrite target must contain bounded regular files only");
      revision += path + "=" + stamp(st) + "\n";
    }
  }
  ok(fstat(fd, &after) == 0 && stamp(before) == stamp(after),
     "Overwrite target changed during review");
}
static std::string revision(int fd) {
  std::string value;
  size_t count = 0, total = 0;
  tree(fd, "", value, count, total);
  return value;
}
static napi_value inspect(napi_env e, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value a[1];
    napi_get_cb_info(e, info, &argc, a, nullptr, nullptr);
    ok(argc == 1, "inspect arguments");
    auto path = str(e, a[0]);
    FD target(rootfd(path));
    auto value = revision(target.n);
    FD current(rootfd(path));
    ok(identity(current.n) == identity(target.n), "Overwrite target changed");
    return string(e, value);
  } catch (const std::exception& x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
static std::string afterRenameRevision(const std::string& value) {
  auto end = value.find('\n'), at = value.rfind(':', end), prev = value.rfind(':', at - 1);
  return value.substr(0, prev) + value.substr(end);
}
static int exchange(int parent, const char* from, const char* to) {
#ifdef __APPLE__
  return renameatx_np(parent, from, parent, to, RENAME_SWAP);
#else
  return syscall(SYS_renameat2, parent, from, parent, to, 2);
#endif
}
static bool namedIdentity(int parent, const std::string& name, int fd) {
  struct stat a, b;
  return fstat(fd, &a) == 0 && fstatat(parent, name.c_str(), &b, AT_SYMLINK_NOFOLLOW) == 0 &&
         same(a, b) && S_ISDIR(b.st_mode);
}
static napi_value publish(napi_env e, napi_callback_info info) {
  try {
    size_t argc = 7;
    napi_value a[7];
    napi_get_cb_info(e, info, &argc, a, nullptr, nullptr);
    ok(argc == 5 || argc == 7, "publish arguments");
    auto destination = str(e, a[0]), expected = str(e, a[2]), tempName = str(e, a[3]),
         expectedTarget = str(e, a[4]);
    auto slash = destination.rfind('/');
    auto parentPath = slash == 0 ? "/" : destination.substr(0, slash);
    auto leaf = destination.substr(slash + 1);
    parts(leaf, false);
    parts(tempName, false);
    FD parent(rootfd(parentPath));
    ok(identity(parent.n) == expected, "Destination parent changed since approval");
    ok(mkdirat(parent.n, tempName.c_str(), 0700) == 0, "Result staging directory exists");
    FD stage(openat(parent.n, tempName.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    uint32_t count;
    napi_get_array_length(e, a[1], &count);
    ok(count <= (argc == 7 ? 100000U : 256U), "Artifact count limit");
    size_t total = 0;
    for (uint32_t i = 0; i < count; i++) {
      napi_value row;
      napi_get_element(e, a[1], i, &row);
      auto path = str(e, prop(e, row, "path"));
      auto p = parts(path, false);
      FD dir(walk(stage.n, p, p.size() - 1, true));
      if (argc == 7) {
        auto source = str(e, a[5]);
        auto sp = parts(str(e, prop(e, row, "object")), false);
        FD base(rootfd(source));
        FD sourceParent(walk(base.n, sp, sp.size() - 1));
        FD input(openat(sourceParent.n, sp.back().c_str(),
                        O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
        struct stat before;
        ok(fstat(input.n, &before) == 0 && S_ISREG(before.st_mode) && before.st_nlink == 1 &&
               stamp(before) == str(e, prop(e, row, "sourceStamp")),
           "Result snapshot changed before publication");
        ok(before.st_size >= 0 && (total += before.st_size) <= 1099511627776ULL,
           "Result size limit (1 TiB)");
        FD f(openat(dir.n, p.back().c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                    0600));
        char buffer[262144];
        size_t copied = 0;
        while (true) {
          ssize_t n = read(input.n, buffer, sizeof(buffer));
          if (n < 0 && errno == EINTR) continue;
          ok(n >= 0, "Result read failed");
          if (!n) break;
          size_t at = 0;
          while (at < static_cast<size_t>(n)) {
            auto w = write(f.n, buffer + at, n - at);
            if (w < 0 && errno == EINTR) continue;
            ok(w > 0, "Result write failed");
            at += w;
          }
          copied += n;
        }
        struct stat after;
        ok(fstat(input.n, &after) == 0 && stamp(before) == stamp(after) &&
               copied == static_cast<size_t>(before.st_size),
           "Result snapshot changed during publication");
        recheck(source, base.n, sp, sourceParent.n);
        ok(fsync(f.n) == 0 && fsync(dir.n) == 0, "Result sync failed");
      } else {
        void* data;
        size_t size;
        ok(napi_get_buffer_info(e, prop(e, row, "bytes"), &data, &size) == napi_ok &&
               (total += size) <= 16 * 1024 * 1024,
           "Artifact size limit");
        FD f(openat(dir.n, p.back().c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                    0600));
        size_t at = 0;
        while (at < size) {
          auto n = write(f.n, static_cast<char*>(data) + at, size - at);
          if (n < 0 && errno == EINTR) continue;
          ok(n > 0, "Artifact write failed");
          at += n;
        }
        ok(fsync(f.n) == 0 && fsync(dir.n) == 0, "Artifact sync failed");
      }
    }

    if (argc == 7) {
      uint32_t n;
      napi_get_array_length(e, a[6], &n);
      ok(n <= 10000, "Directory count limit");
      for (uint32_t i = 0; i < n; i++) {
        napi_value name;
        napi_get_element(e, a[6], i, &name);
        auto p = parts(str(e, name), false);
        FD dir(walk(stage.n, p, p.size(), true));
        ok(fsync(dir.n) == 0, "Directory sync failed");
      }
    }
    ok(fsync(stage.n) == 0, "Staging sync failed");
    FD current(rootfd(parentPath));
    ok(identity(current.n) == identity(parent.n), "Destination parent changed before publication");
    if (!expectedTarget.empty()) {
      FD target(openat(parent.n, leaf.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
      ok(revision(target.n) == expectedTarget, "Overwrite target changed since approval");
      struct stat named;
      ok(fstatat(parent.n, leaf.c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 &&
             S_ISDIR(named.st_mode) &&
             identity(target.n) ==
                 std::to_string(named.st_dev) + ":" + std::to_string(named.st_ino),
         "Overwrite target identity changed");
      ok(exchange(parent.n, tempName.c_str(), leaf.c_str()) == 0,
         "Atomic overwrite exchange unavailable");
      // Verify the directory actually displaced by the atomic exchange. Rename changes
      // root ctime, so compare all other root fields plus every descendant revision.
      bool valid = false;
      try {
        FD displaced(
            openat(parent.n, tempName.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
        valid = identity(displaced.n) == identity(target.n) &&
                afterRenameRevision(revision(displaced.n)) == afterRenameRevision(expectedTarget);
      } catch (...) {
        valid = false;
      }
      if (!valid) {
        if (namedIdentity(parent.n, leaf, stage.n) && namedIdentity(parent.n, tempName, target.n)) {
          ok(exchange(parent.n, tempName.c_str(), leaf.c_str()) == 0,
             "Concurrent overwrite failed; both directories retained");
          ok(fsync(parent.n) == 0, "Rollback sync failed");
        }
        throw std::runtime_error(
            "Overwrite target raced publication; no success recorded, directories retained");
      }
      // The previous directory remains at the reviewed staging name; never delete it.
    } else {
#ifdef __APPLE__
      ok(renameatx_np(parent.n, tempName.c_str(), parent.n, leaf.c_str(), RENAME_EXCL) == 0,
         "Destination exists or publication failed");
#else
      // Linux renameat2 RENAME_NOREPLACE. No unsafe overwrite fallback.
      ok(syscall(SYS_renameat2, parent.n, tempName.c_str(), parent.n, leaf.c_str(), 1) == 0,
         "Atomic no-replace publication unavailable or failed");
#endif
    }
    ok(fsync(parent.n) == 0, "Result directory sync failed");
    FD publishedParent(rootfd(parentPath));
    ok(identity(publishedParent.n) == identity(parent.n),
       "Destination parent changed during publication; retained result requires review");
    napi_value value;
    napi_get_undefined(e, &value);
    return value;
  } catch (const std::exception& x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
static napi_value releaseSnapshot(napi_env e, napi_callback_info info) {
  try {
    size_t argc = 2;
    napi_value argv[2];
    napi_get_cb_info(e, info, &argc, argv, nullptr, nullptr);
    ok(argc == 2, "Expected snapshot parent and name");
    FD parent(rootfd(str(e, argv[0])));
    auto name = str(e, argv[1]);
    ok(name.size() == 36 && name.find_first_not_of("0123456789abcdef-") == std::string::npos,
       "Invalid snapshot name");
    struct stat parentStat;
    ok(fstat(parent.n, &parentStat) == 0 && parentStat.st_uid == geteuid() &&
           !(parentStat.st_mode & 077),
       "Snapshot parent is not private");
    int descriptor = openat(parent.n, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor >= 0) {
      FD directory(descriptor);
      struct stat held;
      ok(fstat(directory.n, &held) == 0 && held.st_uid == geteuid() && !(held.st_mode & 077),
         "Snapshot directory is not private");
      FD scan(dup(directory.n));
      DIR* stream = fdopendir(scan.n);
      ok(stream != nullptr, "Snapshot directory scan failed");
      scan.n = -1;
      std::vector<std::string> objects;
      errno = 0;
      while (auto entry = readdir(stream)) {
        std::string object(entry->d_name);
        if (object == "." || object == "..") continue;
        objects.push_back(std::move(object));
        if (objects.size() > 10000) break;
      }
      int scanError = errno;
      closedir(stream);
      ok(scanError == 0 && objects.size() <= 10000, "Snapshot directory scan failed");
      for (const auto& object : objects) {
        struct stat file;
        ok(object.size() == 8 && object.find_first_not_of("0123456789") == std::string::npos &&
               fstatat(directory.n, object.c_str(), &file, AT_SYMLINK_NOFOLLOW) == 0 &&
               S_ISREG(file.st_mode) && file.st_uid == geteuid() && file.st_nlink == 1,
           "Unexpected object in snapshot directory");
      }
      for (const auto& object : objects)
        ok(unlinkat(directory.n, object.c_str(), 0) == 0, "Snapshot object cleanup failed");
      struct stat named;
      ok(fstatat(parent.n, name.c_str(), &named, AT_SYMLINK_NOFOLLOW) == 0 && same(held, named),
         "Snapshot directory identity changed");
      ok(unlinkat(parent.n, name.c_str(), AT_REMOVEDIR) == 0 && fsync(parent.n) == 0,
         "Snapshot directory cleanup failed");
    } else {
      ok(errno == ENOENT, "Unsafe snapshot directory");
    }
    napi_value result;
    napi_get_undefined(e, &result);
    return result;
  } catch (const std::exception& x) {
    napi_throw_error(e, nullptr, x.what());
    return nullptr;
  }
}
NAPI_MODULE_INIT() {
  napi_value f;
  for (auto method :
       {std::make_pair("openInput", openInput), std::make_pair("finishInput", finishInput),
        std::make_pair("enumerate", enumerate), std::make_pair("publishDisk", publish),
        std::make_pair("releaseSnapshot", releaseSnapshot)}) {
    napi_create_function(env, method.first, NAPI_AUTO_LENGTH, method.second, nullptr, &f);
    napi_set_named_property(env, exports, method.first, f);
  }
  napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, inspect, nullptr, &f);
  napi_set_named_property(env, exports, "inspect", f);
  napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, snapshot, nullptr, &f);
  napi_set_named_property(env, exports, "snapshot", f);
  napi_create_function(env, "publish", NAPI_AUTO_LENGTH, publish, nullptr, &f);
  napi_set_named_property(env, exports, "publish", f);
  return exports;
}
