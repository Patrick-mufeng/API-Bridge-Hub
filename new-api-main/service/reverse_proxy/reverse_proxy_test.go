package reverse_proxy

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseManifestValidation(t *testing.T) {
	valid := `{
		"id": "demo",
		"name": "Demo",
		"workdir": "demo-dir",
		"start": {"command": "./demo.exe", "args": ["-config", "config.json"]},
		"port": 7999,
		"health_path": "/healthz",
		"panel": {"path": "/panel/", "api_prefix": "/panel/api/"},
		"key_source": {"type": "json", "path": "config.json", "field": "api_key"}
	}`
	manifest, err := ParseManifest([]byte(valid), "demo.json")
	require.NoError(t, err)
	assert.Equal(t, "demo", manifest.ID)
	assert.True(t, manifest.Enabled == nil)

	cases := []struct {
		name string
		body string
		file string
		want string
	}{
		{
			name: "id must match file name",
			body: `{"id":"other","name":"x","workdir":"w","start":{"command":"c"},"port":1}`,
			file: "demo.json",
			want: "must match the manifest file name",
		},
		{
			name: "start command is required",
			body: `{"id":"demo","name":"x","workdir":"w","port":1}`,
			file: "demo.json",
			want: "start.command is required",
		},
		{
			name: "port range is enforced",
			body: `{"id":"demo","name":"x","workdir":"w","start":{"command":"c"},"port":70000}`,
			file: "demo.json",
			want: "port must be between",
		},
		{
			name: "key source type is constrained",
			body: `{"id":"demo","name":"x","workdir":"w","start":{"command":"c"},"port":1,"key_source":{"type":"yaml","path":"a"}}`,
			file: "demo.json",
			want: "key_source.type must be",
		},
		{
			name: "panel path must be absolute and end with slash",
			body: `{"id":"demo","name":"x","workdir":"w","start":{"command":"c"},"port":1,"panel":{"path":"panel"}}`,
			file: "demo.json",
			want: "panel.path must start with /",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseManifest([]byte(tc.body), tc.file)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tc.want)
		})
	}
}

func TestReadKeySources(t *testing.T) {
	workdir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(workdir, "config.json"),
		[]byte(`{"listen":":7863","api_key":"sk-json-key"}`), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(workdir, ".env.local"),
		[]byte("# comment\nexport API_KEY=\"sk-env-key\"\nOTHER=x\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(workdir, "agent-key.txt"),
		[]byte("ozk_text_key\n"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(workdir, "keys.env"),
		[]byte("RELAY_API_KEYS=key-a,key-b, key-c\n"), 0o644))

	cases := []struct {
		name   string
		source *KeySource
		want   string
	}{
		{
			name:   "json field",
			source: &KeySource{Type: "json", Path: "config.json", Field: "api_key"},
			want:   "sk-json-key",
		},
		{
			name:   "env line with quotes",
			source: &KeySource{Type: "env", Path: ".env.local", Field: "API_KEY"},
			want:   "sk-env-key",
		},
		{
			name:   "text file trimmed",
			source: &KeySource{Type: "text", Path: "agent-key.txt"},
			want:   "ozk_text_key",
		},
		{
			name:   "comma list index",
			source: &KeySource{Type: "env", Path: "keys.env", Field: "RELAY_API_KEYS", Index: 1},
			want:   "key-b",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := &Service{Manifest: &Manifest{KeySource: tc.source}, Workdir: workdir}
			key, err := service.ReadKey()
			require.NoError(t, err)
			assert.Equal(t, tc.want, key)
		})
	}

	t.Run("missing field reports the path", func(t *testing.T) {
		service := &Service{
			Manifest: &Manifest{KeySource: &KeySource{Type: "json", Path: "config.json", Field: "nope"}},
			Workdir:  workdir,
		}
		_, err := service.ReadKey()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "nope")
	})
}

func TestRebasePanelBody(t *testing.T) {
	body := `const r = await fetch('/panel/api/' + path);`
	response := &http.Response{
		Header: http.Header{"Content-Type": []string{"application/javascript"}},
		Body:   io.NopCloser(strings.NewReader(body)),
	}
	require.NoError(t, rebasePanelBody(response, "/api/reverse_proxy/panel/workbuddy", []string{"/panel/"}))
	rewritten, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	text := string(rewritten)
	assert.Contains(t, text, `'/api/reverse_proxy/panel/workbuddy/panel/api/'`)
	assert.NotContains(t, text, `'/panel/api/`)
	assert.Equal(t, int64(len(rewritten)), response.ContentLength)

	html := `<a href="/panel/api/overview">overview</a>`
	htmlResponse := &http.Response{
		Header: http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:   io.NopCloser(strings.NewReader(html)),
	}
	require.NoError(t, rebasePanelBody(htmlResponse, "/api/reverse_proxy/panel/workbuddy", []string{"/panel/"}))
	rewrittenHTML, err := io.ReadAll(htmlResponse.Body)
	require.NoError(t, err)
	assert.Contains(t, string(rewrittenHTML), `href="/api/reverse_proxy/panel/workbuddy/panel/api/overview"`)

	untouched := &http.Response{
		Header: http.Header{"Content-Type": []string{"application/json"}},
		Body:   io.NopCloser(strings.NewReader(`{"path":"/panel/api/"}`)),
	}
	require.NoError(t, rebasePanelBody(untouched, "/api/reverse_proxy/panel/workbuddy", []string{"/panel/"}))
	jsonBody, err := io.ReadAll(untouched.Body)
	require.NoError(t, err)
	assert.Equal(t, `{"path":"/panel/api/"}`, string(jsonBody))
}

