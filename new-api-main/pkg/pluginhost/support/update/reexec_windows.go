package update

import (
	"errors"
	"os"
	"os/exec"
)

// ReexecSupported says Reexec can replace the process here. Windows has no
// exec: the host is started again as a child and this one exits, which a
// service manager sees as the same service.
const ReexecSupported = false

// Reexec starts exe with args and env, then exits this process. Callers
// treat a nil error as "this process is ending".
func Reexec(exe string, args, env []string) error {
	if exe == "" {
		return errors.New("no executable to restart as")
	}
	cmd := exec.Command(exe, args[1:]...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	os.Exit(0)
	return nil
}
