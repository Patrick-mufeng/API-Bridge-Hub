//go:build !windows

package proc

import "os/exec"

// hide does nothing: a program on Unix has no window of its own.
func hide(*exec.Cmd) {}

// cancelTree leaves the command as it is: the context ending kills its
// process group here through Setpgid, set where a plugin's tools are run.
func cancelTree(*exec.Cmd) {}
