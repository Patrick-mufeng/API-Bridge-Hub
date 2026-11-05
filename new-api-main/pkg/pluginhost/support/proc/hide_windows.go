package proc

import (
	"os/exec"
	"syscall"
)

// hide gives cmd a console without a window. The hub on Windows is linked
// as a console program, but a child that allocates its own console (Bun
// does) flashes a window for every run: CREATE_NO_WINDOW gives it one with
// nothing drawn.
func hide(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}

// cancelTree kills what the command started with it: a Bun host starts
// programs of its own, and killing the host alone leaves them holding the
// pipes Output is reading.
func cancelTree(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP
}
