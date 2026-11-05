package pluginreg

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// PluginView is one installed plugin as the console lists it.
type PluginView struct {
	Spec      string   `json:"spec"`
	Name      string   `json:"name"`
	Version   string   `json:"version,omitempty"`
	Off       bool     `json:"off"`
	Providers []string `json:"providers,omitempty"`
	LoadError string   `json:"load_error,omitempty"`
	// Options are the values the plugin is handed as its second argument.
	Options map[string]any `json:"options,omitempty"`
	// Kind is "provider", "middleware", "agent", "tools" or "page", from
	// what the package declarea; empty when unknown.
	Kind string `json:"kind,omitempty"`
	// Update is the version npm has now, when it is newer than the
	// installed one.
	Update string `json:"update,omitempty"`
}

// Plugins lists what is installed, with each one's load state.
func Plugins(ctx context.Context) ([]PluginView, error) {
	l := pluginhost.Load()
	if len(l.Plugins) == 0 {
		return []PluginView{}, nil
	}
	loaded, _ := pluginhost.Plugins(ctx)
	bySpec := make(map[string]pluginhost.Loaded, len(loaded))
	for _, p := range loaded {
		bySpec[p.Spec] = p
	}
	out := make([]PluginView, 0, len(l.Plugins))
	for _, e := range l.Plugins {
		v := PluginView{
			Spec:    e.Spec,
			Name:    pluginhost.InstalledName(e.Spec),
			Version: pluginhost.Installed(e.Spec),
			Off:     e.Off,
			Options: e.Options,
			Kind:    kindOf(e.Spec),
		}
		if p, ok := bySpec[e.Spec]; ok {
			v.Providers = p.Provides
			v.LoadError = p.Error
		}
		out = append(out, v)
	}
	return out, nil
}

// kindOf says what a package is by its name, which is how the community
// names its packages: opencode-<x>-auth is a provider, middleware-<x> is
// gateway middleware, agent-<x> an agent and so on.
//
// The name is the package's own part, with its scope and version taken off:
// @magpie-community/agent-aider is "agent-aider", not "agent-aider" under a
// scope that happens to be searched too. Searching the whole spec would also
// match a scope whose name contains one of these words.
func kindOf(spec string) string {
	name := strings.ToLower(pluginhost.Name(spec))
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	if i := strings.Index(name, "@"); i > 0 {
		name = name[:i]
	}
	switch {
	case strings.Contains(name, "middleware"):
		return "middleware"
	case strings.HasSuffix(name, "-auth"), strings.Contains(name, "-auth-"):
		return "provider"
	case strings.HasPrefix(name, "agent-"):
		return "agent"
	case strings.HasPrefix(name, "tools-"):
		return "tools"
	case strings.HasPrefix(name, "page-"):
		return "page"
	}
	return ""
}

// Install adds a plugin: an npm package, a git repository or a path.
func Install(ctx context.Context, spec string) (PluginView, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return PluginView{}, fmt.Errorf("give a package, a repository or a path")
	}
	e, err := pluginhost.Add(ctx, spec)
	if err != nil {
		return PluginView{}, err
	}
	return PluginView{
		Spec:    e.Spec,
		Name:    pluginhost.InstalledName(e.Spec),
		Version: pluginhost.Installed(e.Spec),
	}, nil
}

// Uninstall takes a plugin out, and its sign-ins with it.
func Uninstall(ctx context.Context, spec string) error {
	return pluginhost.Remove(ctx, spec)
}

// SetOff turns a plugin off (its providers stop being offered) or on.
func SetOff(spec string, off bool) error {
	return pluginhost.SetOff(spec, off)
}

// SetOptions keeps the values a plugin is handed as its second argument.
func SetOptions(spec string, opts map[string]any) error {
	return pluginhost.SetOptions(spec, opts)
}

// UpdateInstalled updates every installed plugin that has a newer version.
func UpdateInstalled(ctx context.Context) error {
	return pluginhost.Update(ctx)
}

// UpgradeOne updates one plugin to the newest version npm has.
func UpgradeOne(ctx context.Context, spec string) error {
	return pluginhost.Upgrade(ctx, spec)
}

