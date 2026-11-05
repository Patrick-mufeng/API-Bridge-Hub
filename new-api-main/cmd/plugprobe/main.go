// Command plugprobe runs one plugin-host call from the terminal, so the
// host's contract can be checked without the hub: install a plugin, sign an
// account in, list its providers and models, and send one chat turn.
//
// It is the first thing the plugin host does in this repository, and the
// check that decides whether the rest of it is worth building: if a real
// vendor answers a streamed turn through a community plugin here, the relay
// can serve it too.
//
//	go run ./cmd/plugprobe list
//	go run ./cmd/plugprobe install @magpie-community/opencode-workbuddy-auth
//	go run ./cmd/plugprobe providers
//	go run ./cmd/plugprobe signin workbuddy
//	go run ./cmd/plugprobe accounts workbuddy
//	go run ./cmd/plugprobe chat workbuddy <model> [prompt]
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/pkg/pluginhost"
	"github.com/QuantumNous/new-api/pkg/pluginhost/support/settings"
)

func main() {
	flag.Parse()
	args := flag.Args()
	if len(args) == 0 {
		usageText()
		os.Exit(2)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	ctx, stop := context.WithTimeout(ctx, 10*time.Minute)
	defer stop()

	var err error
	switch args[0] {
	case "settings":
		err = showSettings()
	case "enable":
		err = setEnabled(true)
	case "disable":
		err = setEnabled(false)
	case "list":
		err = list()
	case "install":
		if len(args) < 2 {
			err = fmt.Errorf("install what? give an npm package, a git repo or a path")
			break
		}
		err = install(ctx, args[1])
	case "remove":
		if len(args) < 2 {
			err = fmt.Errorf("remove what? give the spec it was added as")
			break
		}
		err = remove(ctx, args[1])
	case "providers":
		err = providers(ctx, flag.Args()[1:])
	case "signin":
		if len(args) < 2 {
			err = fmt.Errorf("sign in to what? give a provider id")
			break
		}
		err = signin(ctx, args[1])
	case "accounts":
		if len(args) < 2 {
			err = fmt.Errorf("whose accounts? give a provider id")
			break
		}
		err = accounts(ctx, args[1])
	case "import":
		if len(args) < 3 {
			err = fmt.Errorf("import needs a provider and a JSON file: import <provider> <file>")
			break
		}
		err = importAuth(ctx, args[1], args[2])
	case "tools":
		if len(args) < 3 {
			err = fmt.Errorf("tools needs a provider id and a model: tools <provider> <model>")
			break
		}
		err = tools(ctx, args[1], args[2])
	case "usage":
		if len(args) < 2 {
			err = fmt.Errorf("usage needs a provider id")
			break
		}
		err = usageOf(ctx, args[1])
	case "chat":
		if len(args) < 3 {
			err = fmt.Errorf("chat needs a provider id and a model: chat <provider> <model> [prompt]")
			break
		}
		prompt := "Say hello in exactly five words."
		if len(args) > 3 {
			prompt = strings.Join(args[3:], " ")
		}
		err = chat(ctx, args[1], args[2], prompt)
	case "stop":
		pluginhost.EndHosts()
	default:
		usageText()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		pluginhost.EndHosts()
		os.Exit(1)
	}
	pluginhost.EndHosts()
}

func usageText() {
	fmt.Fprint(os.Stderr, `plugprobe — one plugin-host call from the terminal

  settings            show where the host keeps its files and what it is set to
  enable | disable    make plugins available, or not
  list                the plugins installed, and whether each loaded
  install <spec>      add a plugin: an npm package, github:owner/repo, or a path
  remove <spec>       take one out
  providers [id]      the providers the plugins offer, with their models
  accounts <id>       the accounts signed in to a provider
  signin <id>         sign in to a provider (browser, key, or desktop's own)
  import <id> <file>  keep a sign-in made elsewhere (an OpenCode auth entry)
  usage <id>          each account's allowance, as the plugin reports it
  tools <id> <model>  send a turn that must call a function, and check it did
  chat <id> <model>   send one streamed turn and print what comes back
  stop                stop the host this command started
`)
}

func showSettings() error {
	s := settings.Load()
	fmt.Println("config dir:", settings.Dir())
	fmt.Println("auth file: ", pluginhost.AuthPath())
	fmt.Println("plugins:   ", pluginhost.ListPath())
	b, _ := json.MarshalIndent(s, "", "  ")
	fmt.Println(string(b))
	return nil
}

func setEnabled(on bool) error {
	s := settings.Load()
	s.Enabled = on
	if err := settings.Save(s); err != nil {
		return err
	}
	fmt.Println("enabled:", on)
	return nil
}

func list() error {
	l := pluginhost.Load()
	if len(l.Plugins) == 0 {
		fmt.Println("no plugins installed")
		return nil
	}
	ps, err := pluginhost.Plugins(context.Background())
	for _, e := range l.Plugins {
		state := "on"
		if e.Off {
			state = "off"
		}
		line := fmt.Sprintf("%-58s %s", e.Spec, state)
		for _, l := range ps {
			if l.Spec != e.Spec {
				continue
			}
			if l.Error != "" {
				line += "  load error: " + l.Error
				break
			}
			line += "  → " + strings.Join(l.Provides, ", ")
		}
		fmt.Println(line)
	}
	if err != nil {
		fmt.Println("host:", err)
	}
	return nil
}

func install(ctx context.Context, spec string) error {
	e, err := pluginhost.Add(ctx, spec)
	if err != nil {
		return err
	}
	fmt.Println("installed", e.Spec)
	return nil
}

func remove(ctx context.Context, spec string) error {
	if err := pluginhost.Remove(ctx, spec); err != nil {
		return err
	}
	fmt.Println("removed", spec)
	return nil
}

func providers(ctx context.Context, only []string) error {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return err
	}
	for _, p := range ps {
		if len(only) > 0 && !contains(only, p.ID) && !contains(only, p.Spec) {
			continue
		}
		fmt.Printf("\n%s  (%s)\n  spec:    %s\n  npm:     %s\n  api:     %s\n", p.ID, p.Name, p.Spec, p.NPM, p.API)
		fmt.Printf("  signed in: %v", p.SignedIn)
		if p.AuthType != "" {
			fmt.Printf(" (%s)", p.AuthType)
		}
		fmt.Println()
		for _, m := range p.Methods {
			fmt.Printf("  method:  %s — %s\n", m.Type, m.Label)
		}
		fmt.Printf("  models:  %d\n", len(p.Models))
		for i, m := range p.Models {
			if i >= 12 {
				fmt.Printf("           … %d more\n", len(p.Models)-i)
				break
			}
			ctxWin := ""
			if m.Context > 0 {
				ctxWin = fmt.Sprintf(" ctx=%d", m.Context)
			}
			free := ""
			if m.Free {
				free = " free"
			}
			fmt.Printf("           %s%s%s\n", m.ID, ctxWin, free)
		}
	}
	return nil
}

