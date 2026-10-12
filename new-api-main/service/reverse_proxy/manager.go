package reverse_proxy

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/logger"
)

const (
	probeDialTimeout    = 800 * time.Millisecond
	probeHealthTimeout  = 2 * time.Second
	stopWaitTimeout     = 10 * time.Second
	buildTimeout        = 15 * time.Minute
	startSettleDelay    = 1200 * time.Millisecond
	maxBuildOutputBytes = 64 * 1024
)

// Status is the runtime state of one service.
type Status struct {
	Running bool   `json:"running"`
	Healthy bool   `json:"healthy"`
	PID     int    `json:"pid"`
	Managed bool   `json:"managed"`
	Detail  string `json:"detail,omitempty"`
}

// ChannelView summarizes the relay channel bound to a service.
type ChannelView struct {
	Registered bool   `json:"registered"`
	ID         int    `json:"id,omitempty"`
	Name       string `json:"name,omitempty"`
	Status     int    `json:"status,omitempty"`
	Models     int    `json:"models,omitempty"`
}

// ServiceView is the API view of one managed service.
type ServiceView struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	Description   string      `json:"description,omitempty"`
	Enabled       bool        `json:"enabled"`
	Workdir       string      `json:"workdir"`
	Command       string      `json:"command"`
	ManifestPath  string      `json:"manifest_path"`
	Host          string      `json:"host"`
	Port          int         `json:"port"`
	BaseURL       string      `json:"base_url"`
	HealthPath    string      `json:"health_path,omitempty"`
	PanelURL      string      `json:"panel_url,omitempty"`
	PanelEmbedURL string      `json:"panel_embed_url,omitempty"`
	LogFile       string      `json:"log_file"`
	BuildReady    bool        `json:"build_ready"`
	ModelPrefix   string      `json:"model_prefix,omitempty"`
	Priority      *int64      `json:"priority,omitempty"`
	Weight        *uint       `json:"weight,omitempty"`
	KeyMasked     string      `json:"key_masked,omitempty"`
	KeyError      string      `json:"key_error,omitempty"`
	Channel       ChannelView `json:"channel"`
	Status        Status      `json:"status"`
}

type childProcess struct {
	cmd       *exec.Cmd
	pid       int
	startedAt time.Time
}

// Manager owns the service definitions on disk and the child processes this
// relay instance started.
type Manager struct {
	hubRoot     string
	dataDir     string
	servicesDir string
	logsDir     string

	mu       sync.RWMutex
	services map[string]*Service
	loadErrs []string
	stamp    string

	procMu sync.Mutex
	procs  map[string]*childProcess
}

var (
	managerOnce sync.Once
	managerInst *Manager
)

// GetManager returns the process-wide manager singleton.
func GetManager() *Manager {
	managerOnce.Do(func() {
		dir := dataDirEnv()
		root := resolveHubRoot()
		managerInst = &Manager{
			hubRoot:     root,
			dataDir:     dir,
			servicesDir: filepath.Join(dir, "services"),
			logsDir:     filepath.Join(dir, "logs"),
			services:    map[string]*Service{},
			procs:       map[string]*childProcess{},
		}
	})
	return managerInst
}

// Init prepares the data layout, installs seed manifests and loads services.
func Init() {
	m := GetManager()
	if err := m.ensureLayout(); err != nil {
		logger.LogError(nil, fmt.Sprintf("reverse proxy manager: prepare data dir failed: %v", err))
		return
	}
	m.Load(true)
	m.mu.RLock()
	count := len(m.services)
	errs := append([]string(nil), m.loadErrs...)
	m.mu.RUnlock()
	logger.LogInfo(nil, fmt.Sprintf("reverse proxy manager: %d service manifest(s) loaded from %s", count, m.servicesDir))
	for _, e := range errs {
		logger.LogError(nil, "reverse proxy manager: manifest error: "+e)
	}

	// Auto-start services whose manifest is enabled, so a host boot brings the
	// whole hub up (build-on-demand included). They can still be stopped from
	// the panel as usual.
	m.mu.RLock()
	autoIDs := make([]string, 0, count)
	for id, svc := range m.services {
		if svc.IsEnabled() {
			autoIDs = append(autoIDs, id)
		}
	}
	m.mu.RUnlock()
	sort.Strings(autoIDs)
	for _, id := range autoIDs {
		go func(id string) {
			// A manifest can outlive its workdir (trimmed distribution builds,
			// a service removed by hand). Starting it would only produce a
			// confusing failure, so skip those quietly with an explainable line.
			if svc, ok := m.Get(id); ok {
				if info, err := os.Stat(svc.Workdir); err != nil || !info.IsDir() {
					logger.LogInfo(nil, fmt.Sprintf("reverse proxy auto-start: %s skipped, workdir %s does not exist in this build", id, svc.Workdir))
					return
				}
			}
			status, err := m.Start(id)
			switch {
			case err == nil:
				logger.LogInfo(nil, fmt.Sprintf("reverse proxy auto-start: %s started (pid %d)", id, status.PID))
			case status.Running:
				logger.LogInfo(nil, fmt.Sprintf("reverse proxy auto-start: %s already running on its port", id))
			default:
				logger.LogError(nil, fmt.Sprintf("reverse proxy auto-start: %s failed: %v", id, err))
			}
		}(id)
	}
	if len(autoIDs) > 0 {
		logger.LogInfo(nil, fmt.Sprintf("reverse proxy manager: auto-starting %d enabled service(s)", len(autoIDs)))
	}
}

