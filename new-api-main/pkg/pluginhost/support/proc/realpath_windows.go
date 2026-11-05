package proc

import (
	"strings"

	"golang.org/x/sys/windows"
)

// RealPath is where the file at p really is, its links followed: the path
// Windows itself opens, so a junction is followed as well as a symlink.
// filepath.EvalSymlinks leaves junctions as they are (Go 1.23), and a
// plugin installed from a folder reached through one would be seen at a
// path the host then can't open.
func RealPath(p string) (string, error) {
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	// no access asked for: only the handle's path is read;
	// BACKUP_SEMANTICS opens a folder as well as a file
	h, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return "", err
	}
	s := windows.UTF16ToString(buf[:n])
	// \\?\C:\… and \\?\UNC\server\share\…
	if rest, ok := strings.CutPrefix(s, `\\?\UNC\`); ok {
		return `\` + rest, nil
	}
	return strings.TrimPrefix(s, `\\?\`), nil
}
