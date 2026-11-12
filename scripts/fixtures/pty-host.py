"""A real terminal for a first-result journey (scripts/first-result-e2e.mjs): runs a command at a pseudo-terminal of a
fixed size, appends everything it draws to a log, and types into it whatever is written to a FIFO.

    python3 pty-host.py <rows> <cols> <keys fifo> <screen log> <pid file> <command> [args...]

macOS's `script` refuses a FIFO on its stdin (tcgetattr on a pipe fails with "Operation not supported on socket"),
so the journeys host the terminal here instead. The command is the session leader of its terminal, so its process group
is its own pid (written to the pid file once it runs). Exits with the command's status.
"""
import errno
import fcntl
import os
import pty
import select
import struct
import sys
import termios


def main():
    rows, cols, keys_path, log_path, pid_path = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]
    command = sys.argv[6:]
    pid, master = pty.fork()
    if pid == 0:
        # The terminal's size before the program reads it.
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        try:
            os.execvp(command[0], command)
        except OSError as error:
            os.write(2, ("cannot run %s: %s\n" % (command[0], error)).encode())
            os._exit(127)
    with open(pid_path + ".part", "w") as out:
        out.write("%d\n" % pid)
    os.rename(pid_path + ".part", pid_path)
    keys = os.open(keys_path, os.O_RDWR | os.O_NONBLOCK)
    log = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    while True:
        try:
            ready, _, _ = select.select([master, keys], [], [], 0.5)
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            os.write(log, data)
        if keys in ready:
            try:
                data = os.read(keys, 65536)
            except BlockingIOError:
                data = b""
            while data:
                written = os.write(master, data)
                data = data[written:]
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))


if __name__ == "__main__":
    main()