// HubRoot is the base directory used to resolve relative workdir values.
func (m *Manager) HubRoot() string { return m.hubRoot }

// ServicesDir is the directory holding manifest files.
func (m *Manager) ServicesDir() string { return m.servicesDir }

// LogsDir is the directory holding captured process logs.
func (m *Manager) LogsDir() string { return m.logsDir }

// Load re-reads manifests. It skips the work when nothing on disk changed
// unless force is set.
func (m *Manager) Load(force bool) {
	stamp := m.dirStamp()
	m.mu.RLock()
	unchanged := !force && stamp != "" && stamp == m.stamp
	m.mu.RUnlock()
	if unchanged {
		return
	}
	services, errs := m.loadServices()
	m.mu.Lock()
	m.services = services
	m.loadErrs = errs
	m.stamp = stamp
	m.mu.Unlock()
}

// Reload forces a manifest reload (the hot-plug entry point).
func (m *Manager) Reload() {
	m.Load(true)
}

// dirStamp fingerprints the services directory so edits are picked up.
func (m *Manager) dirStamp() string {
	entries, err := os.ReadDir(m.servicesDir)
	if err != nil {
		return ""
	}
	parts := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if info, err := entry.Info(); err == nil {
			parts = append(parts, fmt.Sprintf("%s:%d:%d", entry.Name(), info.ModTime().UnixNano(), info.Size()))
			continue
		}
		parts = append(parts, entry.Name())
	}
	sort.Strings(parts)
	return strings.Join(parts, ";")
}

// Get returns one service by id.
func (m *Manager) Get(id string) (*Service, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	svc, ok := m.services[id]
	return svc, ok
}

// LoadErrors lists manifest files that failed to parse.
func (m *Manager) LoadErrors() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]string(nil), m.loadErrs...)
}

// LogFile returns the captured log path of a service.
func (m *Manager) LogFile(id string) string {
	return filepath.Join(m.logsDir, id+".log")
}

// ListViews returns the API view of every loaded service, sorted by id.
func (m *Manager) ListViews() []ServiceView {
	m.Load(false)
	m.mu.RLock()
	services := make([]*Service, 0, len(m.services))
	for _, svc := range m.services {
		services = append(services, svc)
	}
	m.mu.RUnlock()
	sort.Slice(services, func(i, j int) bool { return services[i].Manifest.ID < services[j].Manifest.ID })
	views := make([]ServiceView, 0, len(services))
	for _, svc := range services {
		views = append(views, m.ViewOf(svc))
	}
	return views
}

// ViewOf builds the API view of one service.
func (m *Manager) ViewOf(svc *Service) ServiceView {
	manifest := svc.Manifest
	view := ServiceView{
		ID:            manifest.ID,
		Name:          manifest.Name,
		Description:   manifest.Description,
		Enabled:       svc.IsEnabled(),
		Workdir:       svc.Workdir,
		ManifestPath:  svc.ManifestPath,
		Host:          svc.Host(),
		Port:          manifest.Port,
		BaseURL:       svc.BaseURL(),
		HealthPath:    manifest.HealthPath,
		PanelURL:      svc.PanelURL(),
		PanelEmbedURL: svc.PanelEmbedPath(),
		LogFile:       m.LogFile(manifest.ID),
		BuildReady:    svc.buildReady(),
		ModelPrefix:   svc.ModelPrefix(),
		Status:        m.Probe(svc),
		Channel:       m.ChannelViewOf(svc),
	}
	if manifest.Channel != nil {
		view.Priority = manifest.Channel.Priority
		view.Weight = manifest.Channel.Weight
	}
	if key, err := svc.ReadKey(); err != nil {
		view.KeyError = err.Error()
	} else {
		view.KeyMasked = MaskKey(key)
	}
	if manifest.Start != nil {
		view.Command = strings.Join(append([]string{manifest.Start.Command}, manifest.Start.Args...), " ")
	}
	return view
}