// MarketEntry is one plugin the community list suggests.
type MarketEntry struct {
	Package   string            `json:"package"`
	Name      string            `json:"name"`
	Icon      string            `json:"icon,omitempty"`
	Providers []string          `json:"providers,omitempty"`
	Community bool              `json:"community,omitempty"`
	Replaces  string            `json:"replaces,omitempty"`
	Kind      string            `json:"kind,omitempty"`
	Summary   map[string]string `json:"summary,omitempty"`
	// What npm says of it: the version to install, and the facts an
	// operator weighs before installing one — who published it, under what
	// license, how many use it, and where its source is.
	Version     string `json:"version,omitempty"`
	Description string `json:"description,omitempty"`
	Publisher   string `json:"publisher,omitempty"`
	License     string `json:"license,omitempty"`
	Homepage    string `json:"homepage,omitempty"`
	Repository  string `json:"repository,omitempty"`
	Weekly      int    `json:"weekly,omitempty"`
	Installed   bool   `json:"installed"`
	// InstalledVersion is what is here now, when it is.
	InstalledVersion string `json:"installed_version,omitempty"`
}

// Market is the community's plugin list with what npm says of each, and
// whether it is installed already. Provider plugins come first: an agent
// plugin or a gateway middleware does nothing for the relay.
func Market(ctx context.Context) []MarketEntry {
	listings := pluginhost.Market(ctx)
	names := make([]string, 0, len(listings))
	for _, l := range listings {
		names = append(names, l.Package)
	}
	info := pluginhost.Info(ctx, names)
	installed := map[string]string{}
	for _, e := range pluginhost.Load().Plugins {
		installed[pluginhost.Name(e.Spec)] = pluginhost.Installed(e.Spec)
	}
	out := make([]MarketEntry, 0, len(listings))
	for _, l := range listings {
		e := MarketEntry{
			Package: l.Package, Name: l.Name, Icon: l.Icon,
			Providers: l.Providers, Community: l.Community,
			Replaces: l.Replaces, Kind: l.Kind, Summary: l.Summary,
		}
		if n, ok := info[l.Package]; ok {
			e.Version = n.Version
			e.Description = n.Description
			e.Publisher = n.Publisher
			e.License = n.License
			e.Homepage = n.Homepage
			e.Repository = n.Repository
			e.Weekly = n.Weekly
		}
		if v, ok := installed[l.Package]; ok {
			e.Installed = true
			e.InstalledVersion = v
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		ai, aj := kindRank(out[i].Kind), kindRank(out[j].Kind)
		if ai != aj {
			return ai < aj
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// kindRank puts the plugins the relay can use first.
func kindRank(kind string) int {
	switch kind {
	case "":
		return 0 // a provider plugin
	case "middleware":
		return 1
	default:
		return 2
	}
}

// MarketSearch asks npm for plugins matching a word.
func MarketSearch(ctx context.Context, q string) ([]MarketEntry, error) {
	hits, err := pluginhost.Search(ctx, q)
	if err != nil {
		return nil, err
	}
	installed := map[string]string{}
	for _, e := range pluginhost.Load().Plugins {
		installed[pluginhost.Name(e.Spec)] = pluginhost.Installed(e.Spec)
	}
	out := make([]MarketEntry, 0, len(hits))
	for _, h := range hits {
		e := MarketEntry{
			Package: h.Package, Name: h.Package,
			Version: h.Version, Summary: map[string]string{"en": h.Description},
		}
		if v, ok := installed[h.Package]; ok {
			e.Installed = true
			e.InstalledVersion = v
		}
		out = append(out, e)
	}
	return out, nil
}

// HostState is what the console shows about the host itself.
type HostState struct {
	Enabled     bool   `json:"enabled"`
	Running     bool   `json:"running"`
	ConfigDir   string `json:"config_dir"`
	AuthPath    string `json:"auth_path"`
	ListPath    string `json:"list_path"`
	PluginCount int    `json:"plugin_count"`
	BunCached   bool   `json:"bun_cached"`
	NPMRegistry string `json:"npm_registry"`
	ChinaMirror bool   `json:"china_mirror"`
}

// Host reads the host's state.
func Host() HostState {
	s := pluginhost.ReadSettings()
	return HostState{
		Enabled:     s.Enabled,
		Running:     pluginhost.Running(),
		ConfigDir:   pluginhost.Dir(),
		AuthPath:    pluginhost.AuthPath(),
		ListPath:    pluginhost.ListPath(),
		PluginCount: len(pluginhost.Load().Plugins),
		BunCached:   pluginhost.HasBun(),
		NPMRegistry: s.NPMRegistry,
		ChinaMirror: s.ChinaMirror,
	}
}

// SetHost changes the host's own settings.
func SetHost(enabled *bool, npmRegistry *string, chinaMirror *bool) error {
	s := pluginhost.ReadSettings()
	if enabled != nil {
		s.Enabled = *enabled
	}
	if npmRegistry != nil {
		s.NPMRegistry = strings.TrimSpace(*npmRegistry)
	}
	if chinaMirror != nil {
		s.ChinaMirror = *chinaMirror
	}
	return pluginhost.SaveSettings(s)
}
