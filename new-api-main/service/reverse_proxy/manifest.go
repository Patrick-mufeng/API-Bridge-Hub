// Package reverse_proxy implements the manifest-driven manager for the local
// reverse-proxy services that feed this relay: process lifecycle, status
// probing, channel registration, log tailing, and same-origin panel embedding.
//
// Every managed service is described by one JSON manifest under
// <data>/reverse-proxy/services/<id>.json. Plugging in a new service means
// dropping a manifest file and reloading — no code change is required.
package reverse_proxy

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
)

const (
	envDataDir = "REVERSE_PROXY_DATA_DIR"
	envHubRoot = "REVERSE_PROXY_HUB_ROOT"

	defaultHost = "127.0.0.1"
)

//go:embed seeds/*.json
var seedFS embed.FS

// Command is one executable invocation (build step or start command).
type Command struct {
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
	// SkipIfExists is a path relative to the service workdir. When the file
	// exists, the build step is skipped.
	SkipIfExists string `json:"skip_if_exists,omitempty"`
}

// PanelSpec describes how the service's own web console is embedded.
type PanelSpec struct {
	// Path is the upstream panel root, for example "/panel/".
	Path string `json:"path"`
	// APIPrefix marks upstream API calls that need the injected key.
	APIPrefix string `json:"api_prefix,omitempty"`
	// RewritePrefixes are absolute upstream path prefixes rebased onto the
	// proxy mount inside HTML/JS/CSS responses. Defaults to Path when unset.
	// Set this when the panel is served from "/" but its own API lives under a
	// deeper prefix such as "/v1/".
	RewritePrefixes []string `json:"rewrite_prefixes,omitempty"`
	// InjectKey attaches the service API key to panel API calls when the
	// browser did not send one.
	InjectKey bool `json:"inject_key,omitempty"`
	// InjectKeyScript injects a script exposing the service key to the page as
	// a global object, which panels that read a server-injected key (instead of
	// prompting for it) can pick up.
	InjectKeyScript bool `json:"inject_key_script,omitempty"`
	// KeyScriptGlobal overrides the injected global's name. Defaults to
	// __REVERSE_PROXY_PANEL__ (a { key } object); set it when the panel reads a
	// differently named global.
	KeyScriptGlobal string `json:"key_script_global,omitempty"`
	// BootRetryMs injects a small retry shim that re-runs the panel's own
	// startup data loaders after the document settles. Some panels load their
	// state once during boot and leave the view on a placeholder when that
	// first attempt loses a race with the embedding frame; re-invoking the
	// loaders avoids a 30-second stall until the panel's own poll fires.
	BootRetryMs int `json:"boot_retry_ms,omitempty"`
	// StripFrameHeaders removes X-Frame-Options / CSP from proxied responses
	// so the panel can be embedded in a same-origin iframe.
	StripFrameHeaders bool `json:"strip_frame_headers,omitempty"`
}

// KeySource describes where the service's client API key lives.
type KeySource struct {
	// Type is one of: json (object field), env (KEY=value line), text (whole file).
	Type string `json:"type"`
	// Path is absolute or relative to the service workdir.
	Path string `json:"path"`
	// Field is the JSON field name or the env variable name.
	Field string `json:"field,omitempty"`
	// Index picks one value from a comma-separated list (0-based).
	Index int `json:"index,omitempty"`
}

// ChannelSpec describes the relay channel this service should register as.
type ChannelSpec struct {
	Name  string `json:"name"`
	Tag   string `json:"tag,omitempty"`
	Group string `json:"group,omitempty"`
	// ModelPrefix namespaces this service's models in the relay, so services that
	// expose the same upstream model name stay separately addressable instead of
	// being load-balanced together. The prefix is applied to the registered
	// model list and undone upstream through the channel's model mapping.
	ModelPrefix string `json:"model_prefix,omitempty"`
	// Priority and Weight steer relay routing when the same exposed model is
	// offered by several channels. Channels on a higher priority are used first;
	// equal priorities share traffic by weight.
	Priority *int64 `json:"priority,omitempty"`
	Weight   *uint  `json:"weight,omitempty"`
}