func (s *Service) buildReady() bool {
	manifest := s.Manifest
	if manifest.Build == nil || manifest.Build.SkipIfExists == "" {
		return true
	}
	_, err := os.Stat(filepath.Join(s.Workdir, manifest.Build.SkipIfExists))
	return err == nil
}

// Probe reports the runtime state of a service, including processes started
// outside this relay instance.
func (m *Manager) Probe(svc *Service) Status {
	status := Status{}
	addr := net.JoinHostPort(svc.Host(), strconv.Itoa(svc.Manifest.Port))
	conn, err := net.DialTimeout("tcp", addr, probeDialTimeout)
	if err == nil {
		_ = conn.Close()
		status.Running = true
	}
	if child := m.child(svc.Manifest.ID); child != nil {
		status.Managed = true
		status.PID = child.pid
	}
	if status.PID == 0 && status.Running {
		if pid, ok := portListenPID(svc.Manifest.Port); ok {
			status.PID = pid
		}
	}
	if !status.Running {
		status.Detail = fmt.Sprintf("port %d is not listening", svc.Manifest.Port)
		return status
	}
	if svc.Manifest.HealthPath == "" {
		status.Healthy = true
		return status
	}
	client := &http.Client{Timeout: probeHealthTimeout}
	resp, err := client.Get(svc.BaseURL() + svc.Manifest.HealthPath)
	if err != nil {
		status.Detail = "health check failed: " + err.Error()
		return status
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 200 && resp.StatusCode < 400 {
		status.Healthy = true
		return status
	}
	// The process is up but its health endpoint reports "not servable". For
	// every relay in this hub that means the same thing: no usable upstream
	// account yet. Say so, instead of leaving a bare HTTP code that reads like
	// a crash (503 is the normal reply here until you sign in).
	if resp.StatusCode == http.StatusServiceUnavailable || resp.StatusCode == http.StatusTooManyRequests {
		status.Detail = fmt.Sprintf("服务进程正常，等待登录上游账号（健康检查 HTTP %d）· open the service panel and sign in an account", resp.StatusCode)
		return status
	}
	status.Detail = fmt.Sprintf("health check returned HTTP %d", resp.StatusCode)
	return status
}

func (m *Manager) child(id string) *childProcess {
	m.procMu.Lock()
	defer m.procMu.Unlock()
	return m.procs[id]
}

// Start builds when needed and launches a service process.
func (m *Manager) Start(id string) (Status, error) {
	svc, ok := m.Get(id)
	if !ok {
		return Status{}, fmt.Errorf("service %q not found", id)
	}
	if !svc.IsEnabled() {
		return Status{}, fmt.Errorf("service %q is disabled in its manifest", id)
	}
	if status := m.Probe(svc); status.Running {
		return status, fmt.Errorf("service %q is already listening on port %d", id, svc.Manifest.Port)
	}
	if info, err := os.Stat(svc.Workdir); err != nil || !info.IsDir() {
		return Status{}, fmt.Errorf("workdir %s does not exist", svc.Workdir)
	}
	if svc.Manifest.Build != nil && !svc.buildReady() {
		if _, err := m.Build(id); err != nil {
			return Status{}, fmt.Errorf("build failed: %w", err)
		}
	}
	logPath := m.LogFile(id)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return Status{}, fmt.Errorf("open log file: %w", err)
	}
	defer logFile.Close()
	fmt.Fprintf(logFile, "\n=== %s started at %s ===\n", id, time.Now().Format(time.RFC3339))

	cmd := exec.Command(resolveCommand(svc.Workdir, svc.Manifest.Start.Command), svc.Manifest.Start.Args...)
	cmd.Dir = svc.Workdir
	cmd.Env = append(os.Environ(), manifestEnv(svc.Manifest.Env)...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = sysProcAttr()
	if err := cmd.Start(); err != nil {
		return Status{}, fmt.Errorf("start process: %w", err)
	}
	child := &childProcess{cmd: cmd, pid: cmd.Process.Pid, startedAt: time.Now()}
	m.procMu.Lock()
	m.procs[id] = child
	m.procMu.Unlock()
	go func() {
		err := cmd.Wait()
		m.procMu.Lock()
		if m.procs[id] == child {
			delete(m.procs, id)
		}
		m.procMu.Unlock()
		if err != nil {
			logger.LogError(nil, fmt.Sprintf("reverse proxy manager: service %s exited: %v", id, err))
		} else {
			logger.LogInfo(nil, fmt.Sprintf("reverse proxy manager: service %s exited", id))
		}
	}()
	time.Sleep(startSettleDelay)
	// Cold-start runtimes (Python/Node) can take several seconds past the
	// settle delay to bind their port; re-probe before declaring failure.
	var status Status
	for attempt := 0; ; attempt++ {
		status = m.Probe(svc)
		if status.Running || attempt >= 4 {
			break
		}
		time.Sleep(startSettleDelay)
	}
	if !status.Running {
		return status, fmt.Errorf("process started but port %d is not listening yet; check %s", svc.Manifest.Port, logPath)
	}
	return status, nil
}

func manifestEnv(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out
}

// resolveCommand makes an explicitly relative executable path in a manifest
// resolve against the service workdir instead of the relay's own directory.
func resolveCommand(workdir, command string) string {
	if strings.HasPrefix(command, "./") || strings.HasPrefix(command, ".\\") {
		return filepath.Join(workdir, command[2:])
	}
	return command
}

// Stop terminates a service process tree. It stops processes this relay
// instance started as well as processes resolved by listening port.
func (m *Manager) Stop(id string) error {
	svc, ok := m.Get(id)
	if !ok {
		return fmt.Errorf("service %q not found", id)
	}
	pid := 0
	if child := m.child(id); child != nil {
		pid = child.pid
	} else if resolved, ok := portListenPID(svc.Manifest.Port); ok {
		pid = resolved
	}
	if pid == 0 {
		return fmt.Errorf("service %q is not running", id)
	}
	killErr := killProcessTree(pid)
	deadline := time.Now().Add(stopWaitTimeout)
	for time.Now().Before(deadline) {
		if !m.Probe(svc).Running {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	if killErr != nil {
		return fmt.Errorf("stop pid %d: %w", pid, killErr)
	}
	return fmt.Errorf("port %d is still listening after %s", svc.Manifest.Port, stopWaitTimeout)
}

// Restart stops then starts a service.
func (m *Manager) Restart(id string) (Status, error) {
	svc, ok := m.Get(id)
	if !ok {
		return Status{}, fmt.Errorf("service %q not found", id)
	}
	if m.Probe(svc).Running {
		if err := m.Stop(id); err != nil {
			return Status{}, err
		}
	}
	return m.Start(id)
}

// Build runs the manifest build command and returns the captured output tail.
func (m *Manager) Build(id string) (string, error) {
	svc, ok := m.Get(id)
	if !ok {
		return "", fmt.Errorf("service %q not found", id)
	}
	if svc.Manifest.Build == nil || strings.TrimSpace(svc.Manifest.Build.Command) == "" {
		return "", fmt.Errorf("service %q has no build command", id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), buildTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, resolveCommand(svc.Workdir, svc.Manifest.Build.Command), svc.Manifest.Build.Args...)
	cmd.Dir = svc.Workdir
	cmd.Env = append(os.Environ(), manifestEnv(svc.Manifest.Env)...)
	output := &limitedBuffer{limit: maxBuildOutputBytes}
	cmd.Stdout = output
	cmd.Stderr = output
	start := time.Now()
	err := cmd.Run()
	elapsed := time.Since(start).Round(time.Millisecond)
	tail := output.Tail(maxBuildOutputBytes)
	m.appendLog(id, fmt.Sprintf("=== build finished in %s (error: %v) ===\n%s\n", elapsed, err, tail))
	if err != nil {
		return tail, fmt.Errorf("build command failed: %w", err)
	}
	return tail, nil
}

// appendLog appends text to the service log file.
func (m *Manager) appendLog(id, text string) {
	if err := os.MkdirAll(m.logsDir, 0o755); err != nil {
		return
	}
	file, err := os.OpenFile(m.LogFile(id), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer file.Close()
	_, _ = file.WriteString(text)
}

// TailLog returns the last n lines of a service log.
func (m *Manager) TailLog(id string, lines int) (string, error) {
	if _, ok := m.Get(id); !ok {
		return "", fmt.Errorf("service %q not found", id)
	}
	if lines <= 0 {
		lines = 200
	}
	if lines > 2000 {
		lines = 2000
	}
	data, err := os.ReadFile(m.LogFile(id))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	parts := strings.Split(text, "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n"), nil
}

// limitedBuffer keeps only the last limit bytes written.
type limitedBuffer struct {
	mu    sync.Mutex
	data  []byte
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if b.limit > 0 && len(b.data) > b.limit {
		b.data = b.data[len(b.data)-b.limit:]
	}
	return len(p), nil
}

func (b *limitedBuffer) Tail(limit int) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if limit > 0 && len(b.data) > limit {
		return string(b.data[len(b.data)-limit:])
	}
	return string(b.data)
}
