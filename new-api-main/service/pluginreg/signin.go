package pluginreg

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
)

// MethodView is one way a provider can be signed in to.
type MethodView struct {
	Index       int    `json:"index"`
	Type        string `json:"type"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder,omitempty"`
	KeyTitle    string `json:"key_title,omitempty"`
	// Keyless says the method needs no key typed: authorize supplies the
	// credential. A dialog that asks for one anyway is a dead end.
	Keyless bool `json:"keyless,omitempty"`
}

// AccountView is one account signed in to a provider.
type AccountView struct {
	Key       string `json:"key"`
	Type      string `json:"type"`
	AccountID string `json:"account_id,omitempty"`
	// Label is what the console shows: the account's own name when the
	// plugin kept one, else the end of its key.
	Label string `json:"label"`
	// Enterprise is the team an account belongs to, when the plugin says.
	Enterprise string `json:"enterprise,omitempty"`
	// Expires is when the sign-in ends, in Unix milliseconds, 0 unknown.
	Expires int64 `json:"expires,omitempty"`
	// NeedsSignIn is set when the plugin reported the sign-in lapsed.
	NeedsSignIn bool `json:"needs_sign_in,omitempty"`
	// Models are the model ids this account alone has, when the plugin
	// splits a provider's list between its accounts; FellBack and ListError
	// are that list's own fallback, as on the provider.
	Models    []string `json:"models,omitempty"`
	FellBack  bool     `json:"fell_back,omitempty"`
	ListError string   `json:"list_error,omitempty"`

	// Plan is the subscription card's name, when the plugin reports one.
	Plan string `json:"plan,omitempty"`
	// SignIn is the plugin's own word: "kept", "expired", or "" for nothing said.
	SignIn string `json:"sign_in,omitempty"`
	// Error is why the plugin says the account is not usable.
	Error string `json:"error,omitempty"`
	// Windows are the account's allowance windows: the numbers its vendor
	// counts against, which is what an operator picks an account by.
	Windows []QuotaWindowView `json:"windows,omitempty"`
	// Resets is the rate-limit resets the account may still spend, when the
	// vendor hands them out.
	Resets int `json:"resets,omitempty"`
	// ChannelID and KeyIndex are where this account is served from: the
	// channel it is a key of, and its place in that key list. 0 and -1 when
	// it is not registered.
	ChannelID int `json:"channel_id,omitempty"`
	KeyIndex  int `json:"key_index"`
	// ChannelOn is whether that channel is serving requests now.
	ChannelOn bool `json:"channel_on,omitempty"`
	// KeyOn is whether this account's own key is enabled in that channel's
	// pool. A pooled channel stays on while any of its keys works, so this
	// is what says whether *this* account is being used.
	KeyOn bool `json:"key_on"`
}

// QuotaWindowView is one allowance window as the console draws it: a name, a
// bar from Used to 100, and when it starts over.
// QuotaWindowView is one allowance the plugin reports, as the console shows
// it.
//
// It carries every field the plugin contract gives a window, not only the
// ones this console happens to draw: a view that drops what it does not use
// loses the data for every plugin that reports it, and the console cannot
// learn to draw a field it was never sent. Balance is a prepaid wallet's
// reading, RunsOut the credits that expire before the window resets, Models
// the models a window is limited to — each drew a console wrong when it
// arrived empty, and none is the same as a zero.
type QuotaWindowView struct {
	Name      string   `json:"name"`
	Used      float64  `json:"used"`
	Limit     float64  `json:"limit,omitempty"`
	Amount    float64  `json:"amount,omitempty"`
	Unit      string   `json:"unit,omitempty"`
	Display   string   `json:"display,omitempty"`
	ResetsAt  string   `json:"resets_at,omitempty"`
	ResetSecs int64    `json:"reset_secs,omitempty"`
	Span      float64  `json:"span,omitempty"`
	Model     string   `json:"model,omitempty"`
	Models    []string `json:"models,omitempty"`
	NotModels []string `json:"not_models,omitempty"`
	Aside     bool     `json:"aside,omitempty"`
	RunsOutAt string   `json:"runs_out_at,omitempty"`
	RunsOut   float64  `json:"runs_out,omitempty"`
	Balance   *float64 `json:"balance,omitempty"`
}