// Manifest is the on-disk description of one reverse-proxy service.
type Manifest struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description,omitempty"`
	Enabled     *bool             `json:"enabled,omitempty"`
	Workdir     string            `json:"workdir"`
	Build       *Command          `json:"build,omitempty"`
	Start       *Command          `json:"start"`
	Env         map[string]string `json:"env,omitempty"`
	Host        string            `json:"host,omitempty"`
	Port        int               `json:"port"`
	HealthPath  string            `json:"health_path,omitempty"`
	Panel       *PanelSpec        `json:"panel,omitempty"`
	KeySource   *KeySource        `json:"key_source,omitempty"`
	Channel     *ChannelSpec      `json:"channel,omitempty"`
}

// Service is a loaded manifest with its paths resolved.
type Service struct {
	Manifest     *Manifest
	ManifestPath string
	Workdir      string
}

func (s *Service) IsEnabled() bool {
	return s.Manifest.Enabled == nil || *s.Manifest.Enabled
}

func (s *Service) Host() string {
	if host := strings.TrimSpace(s.Manifest.Host); host != "" {
		return host
	}
	return defaultHost
}

func (s *Service) BaseURL() string {
	return "http://" + s.Host() + ":" + strconv.Itoa(s.Manifest.Port)
}

// PanelURL returns the service's own panel URL for direct (new tab) access.
func (s *Service) PanelURL() string {
	if s.Manifest.Panel == nil || s.Manifest.Panel.Path == "" {
		return ""
	}
	return s.BaseURL() + s.Manifest.Panel.Path
}

// PanelEmbedPath returns the same-origin path served by the relay's panel proxy.
func (s *Service) PanelEmbedPath() string {
	if s.Manifest.Panel == nil || s.Manifest.Panel.Path == "" {
		return ""
	}
	return PanelMount(s.Manifest.ID) + s.Manifest.Panel.Path
}

func (s *Service) ChannelTag() string {
	if s.Manifest.Channel != nil && strings.TrimSpace(s.Manifest.Channel.Tag) != "" {
		return strings.TrimSpace(s.Manifest.Channel.Tag)
	}
	return "reverse-proxy:" + s.Manifest.ID
}

func (s *Service) ChannelName() string {
	if s.Manifest.Channel != nil && strings.TrimSpace(s.Manifest.Channel.Name) != "" {
		return strings.TrimSpace(s.Manifest.Channel.Name)
	}
	return s.Manifest.Name
}

func (s *Service) ChannelGroup() string {
	if s.Manifest.Channel != nil && strings.TrimSpace(s.Manifest.Channel.Group) != "" {
		return strings.TrimSpace(s.Manifest.Channel.Group)
	}
	return "default"
}

// ModelPrefix is the namespace applied to this service's relay model names.
func (s *Service) ModelPrefix() string {
	if s.Manifest.Channel == nil {
		return ""
	}
	return strings.TrimSpace(s.Manifest.Channel.ModelPrefix)
}

// NamespacedModels maps the service's upstream model list onto the names
// exposed by the relay together with the reverse mapping that restores the
// upstream name on the way out.
func (s *Service) NamespacedModels(models []string) (exposed []string, mapping map[string]string) {
	prefix := s.ModelPrefix()
	mapping = map[string]string{}
	for _, model := range models {
		name := model
		if prefix != "" {
			name = prefix + model
			mapping[name] = model
		}
		exposed = append(exposed, name)
	}
	return exposed, mapping
}

// PanelMount is the relay path prefix that proxies one service's panel.
func PanelMount(serviceID string) string {
	return "/api/reverse_proxy/panel/" + serviceID
}

// RewritePrefixes returns the absolute upstream prefixes that must be rebased
// onto the proxy mount inside panel responses. When the manifest declares none,
// the panel root itself is the only prefix to rebase, which is the behavior for
// panels served from a dedicated subdirectory.
func (s *Service) RewritePrefixes() []string {
	if s.Manifest.Panel == nil {
		return nil
	}
	if len(s.Manifest.Panel.RewritePrefixes) > 0 {
		return s.Manifest.Panel.RewritePrefixes
	}
	if s.Manifest.Panel.Path != "" && s.Manifest.Panel.Path != "/" {
		return []string{s.Manifest.Panel.Path}
	}
	return nil
}

