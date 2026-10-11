//go:build !windows

package reverse_proxy

import (
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// sysProcAttr puts the child in its own process group so the whole tree can be
// terminated together and Ctrl+C on the relay does not reach it.
func sysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true}
}

// killProcessTree terminates a process and its descendants. Processes started
// by this relay live in their own process group; externally started ones are
// killed directly.
func killProcessTree(pid int) error {
	if err := syscall.Kill(-pid, syscall.SIGKILL); err == nil {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGKILL)
}

// portListenPID resolves the PID listening on a TCP port via lsof, falling
// back to fuser.
func portListenPID(port int) (int, bool) {
	portStr := strconv.Itoa(port)
	if output, err := exec.Command("lsof", "-t", "-iTCP:"+portStr, "-sTCP:LISTEN").Output(); err == nil {
		for line := range strings.SplitSeq(string(output), "\n") {
			if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && pid > 0 {
				return pid, true
			}
		}
	}
	if output, err := exec.Command("fuser", portStr+"/tcp").Output(); err == nil {
		fields := strings.Fields(strings.TrimSpace(string(output)))
		if len(fields) > 0 {
			if pid, err := strconv.Atoi(fields[len(fields)-1]); err == nil && pid > 0 {
				return pid, true
			}
		}
	}
	return 0, false
}