// Detail is one provider as the console's detail panel shows it.
type Detail struct {
	Provider string        `json:"provider"`
	Name     string        `json:"name"`
	APIRoot  string        `json:"api_root,omitempty"`
	NPM      string        `json:"npm,omitempty"`
	SignedIn bool          `json:"signed_in"`
	Accounts []AccountView `json:"accounts"`
	Methods  []MethodView  `json:"methods"`
	// Usage, Checkin and Renews say what the plugin's hooks do.
	Usage   bool `json:"usage"`
	Checkin bool `json:"checkin"`
	Renews  bool `json:"renews"`
	// Models is the provider's list, with what the console needs to show it.
	Models []ModelView `json:"models"`
	// Prefix is the namespace its models are served under. Empty means the
	// channels registered for this provider carry the vendor's own ids with
	// no namespace — a channel made before names were namespaced — so the
	// console says so rather than showing a name no client can use.
	Prefix string `json:"prefix,omitempty"`
	// Options are the switches the plugin declares for it.
	Options []OptionView `json:"options,omitempty"`
	// FellBack says the plugin's models hook could not reach its vendor and
	// gave a default list back, and ListError is why: the console says the
	// short list is a fallback rather than showing it as the vendor's own.
	FellBack  bool   `json:"fell_back,omitempty"`
	ListError string `json:"list_error,omitempty"`
	// Icon is the picture the plugin gives its provider: an https URL or a
	// data: URI. A console that ignores it draws every vendor alike.
	Icon string `json:"icon,omitempty"`
	// MaxConcurrency is how many requests the plugin says one account takes
	// at once, MaxAccounts how many accounts it takes at once: the two
	// numbers that explain a 429 that is not the vendor's.
	MaxConcurrency int `json:"max_concurrency,omitempty"`
	MaxAccounts    int `json:"max_accounts,omitempty"`
}

// ModelView is one model of a provider.
type ModelView struct {
	ID string `json:"id"`
	// RelayName is what a client asks this hub for: the provider's namespace
	// and the model id, or the bare id when the channel serves it unnamespaced.
	// Without it the console shows "glm-5.3" beside a channel that answers
	// "workbuddy-glm-5.3", and the operator copies the wrong one.
	RelayName string  `json:"relay_name,omitempty"`
	Name      string  `json:"name,omitempty"`
	Context   int     `json:"context,omitempty"`
	Output    int     `json:"output,omitempty"`
	Free      bool    `json:"free,omitempty"`
	Rate      float64 `json:"rate,omitempty"`
	Reasoning bool    `json:"reasoning,omitempty"`
	Image     bool    `json:"image,omitempty"`
	// Price is the model's cost per million tokens, when the plugin says.
	Price *PriceView `json:"price,omitempty"`
	// Variants are the thinking depths the vendor offers this model at
	// ("low", "high"); asking for one is a suffix on the model id, so they
	// are names a client can ask for, not a note.
	Variants []string `json:"variants,omitempty"`
	// RateWas is what a request cost before the discount running now: the
	// two together are how a model is priced ("x0.03, was x0.06").
	RateWas float64 `json:"rate_was,omitempty"`
	// Fast says the vendor serves this model faster when asked to.
	Fast bool `json:"fast,omitempty"`
	// Searches says the model searches the web by itself.
	Searches bool `json:"searches,omitempty"`
}

// PriceView is a model's price in USD per million tokens.
type PriceView struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cache_read,omitempty"`
	CacheWrite float64 `json:"cache_write,omitempty"`
}

// OptionView is a switch a plugin declares for its provider.
type OptionView struct {
	Key          string            `json:"key"`
	Label        string            `json:"label,omitempty"`
	Description  string            `json:"description,omitempty"`
	Labels       map[string]string `json:"labels,omitempty"`
	Descriptions map[string]string `json:"descriptions,omitempty"`
	// Value is the switch as the user has it now.
	Value   bool `json:"value"`
	Default bool `json:"default"`
	// FiltersModels says turning it on narrows the model list.
	FiltersModels bool   `json:"filters_models,omitempty"`
	Confirm       string `json:"confirm,omitempty"`
}

