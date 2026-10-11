//go:build windows

package reverse_proxy

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

const (
	createNoWindowFlag        = 0x08000000
	createNewProcessGroupFlag = 0x00000200
)

// sysProcAttr detaches the child from the relay console so pressing Ctrl+C on
// the relay does not take the managed services down with it, and suppresses a
// console window for console subcommands.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindowFlag | createNewProcessGroupFlag,
	}
}

// killProcessTree terminates a process and its descendants. Service processes
// such as node-based panels spawn children, so killing only the direct child
// would leave orphans behind.
func killProcessTree(pid int) error {
	output, err := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").CombinedOutput()
	if err != nil {
		return &execError{msg: strings.TrimSpace(string(output)), err: err}
	}
	return nil
}

// portListenPID resolves the PID listening on a TCP port via netstat.
func portListenPID(port int) (int, bool) {
	output, err := exec.Command("netstat", "-ano", "-p", "tcp").Output()
	if err != nil {
		return 0, false
	}
	suffix := ":" + strconv.Itoa(port)
	fallback := 0
	for line := range strings.SplitSeq(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 5 || fields[0] != "TCP" || fields[3] != "LISTENING" {
			continue
		}
		if !strings.HasSuffix(fields[1], suffix) {
			continue
		}
		pid, err := strconv.Atoi(fields[4])
		if err != nil || pid <= 0 {
			continue
		}
		if strings.HasPrefix(fields[1], "127.") || strings.HasPrefix(fields[1], "[::1]") {
			return pid, true
		}
		if fallback == 0 {
			fallback = pid
		}
	}
	if fallback != 0 {
		return fallback, true
	}
	return 0, false
}

type execError struct {
	msg string
	err error
}

func (e *execError) Error() string {
	if e.msg == "" {
		return e.err.Error()
	}
	return e.msg
}

func (e *execError) Unwrap() error { return e.err }