// ParseManifest decodes and validates one manifest document.
func ParseManifest(data []byte, fileName string) (*Manifest, error) {
	var manifest Manifest
	if err := common.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if err := manifest.validate(fileName); err != nil {
		return nil, err
	}
	return &manifest, nil
}

func (m *Manifest) validate(fileName string) error {
	if strings.TrimSpace(m.ID) == "" {
		return fmt.Errorf("id is required")
	}
	if fileName != "" && m.ID != strings.TrimSuffix(fileName, ".json") {
		return fmt.Errorf("id %q must match the manifest file name %q", m.ID, fileName)
	}
	if m.Port < 1 || m.Port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	if strings.TrimSpace(m.Workdir) == "" {
		return fmt.Errorf("workdir is required")
	}
	if m.Start == nil || strings.TrimSpace(m.Start.Command) == "" {
		return fmt.Errorf("start.command is required")
	}
	if m.Panel != nil {
		// Only a leading slash is required: panels live both at directory roots
		// ("/panel/") and at named routes ("/web/login"), and the proxy forwards
		// whatever the browser requested under the mount.
		if m.Panel.Path != "" && !strings.HasPrefix(m.Panel.Path, "/") {
			return fmt.Errorf("panel.path must start with /")
		}
		for _, prefix := range m.Panel.RewritePrefixes {
			// Only the leading slash is required: panels use both directory-shaped
			// prefixes ("/panel/") and bare API prefixes ("/api"), and rebasing
			// "…/api" also covers "…/api/..." variants.
			if !strings.HasPrefix(prefix, "/") {
				return fmt.Errorf("panel.rewrite_prefixes entries must start with /")
			}
		}
	}
	if m.KeySource != nil {
		switch m.KeySource.Type {
		case "json", "env", "text":
		default:
			return fmt.Errorf("key_source.type must be json, env or text")
		}
		if strings.TrimSpace(m.KeySource.Path) == "" {
			return fmt.Errorf("key_source.path is required")
		}
		if m.KeySource.Type != "text" && strings.TrimSpace(m.KeySource.Field) == "" {
			return fmt.Errorf("key_source.field is required for type %s", m.KeySource.Type)
		}
	}
	return nil
}

// dataDirEnv returns the manager data directory, overridable for tests.
func dataDirEnv() string {
	if dir := strings.TrimSpace(os.Getenv(envDataDir)); dir != "" {
		return dir
	}
	return filepath.Join("data", "reverse-proxy")
}

// resolveHubRoot picks the directory that relative workdir values resolve against.
func resolveHubRoot() string {
	if root := strings.TrimSpace(os.Getenv(envHubRoot)); root != "" {
		if abs, err := filepath.Abs(root); err == nil {
			return abs
		}
		return root
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	parent := filepath.Dir(cwd)
	if parent == "" {
		return cwd
	}
	return parent
}

// ensureLayout creates the data directories and installs seed manifests that
// do not exist yet. Existing files are never overwritten.
func (m *Manager) ensureLayout() error {
	if err := os.MkdirAll(m.servicesDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(m.logsDir, 0o755); err != nil {
		return err
	}
	entries, err := seedFS.ReadDir("seeds")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		target := filepath.Join(m.servicesDir, entry.Name())
		if _, err := os.Stat(target); err == nil {
			continue
		}
		content, err := seedFS.ReadFile("seeds/" + entry.Name())
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, content, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// loadServices reads every manifest from the services directory.
func (m *Manager) loadServices() (map[string]*Service, []string) {
	services := map[string]*Service{}
	var loadErrs []string
	entries, err := os.ReadDir(m.servicesDir)
	if err != nil {
		return services, []string{fmt.Sprintf("read services dir: %v", err)}
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	for _, name := range names {
		path := filepath.Join(m.servicesDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			loadErrs = append(loadErrs, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		manifest, err := ParseManifest(data, name)
		if err != nil {
			loadErrs = append(loadErrs, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		services[manifest.ID] = &Service{
			Manifest:     manifest,
			ManifestPath: path,
			Workdir:      m.resolveWorkdir(manifest.Workdir),
		}
	}
	return services, loadErrs
}

func (m *Manager) resolveWorkdir(workdir string) string {
	if filepath.IsAbs(workdir) {
		return filepath.Clean(workdir)
	}
	return filepath.Join(m.hubRoot, workdir)
}