// ProviderDetail reads one provider as the console shows it.
func ProviderDetail(ctx context.Context, id string) (*Detail, error) {
	ps, err := pluginhost.Providers(ctx)
	if err != nil {
		return nil, err
	}
	var p *pluginhost.Provider
	for i := range ps {
		if ps[i].ID == id {
			p = &ps[i]
			break
		}
	}
	if p == nil {
		return nil, fmt.Errorf("no installed plugin serves the provider %q", id)
	}
	d := &Detail{
		Provider: p.ID, Name: p.Name, APIRoot: p.API, NPM: p.NPM,
		SignedIn: p.SignedIn, Usage: p.Usage, Checkin: p.Checkin, Renews: p.Renews,
		Icon: p.Icon, MaxConcurrency: p.MaxConcurrency, MaxAccounts: p.MaxAccounts,
	}
	for i, m := range p.Methods {
		v := MethodView{
			Index: i, Type: m.Type, Label: m.Label,
			Placeholder: m.Placeholder, Keyless: m.Keyless,
		}
		if m.Type == "api" {
			v.KeyTitle = m.KeyTitle(p.Name)
		}
		d.Methods = append(d.Methods, v)
	}
	auths := pluginhost.Auths(p.ID)
	keys := make([]string, 0, len(auths))
	for k := range auths {
		keys = append(keys, k)
	}
	sortStrings(keys)
	for _, k := range keys {
		a := auths[k]
		v := AccountView{Key: k, Label: accountLabel(k, a)}
		// the provider's own record of this account, when the plugin splits
		// its model list between accounts
		for _, ac := range p.Accounts {
			if ac.Key != k {
				continue
			}
			v.Models = ac.Models
			v.FellBack = ac.FellBack
			v.ListError = ac.ListError
			break
		}
		v.Type, _ = a["type"].(string)
		v.AccountID, _ = a["accountId"].(string)
		v.Enterprise, _ = a["enterpriseId"].(string)
		if n, ok := a["expires"].(float64); ok {
			v.Expires = int64(n)
		}
		// where this account is served from, and what its vendor says of it
		attachAccountUsage(ctx, p.ID, k, &v)
		d.Accounts = append(d.Accounts, v)
	}
	prefix := registeredPrefix(p.ID)
	d.Prefix = prefix
	d.FellBack = p.FellBack
	d.ListError = p.ListError
	for _, m := range p.Models {
		relay := m.ID
		if prefix != "" {
			relay = ProviderModelName(prefix, m.ID)
		}
		mv := ModelView{
			ID: m.ID, RelayName: relay,
			Name: m.Name, Context: m.Context, Output: m.Output,
			Free: m.Free, Rate: m.Rate, Reasoning: m.Reasoning, Image: m.Image,
			Variants: m.Variants, RateWas: m.RateWas,
			Fast: m.Fast, Searches: m.Searches,
		}
		if m.Cost != nil {
			mv.Price = &PriceView{
				Input: m.Cost.Input, Output: m.Cost.Output,
				CacheRead: m.Cost.Cache.Read, CacheWrite: m.Cost.Cache.Write,
			}
		}
		d.Models = append(d.Models, mv)
	}
	chosen := pluginhost.ChosenOptions()
	for _, o := range p.Options {
		d.Options = append(d.Options, OptionView{
			Key: o.Key, Label: o.Label, Description: o.Description,
			Labels: o.Labels, Descriptions: o.Descriptions,
			Value:         pluginhost.OptionOn(chosen, p.ID, o),
			Default:       o.Default,
			FiltersModels: o.FiltersModels,
			Confirm:       o.Confirm,
		})
	}
	return d, nil
}

func accountLabel(key string, a map[string]any) string {
	for _, f := range []string{"accountId", "name", "email"} {
		if s, ok := a[f].(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	if i := strings.Index(key, "#"); i >= 0 && i+1 < len(key) {
		return key[i+1:]
	}
	return key
}

func sortStrings(xs []string) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j] < xs[j-1]; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}

// SignInStart begins a sign-in: the questions the method asks first, and
// then either a page to open (OAuth) or the saved account (a key).
type SignInStart struct {
	// Prompt is the next question, when the method asks any more.
	Prompt *PromptView `json:"prompt,omitempty"`
	// Session is an OAuth sign-in under way: poll Finish with it.
	Session      string `json:"session,omitempty"`
	URL          string `json:"url,omitempty"`
	Instructions string `json:"instructions,omitempty"`
	Method       string `json:"method,omitempty"`
	// Saved is set when the sign-in finished at once.
	Saved *AccountView `json:"saved,omitempty"`
}

// PromptView is a question a sign-in method asks.
type PromptView struct {
	Type        string         `json:"type"`
	Key         string         `json:"key"`
	Message     string         `json:"message"`
	Placeholder string         `json:"placeholder,omitempty"`
	Options     []PromptOption `json:"options,omitempty"`
}

// PromptOption is one choice of a select question.
type PromptOption struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Hint  string `json:"hint,omitempty"`
}

// SignIn begins (or continues) a sign-in to a provider. inputs holds the
// answers given so far; when the method asks another question, Prompt says
// which, and the caller asks it and calls again.
func SignIn(ctx context.Context, provider string, method int, inputs map[string]string, account string) (*SignInStart, error) {
	if inputs == nil {
		inputs = map[string]string{}
	}
	next, err := pluginhost.NextPrompt(ctx, provider, method, inputs)
	if err != nil {
		return nil, err
	}
	if next != nil {
		v := &PromptView{Type: next.Type, Key: next.Key, Message: next.Message, Placeholder: next.Placeholder}
		for _, o := range next.Options {
			v.Options = append(v.Options, PromptOption{Label: o.Label, Value: o.Value, Hint: o.Hint})
		}
		return &SignInStart{Prompt: v}, nil
	}
	auth, err := pluginhost.Authorize(ctx, provider, method, inputs, account)
	if err != nil {
		return nil, err
	}
	out := &SignInStart{
		Session: auth.Session, URL: auth.URL,
		Instructions: auth.Instructions, Method: auth.Method,
	}
	if auth.Session == "" {
		// a key, or the desktop app's own sign-in, which finishes at once
		if saved, err := savedAccount(provider); err == nil {
			out.Saved = saved
		}
	}
	return out, nil
}

