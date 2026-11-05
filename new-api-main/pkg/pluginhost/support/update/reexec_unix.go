//go:build !windows

package update

import (
	"os"
	"syscall"
)

// Reexec replaces this process with exe, the same arguments and environment:
// a plugin's install of a new Bun or of its own code needs the host started
// again, and keeping the process's place keeps the terminal and the service
// manager that started it as they are.
func Reexec(exe string, args, env []string) error {
	return syscall.Exec(exe, args, env)
}

// ReexecSupported says Reexec can replace the process here.
const ReexecSupported = true

var _ = os.Getpid