func accounts(ctx context.Context, provider string) error {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return err
	}
	for _, p := range ps {
		if p.ID != provider {
			continue
		}
		fmt.Printf("%s: signed in %v (%s), %d models\n", p.ID, p.SignedIn, p.AuthType, len(p.Models))
		as := pluginhost.Auths(provider)
		for k, a := range as {
			fmt.Printf("  - %s  %v\n", k, a["type"])
		}
		if len(as) == 0 {
			fmt.Println("  (no accounts)")
		}
		return nil
	}
	return fmt.Errorf("no provider %q", provider)
}

func signin(ctx context.Context, provider string) error {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return err
	}
	var found *pluginhost.Provider
	for i := range ps {
		if ps[i].ID == provider {
			found = &ps[i]
			break
		}
	}
	if found == nil {
		return fmt.Errorf("no provider %q", provider)
	}
	if len(found.Methods) == 0 {
		return fmt.Errorf("%s offers no sign-in method", provider)
	}
	method := 0
	inputs := map[string]string{}
	for {
		pr, err := pluginhost.NextPrompt(ctx, provider, method, inputs)
		if err != nil {
			return err
		}
		if pr == nil {
			break
		}
		msg := pr.Message
		if len(pr.Options) > 0 {
			msg += " ("
			for i, o := range pr.Options {
				if i > 0 {
					msg += ", "
				}
				msg += fmt.Sprintf("%d=%s", i, o.Label)
			}
			msg += ", or the value)"
		}
		fmt.Printf("%s> ", msg)
		line := readLine()
		if len(pr.Options) > 0 {
			if n, ok := atoi(line); ok && n >= 0 && n < len(pr.Options) {
				line = pr.Options[n].Value
			}
		}
		inputs[pr.Key] = line
	}
	auth, err := pluginhost.Authorize(ctx, provider, method, inputs, "")
	if err != nil {
		return err
	}
	if auth.URL != "" {
		fmt.Println("open this page and finish signing in:")
		fmt.Println(" ", auth.URL)
	}
	if auth.Instructions != "" {
		fmt.Println(auth.Instructions)
	}
	if auth.Session == "" {
		// an "api" key or a sign-in that read the desktop app's own file
		// finishes at once: the host kept it
		fmt.Println("signed in")
		return nil
	}
	fmt.Println("waiting for the sign-in to finish…")
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
		saved, err := pluginhost.Finish(ctx, auth.Session, "")
		if err != nil {
			if strings.Contains(err.Error(), "pending") || strings.Contains(err.Error(), "authorize") {
				continue
			}
			return err
		}
		fmt.Printf("signed in: %s (%s)\n", saved.Account, saved.Provider)
		return nil
	}
}