// SignInKey signs in with an API key, for a method of type "api".
func SignInKey(ctx context.Context, provider string, method int, inputs map[string]string, key, account string) (*AccountView, error) {
	saved, err := pluginhost.APIKey(ctx, provider, method, inputs, key, account)
	if err != nil {
		return nil, err
	}
	return &AccountView{Key: saved.Account, Label: saved.Account, Type: "api"}, nil
}

// SignInFinish asks whether an OAuth sign-in has finished. done is false
// while the plugin still waits for the page.
func SignInFinish(ctx context.Context, provider, session string) (acc *AccountView, done bool, err error) {
	saved, err := pluginhost.Finish(ctx, session, "")
	if err != nil {
		if errors.Is(err, pluginhost.ErrFailed) {
			return nil, false, err
		}
		// the plugin is still waiting for the page: not an error
		return nil, false, nil
	}
	return &AccountView{Key: saved.Account, Label: saved.Account}, true, nil
}

// savedAccount reads the account a finished sign-in left behind.
func savedAccount(provider string) (*AccountView, error) {
	auths := pluginhost.Auths(provider)
	if len(auths) == 0 {
		return nil, fmt.Errorf("the plugin kept no account")
	}
	keys := make([]string, 0, len(auths))
	for k := range auths {
		keys = append(keys, k)
	}
	sortStrings(keys)
	k := keys[0]
	return &AccountView{Key: k, Label: accountLabel(k, auths[k]), Type: authValue(auths[k])}, nil
}

func authValue(a map[string]any) string {
	s, _ := a["type"].(string)
	return s
}

// AccountModels lists the models one account has and whether it works: the
// plugin is asked, which is what a "test this account" button does.
func AccountModels(ctx context.Context, provider, account string) ([]string, error) {
	checked, err := pluginhost.Check(ctx, provider, account)
	if err != nil {
		return nil, err
	}
	return checked.Models, nil
}

// attachAccountUsage fills in what an account's vendor reports of it: the
// allowance windows, the plan, and whether its sign-in still stands.
//
// Every field is optional. A vendor that reports nothing leaves them empty,
// and the console shows the account without numbers rather than not showing
// it at all: an account is signed in whether or not its vendor tells us how
// much of it is left.
func attachAccountUsage(ctx context.Context, provider, account string, v *AccountView) {
	// the channel this account is a key of
	v.KeyIndex = -1
	for _, tag := range []string{TagFor(provider, ""), TagFor(provider, account)} {
		existing, err := model.GetChannelsByTag(tag, true, true)
		if err != nil || len(existing) == 0 {
			continue
		}
		ch := existing[0]
		v.ChannelID = ch.Id
		v.ChannelOn = ch.Status == common.ChannelStatusEnabled
		if ch.ChannelInfo.IsMultiKey {
			for i, key := range ch.GetKeys() {
				if strings.TrimSpace(key) == account {
					v.KeyIndex = i
					// a key with no entry in the status list is enabled
					st, ok := ch.ChannelInfo.MultiKeyStatusList[i]
					v.KeyOn = !ok || st == common.ChannelStatusEnabled
					break
				}
			}
		} else {
			v.KeyOn = ch.Status == common.ChannelStatusEnabled
		}
		break
	}

	u, err := pluginhost.AccountUsage(ctx, provider, account)
	if err != nil {
		v.Error = err.Error()
		return
	}
	v.Plan = u.Plan
	v.SignIn = strings.ToLower(strings.TrimSpace(u.SignIn))
	v.Error = u.Error
	v.NeedsSignIn = v.SignIn == "expired"
	if u.Resets != nil {
		v.Resets = u.Resets.Count
	}
	for _, w := range u.Windows {
		win := QuotaWindowView{
			Name: w.Name, Limit: w.Limit, Amount: w.Amount,
			Display: w.Display, Unit: w.Unit,
			ResetsAt: w.ResetsAt, ResetSecs: w.ResetSecs,
			Span: w.Span, Model: w.Model, Models: w.Models,
			NotModels: w.NotModels, Aside: w.Aside,
			RunsOutAt: w.RunsOutAt, RunsOut: w.RunsOut,
			Balance: w.Balance,
		}
		if w.Used != nil {
			win.Used = *w.Used
		} else if w.Limit > 0 {
			win.Used = w.Amount / w.Limit * 100
		}
		v.Windows = append(v.Windows, win)
	}
}