func TestRewritePrefixes(t *testing.T) {
	cases := []struct {
		name   string
		panel  *PanelSpec
		expect []string
	}{
		{
			name:   "subdirectory panel rebases its own root",
			panel:  &PanelSpec{Path: "/panel/"},
			expect: []string{"/panel/"},
		},
		{
			name:   "root panel declares its API prefix explicitly",
			panel:  &PanelSpec{Path: "/", RewritePrefixes: []string{"/v1/"}},
			expect: []string{"/v1/"},
		},
		{
			name:   "root panel without prefixes rebases nothing",
			panel:  &PanelSpec{Path: "/"},
			expect: nil,
		},
		{
			name:   "explicit prefixes win over the panel path",
			panel:  &PanelSpec{Path: "/console/", RewritePrefixes: []string{"/v1/", "/assets/"}},
			expect: []string{"/v1/", "/assets/"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			service := &Service{Manifest: &Manifest{Panel: tc.panel}}
			assert.Equal(t, tc.expect, service.RewritePrefixes())
		})
	}
}

func TestInjectPanelKeyScript(t *testing.T) {
	html := "<html><head><title>Console</title></head><body>hi</body></html>"
	response := &http.Response{
		Header: http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:   io.NopCloser(strings.NewReader(html)),
	}
	injectPanelKeyScript(response, "sk-cline-abc123", "")
	injected, err := io.ReadAll(response.Body)
	require.NoError(t, err)
	assert.Contains(t, string(injected), `window.__REVERSE_PROXY_PANEL__={"key":"sk-cline-abc123"}`)
	assert.Contains(t, string(injected), "</head>")
	assert.Equal(t, int64(len(injected)), response.ContentLength)

	t.Run("non-HTML responses are left untouched", func(t *testing.T) {
		jsonResponse := &http.Response{
			Header: http.Header{"Content-Type": []string{"application/json"}},
			Body:   io.NopCloser(strings.NewReader(`{"ok":true}`)),
		}
		injectPanelKeyScript(jsonResponse, "sk-cline-abc123", "")
		body, err := io.ReadAll(jsonResponse.Body)
		require.NoError(t, err)
		assert.Equal(t, `{"ok":true}`, string(body))
	})
}

func TestNamespacedModels(t *testing.T) {
	upstream := []string{"cn:glm-5.3", "global:gpt-5.6-sol"}

	t.Run("prefix namespaces exposed models and maps them back", func(t *testing.T) {
		service := &Service{Manifest: &Manifest{Channel: &ChannelSpec{ModelPrefix: "wb:"}}}
		exposed, mapping := service.NamespacedModels(upstream)
		assert.Equal(t, []string{"wb:cn:glm-5.3", "wb:global:gpt-5.6-sol"}, exposed)
		assert.Equal(t, map[string]string{
			"wb:cn:glm-5.3":         "cn:glm-5.3",
			"wb:global:gpt-5.6-sol": "global:gpt-5.6-sol",
		}, mapping)
	})

	t.Run("no prefix keeps upstream names and needs no mapping", func(t *testing.T) {
		service := &Service{Manifest: &Manifest{Channel: &ChannelSpec{}}}
		exposed, mapping := service.NamespacedModels(upstream)
		assert.Equal(t, upstream, exposed)
		assert.Empty(t, mapping)
	})

	t.Run("prefix keeps same-named services separately addressable", func(t *testing.T) {
		a := &Service{Manifest: &Manifest{Channel: &ChannelSpec{ModelPrefix: "wb:"}}}
		b := &Service{Manifest: &Manifest{Channel: &ChannelSpec{ModelPrefix: "qd:"}}}
		exposedA, _ := a.NamespacedModels([]string{"cn:glm-5.3"})
		exposedB, _ := b.NamespacedModels([]string{"cn:glm-5.3"})
		assert.Equal(t, "wb:cn:glm-5.3", exposedA[0])
		assert.Equal(t, "qd:cn:glm-5.3", exposedB[0])
		assert.NotEqual(t, exposedA[0], exposedB[0])
	})
}

func TestChannelSpecRoutingFields(t *testing.T) {
	body := `{
		"id": "demo", "name": "Demo", "workdir": "w",
		"start": {"command": "c"}, "port": 1,
		"channel": {"name": "Demo", "model_prefix": "wb:", "priority": 10, "weight": 5}
	}`
	manifest, err := ParseManifest([]byte(body), "demo.json")
	require.NoError(t, err)
	require.NotNil(t, manifest.Channel)
	assert.Equal(t, "wb:", manifest.Channel.ModelPrefix)
	require.NotNil(t, manifest.Channel.Priority)
	assert.Equal(t, int64(10), *manifest.Channel.Priority)
	require.NotNil(t, manifest.Channel.Weight)
	assert.Equal(t, uint(5), *manifest.Channel.Weight)
}

func TestMaskKeyAndResolveCommand(t *testing.T) {
	assert.Equal(t, "sk-a******1234", MaskKey("sk-abcd12341234"))
	assert.Equal(t, "****", MaskKey("abcd"))
	assert.Equal(t, "", MaskKey(""))

	assert.Equal(t,
		filepath.Join("C:\\hub", "svc", "bin", "app.exe"),
		resolveCommand("C:\\hub\\svc", ".\\bin\\app.exe"))
	assert.Equal(t, "go", resolveCommand("C:\\hub\\svc", "go"))
}