func chat(ctx context.Context, provider, model, prompt string) error {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return err
	}
	var p *pluginhost.Provider
	var m *pluginhost.Model
	for i := range ps {
		if ps[i].ID != provider {
			continue
		}
		p = &ps[i]
		for j := range ps[i].Models {
			if ps[i].Models[j].ID == model {
				m = &ps[i].Models[j]
			}
		}
	}
	if p == nil {
		return fmt.Errorf("no provider %q", provider)
	}
	if m == nil {
		return fmt.Errorf("%s lists no model %q", provider, model)
	}
	// the model's own api.url says where it is served; a provider-wide base
	// would put a Claude model's /messages under the chat endpoint
	url := m.URL
	if url == "" {
		url = p.API
	}
	if url == "" {
		return fmt.Errorf("%s says no address for %s", provider, model)
	}
	if !strings.HasSuffix(strings.TrimRight(url, "/"), "/chat/completions") {
		url = strings.TrimRight(url, "/") + "/chat/completions"
	}
	body, _ := json.Marshal(map[string]any{
		"model":    model,
		"stream":   true,
		"messages": []map[string]any{{"role": "user", "content": prompt}},
	})
	fmt.Printf("POST %s\n  npm=%s\n\n", url, p.NPM)
	start := time.Now()
	resp, err := pluginhost.Fetch(ctx, pluginhost.FetchRequest{
		Provider: provider,
		Model:    model,
		NPM:      p.NPM,
		URL:      url,
		Method:   "POST",
		Headers:  map[string]string{"Content-Type": "application/json", "Accept": "text/event-stream"},
		Body:     body,
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	fmt.Printf("%s  (%s)\n\n", resp.Status, time.Since(start).Round(time.Millisecond))
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	// print the text as it streams, and the usage at the end
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	var text strings.Builder
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		for _, c := range chunk.Choices {
			if c.Delta.Content != "" {
				text.WriteString(c.Delta.Content)
				fmt.Print(c.Delta.Content)
			}
		}
		if chunk.Usage != nil {
			fmt.Printf("\n\nusage: prompt=%d completion=%d\n", chunk.Usage.PromptTokens, chunk.Usage.CompletionTokens)
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if text.Len() == 0 {
		fmt.Println("(no text came back)")
	}
	fmt.Printf("\n%d ms, %d runes\n", time.Since(start).Milliseconds(), text.Len())
	return nil
}

// importAuth keeps a sign-in made elsewhere as one of provider's accounts.
// The file holds one OpenCode auth entry: {"type":"oauth","access":…,
// "refresh":…,"expires":…,"accountId":…,"uid":…,"domain":…}, or
// {"type":"api","key":…}.
func importAuth(ctx context.Context, provider, file string) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var auth map[string]any
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.UseNumber()
	if err := dec.Decode(&auth); err != nil {
		return fmt.Errorf("read %s: %w", file, err)
	}
	if auth["type"] == nil {
		return fmt.Errorf("%s says no type: give \"oauth\" or \"api\"", file)
	}
	key, err := pluginhost.Import(ctx, provider, auth)
	if err != nil {
		return err
	}
	fmt.Printf("imported as %s (type %v)\n", key, auth["type"])
	return nil
}

// tools sends one turn with a function the model has to call, and reports
// what came back: the call's name and arguments, and whether it streamed.
// That is what an agent needs of a provider, and the part of a vendor's
// wire a plugin is most likely to get wrong.
func tools(ctx context.Context, provider, model string) error {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return err
	}
	var p *pluginhost.Provider
	var m *pluginhost.Model
	for i := range ps {
		if ps[i].ID != provider {
			continue
		}
		p = &ps[i]
		for j := range ps[i].Models {
			if ps[i].Models[j].ID == model {
				m = &ps[i].Models[j]
			}
		}
	}
	if p == nil || m == nil {
		return fmt.Errorf("no %s/%s", provider, model)
	}
	url := m.URL
	if url == "" {
		url = p.API
	}
	if !strings.HasSuffix(strings.TrimRight(url, "/"), "/chat/completions") {
		url = strings.TrimRight(url, "/") + "/chat/completions"
	}
	body, _ := json.Marshal(map[string]any{
		"model":  model,
		"stream": true,
		"messages": []map[string]any{
			{"role": "user", "content": "What is the weather in Shanghai? Use the tool."},
		},
		"tools": []map[string]any{{
			"type": "function",
			"function": map[string]any{
				"name":        "get_weather",
				"description": "The weather in a city",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{"city": map[string]any{"type": "string"}},
					"required":   []string{"city"},
				},
			},
		}},
		"tool_choice": "auto",
	})
	resp, err := pluginhost.Fetch(ctx, pluginhost.FetchRequest{
		Provider: provider, Model: model, NPM: p.NPM, URL: url, Method: "POST",
		Headers: map[string]string{"Content-Type": "application/json", "Accept": "text/event-stream"},
		Body:    body,
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("%s: %s", resp.Status, strings.TrimSpace(string(b)))
	}
	type call struct {
		Name string `json:"name"`
		Args string `json:"arguments"`
	}
	calls := map[int]*call{}
	var order []int
	text := strings.Builder{}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int `json:"index"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		for _, ch := range chunk.Choices {
			if ch.Delta.Content != "" {
				text.WriteString(ch.Delta.Content)
			}
			for _, tc := range ch.Delta.ToolCalls {
				c, ok := calls[tc.Index]
				if !ok {
					c = &call{}
					calls[tc.Index] = c
					order = append(order, tc.Index)
				}
				if tc.Function.Name != "" {
					c.Name = tc.Function.Name
				}
				c.Args += tc.Function.Arguments
			}
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	if len(order) == 0 {
		fmt.Printf("no tool call came back; text instead: %q\n", text.String())
		return fmt.Errorf("the model answered with text, not a tool call")
	}
	for _, i := range order {
		c := calls[i]
		fmt.Printf("tool call: %s(%s)\n", c.Name, c.Args)
		var check map[string]any
		if json.Unmarshal([]byte(c.Args), &check) != nil {
			return fmt.Errorf("the arguments are not JSON: %q", c.Args)
		}
	}
	return nil
}

// usageOf reads each account's allowance as the plugin tells it, which is
// what routing a hub does per account needs.
func usageOf(ctx context.Context, provider string) error {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return err
	}
	for _, p := range ps {
		if p.ID != provider {
			continue
		}
		fmt.Printf("%s: reports usage=%v checkin=%v renews=%v\n", p.ID, p.Usage, p.Checkin, p.Renews)
		for k := range pluginhost.Auths(provider) {
			u, err := pluginhost.AccountUsage(ctx, provider, k)
			if err != nil {
				fmt.Printf("  %s: %v\n", k, err)
				continue
			}
			b, _ := json.MarshalIndent(u, "  ", "  ")
			fmt.Printf("  %s: %s\n", k, string(b))
		}
		return nil
	}
	return fmt.Errorf("no provider %q", provider)
}

func readLine() string {
	r := bufio.NewReader(os.Stdin)
	s, _ := r.ReadString('\n')
	return strings.TrimSpace(s)
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

func atoi(s string) (int, bool) {
	n := 0
	if s == "" {
		return 0, false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, false
		}
		n = n*10 + int(r-'0')
	}
	return n, true
}
