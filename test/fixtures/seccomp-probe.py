# Probes what the Linux seccomp helper refuses (test/attacks/fence-seccomp.test.ts): io_uring, VM sockets and new user
# namespaces, and unix sockets (the sandbox runtime blocks making one). One line each: "<name> ok" or "<name> <errno name>".
import ctypes, errno, socket
libc = ctypes.CDLL(None, use_errno=True)
def said(name, rc):
    print(name, "ok" if rc >= 0 else errno.errorcode.get(ctypes.get_errno(), "?"))
params = ctypes.create_string_buffer(120)
said("io_uring", libc.syscall(425, 1, params))  # io_uring_setup, the same number on x86_64 and aarch64
try:
    socket.socket(40, socket.SOCK_STREAM)  # AF_VSOCK
    print("vsock ok")
except OSError as error:
    print("vsock", errno.errorcode.get(error.errno, "?"))
said("userns", libc.unshare(0x10000000))  # CLONE_NEWUSER
try:
    socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    print("unix ok")
except OSError as error:
    print("unix", errno.errorcode.get(error.errno, "?"))
