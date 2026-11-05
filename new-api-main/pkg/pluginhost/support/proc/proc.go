// Package proc makes the commands the plugin host runs: Bun, and each
// plugin's own tools. Every one is made here rather than with os/exec, so
// that on Windows none of them opens a window.
//
// This is the part of magpie's internal/proc the plugin host needs. The
// rest of magpie's package (login shells, PATH discovery, agent
// environments) has no caller here and is left out.
package proc

import (
	"context"
	"os/exec"
	"time"
)

// Command is exec.Command, with no window of its own on Windows.
func Command(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	hide(cmd)
	return cmd
}

// CommandContext is exec.CommandContext, with no window of its own on
// Windows.
func CommandContext(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	// the context ending kills the command, but not what it started: a CLI
	// that is a script running node leaves node holding the output, and
	// Output waited for it however long it took. Its pipes are closed a
	// moment after instead.
	cmd.WaitDelay = waitDelay
	cancelTree(cmd)
	hide(cmd)
	return cmd
}

var waitDelay = 2 * time.Second

// LoginEnvKnown is the value the login shell last said of k. Nothing here
// asks a login shell (this build has no PTY probe), so it is always "" and
// a registry set only in a shell profile is not seen. The npm registry the
// host installs plugins from is set in the hub's settings instead.
func LoginEnvKnown(string) string { return "" }
