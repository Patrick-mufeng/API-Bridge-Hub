package controller

import (
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/pluginhost"
	"github.com/QuantumNous/new-api/service/pluginreg"

	"github.com/gin-gonic/gin"
)

// ListPluginProviders returns every provider the installed plugins serve,
// with what registering one as a channel would make: its accounts, its
// models and whether an account is signed in.
//
// Asking starts the plugins' host when it isn't running, so the console
// calls it on demand rather than on a page load that doesn't need it.
func ListPluginProviders(c *gin.Context) {
	offers, err := pluginreg.Offers(c.Request.Context())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"providers": offers,
		"host":      pluginreg.Host(),
	})
}

// GetPluginProvider returns one provider in full: its accounts, its
// models with prices, its sign-in methods and its switches.
func GetPluginProvider(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		common.ApiErrorMsg(c, "no provider named")
		return
	}
	detail, err := pluginreg.ProviderDetail(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, detail)
}

// RegisterPluginProvider makes (or refreshes) the channels for a plugin
// provider: one channel per account.
func RegisterPluginProvider(c *gin.Context) {
	var in struct {
		Provider    string   `json:"provider"`
		Accounts    []string `json:"accounts"`
		ModelPrefix string   `json:"model_prefix"`
		Group       string   `json:"group"`
		Name        string   `json:"name"`
		// PerAccount makes a channel per account instead of one that pools
		// them. The pool is the default: the plugin rotates its accounts
		// already, so a row each is the same list written twice.
		PerAccount bool `json:"per_account"`
		// AllowClash registers over another channel's model names. Off by
		// default: two channels answering one model id makes routing pick
		// between two vendors for one name.
		AllowClash bool `json:"allow_clash"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	result, err := pluginreg.Register(c.Request.Context(), pluginreg.Options{
		Provider:    in.Provider,
		Accounts:    in.Accounts,
		ModelPrefix: in.ModelPrefix,
		Group:       in.Group,
		Name:        in.Name,
		PerAccount:  in.PerAccount,
		AllowClash:  in.AllowClash,
	})
	if err != nil {
		common.ApiErrorMsg(c, skipMessage(result, err.Error()))
		return
	}
	common.ApiSuccess(c, result)
}

func skipMessage(r *pluginreg.Result, fallback string) string {
	if r == nil || len(r.Skipped) == 0 {
		return fallback
	}
	msg := ""
	for i, s := range r.Skipped {
		if i > 0 {
			msg += "; "
		}
		msg += s
	}
	return msg
}

// SyncPluginHealth asks each plugin what it says of each account's
// sign-in, and turns a channel off when its account lapsed.
func SyncPluginHealth(c *gin.Context) {
	provider := c.Query("provider")
	list, err := pluginreg.SyncHealth(c.Request.Context(), provider)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"accounts": list,
		"summary":  pluginreg.DescribeHealth(list),
	})
}

// GetPluginCheckinOptions returns whether the daily check-in runs by itself,
// when, and how it last went.
func GetPluginCheckinOptions(c *gin.Context) {
	common.ApiSuccess(c, gin.H{
		"settings": pluginreg.CheckinOptions(),
		"history":  pluginreg.CheckinHistory(),
	})
}

// SetPluginCheckinOptions turns the daily check-in on or off and sets its hour.
func SetPluginCheckinOptions(c *gin.Context) {
	var in struct {
		Auto *bool `json:"auto"`
		At   *int  `json:"at"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, pluginreg.SetCheckinOptions(in.Auto, in.At))
}

// RunPluginCheckin presses the daily check-in now, for every account that
// has not been pressed today.
func RunPluginCheckin(c *gin.Context) {
	result := pluginreg.RunAutoCheckin(c.Request.Context())
	if result == nil {
		common.ApiErrorMsg(c, "the daily check-in could not run")
		return
	}
	common.ApiSuccess(c, result)
}

// ListPluginRenewals returns what the last renewals came to.
func ListPluginRenewals(c *gin.Context) {
	common.ApiSuccess(c, gin.H{"renewals": pluginreg.Renewals()})
}

// MigratePluginPrefixes renames the models of every plugin channel to the
// "provider-model" form, keeping the old names as bare aliases. With
// ?dry=1 it reports what it would do and writes nothing.
func MigratePluginPrefixes(c *gin.Context) {
	dry := c.Query("dry") == "1"
	result, err := pluginreg.MigratePrefixes(c.Request.Context(), dry)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

// GetPluginProviderPage returns a provider's own page: its accounts with's own page: its accounts with
// their allowance, the channels it is served by, and whether it has a daily
// check-in to press.
func GetPluginProviderPage(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		common.ApiErrorMsg(c, "no provider named")
		return
	}
	page, err := pluginreg.Page(c.Request.Context(), id)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, page)
}

// CheckinPluginProvider presses the vendor's daily check-in for a provider's
// accounts: the one named, or every one it has signed in.
func CheckinPluginProvider(c *gin.Context) {
	var in struct {
		Provider string `json:"provider"`
		Account  string `json:"account"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	result, err := pluginreg.Checkin(c.Request.Context(), in.Provider, in.Account)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

// GetPluginProviderUsage returns one provider's usage over a period: the
// totals, the trend, and the split by model, account and channel.
//
// The figures are the relay's own, keyed by the provider's channels; the
// console asks for them beside the accounts' allowances, because a
// subscription's remaining quota and what was spent against it are two
// halves of the same question.
func GetPluginProviderUsage(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		common.ApiErrorMsg(c, "no provider named")
		return
	}
	start, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	end, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	if start == 0 && end == 0 {
		now := common.GetTimestamp()
		span := int64(7 * 24 * 3600)
		start, end = now-span, now
	}
	summary, err := pluginreg.Usage(c.Request.Context(), id, start, end, c.Query("granularity"))
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, summary)
}

// GetPluginProviderRequests returns the last requests through a provider,
// newest first: what a page plays as it happens.
func GetPluginProviderRequests(c *gin.Context) {
	id := c.Param("id")
	if id == "" {
		common.ApiErrorMsg(c, "no provider named")
		return
	}
	limit, _ := strconv.Atoi(c.Query("limit"))
	list, err := pluginreg.RecentRequests(id, limit)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"requests": list})
}

// ListPluginRoutes returns every bare model id this hub serves and who
// serves it, highest priority first: the routing an operator configured,
// read back.
func ListPluginRoutes(c *gin.Context) {
	routes, err := pluginreg.BareRoutes()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"routes": routes})
}

// ---- plugins ----

// ListPlugins returns the plugins installed, with their load state.
func ListPlugins(c *gin.Context) {
	plugins, err := pluginreg.Plugins(c.Request.Context())
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"plugins": plugins, "host": pluginreg.Host()})
}

// InstallPlugin adds a plugin from an npm package, a git repository or a
// path.
func InstallPlugin(c *gin.Context) {
	var in struct {
		Spec string `json:"spec"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	view, err := pluginreg.Install(c.Request.Context(), in.Spec)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, view)
}

// UninstallPlugin takes a plugin out, and its sign-ins with it.
func UninstallPlugin(c *gin.Context) {
	spec := c.Query("spec")
	if spec == "" {
		common.ApiErrorMsg(c, "no plugin named")
		return
	}
	if err := pluginreg.Uninstall(c.Request.Context(), spec); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

// SetPluginOff turns one plugin off or on.
func SetPluginOff(c *gin.Context) {
	spec := c.Query("spec")
	if spec == "" {
		common.ApiErrorMsg(c, "no plugin named")
		return
	}
	var in struct {
		Off bool `json:"off"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := pluginreg.SetOff(spec, in.Off); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

// UpgradePlugin updates one plugin, or every one when none is named.
func UpgradePlugin(c *gin.Context) {
	var in struct {
		Spec string `json:"spec"`
	}
	_ = c.ShouldBindJSON(&in)
	spec := strings.TrimSpace(in.Spec)
	if spec != "" {
		if err := pluginreg.UpgradeOne(c.Request.Context(), spec); err != nil {
			common.ApiError(c, err)
			return
		}
		common.ApiSuccess(c, nil)
		return
	}
	if err := pluginreg.UpdateInstalled(c.Request.Context()); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

// ListPluginMarket returns the community's plugin list.
func ListPluginMarket(c *gin.Context) {
	common.ApiSuccess(c, gin.H{"plugins": pluginreg.Market(c.Request.Context())})
}

// SearchPluginMarket asks npm for plugins matching a word.
func SearchPluginMarket(c *gin.Context) {
	q := c.Query("q")
	hits, err := pluginreg.MarketSearch(c.Request.Context(), q)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"plugins": hits})
}

// ---- host ----

// GetPluginHost returns the host's own state and settings.
func GetPluginHost(c *gin.Context) {
	common.ApiSuccess(c, pluginreg.Host())
}

// UpdatePluginHost changes the host's settings: whether it runs, the npm
// registry, and the China mirror switch.
func UpdatePluginHost(c *gin.Context) {
	var in struct {
		Enabled     *bool   `json:"enabled"`
		NPMRegistry *string `json:"npm_registry"`
		ChinaMirror *bool   `json:"china_mirror"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := pluginreg.SetHost(in.Enabled, in.NPMRegistry, in.ChinaMirror); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, pluginreg.Host())
}

// ---- sign-in ----

// StartPluginSignIn begins a sign-in, or asks the method's next question.
func StartPluginSignIn(c *gin.Context) {
	var in struct {
		Provider string            `json:"provider"`
		Method   int               `json:"method"`
		Inputs   map[string]string `json:"inputs"`
		Account  string            `json:"account"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	out, err := pluginreg.SignIn(c.Request.Context(), in.Provider, in.Method, in.Inputs, in.Account)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, out)
}

// PluginSignInKey signs in with an API key.
func PluginSignInKey(c *gin.Context) {
	var in struct {
		Provider string            `json:"provider"`
		Method   int               `json:"method"`
		Inputs   map[string]string `json:"inputs"`
		Key      string            `json:"key"`
		Account  string            `json:"account"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	acc, err := pluginreg.SignInKey(c.Request.Context(), in.Provider, in.Method, in.Inputs, in.Key, in.Account)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, acc)
}

// PollPluginSignIn asks whether an OAuth sign-in has finished. done is
// false while it waits; the console polls this while the page is open.
func PollPluginSignIn(c *gin.Context) {
	var in struct {
		Provider string `json:"provider"`
		Session  string `json:"session"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	acc, done, err := pluginreg.SignInFinish(c.Request.Context(), in.Provider, in.Session)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"done": done, "account": acc})
}

// SignOutPluginAccount takes one account out: its place in every channel
// that serves it, and then the plugin's own record of its sign-in.
//
// Both, because an account lives in both: a key left in a channel points at a
// sign-in nobody can renew, and a sign-in no channel uses is a count the
// console shows but nothing can reach.
func SignOutPluginAccount(c *gin.Context) {
	var in struct {
		Provider string `json:"provider"`
		Account  string `json:"account"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	result, err := pluginreg.RemoveAccount(c.Request.Context(), in.Provider, in.Account)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, result)
}

// SetPluginProviderOption keeps one provider switch, such as WorkBuddy's
// "free models only".
func SetPluginProviderOption(c *gin.Context) {
	var in struct {
		Provider string `json:"provider"`
		Key      string `json:"key"`
		On       bool   `json:"on"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		common.ApiError(c, err)
		return
	}
	if err := pluginhostSetOption(in.Provider, in.Key, in.On); err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, nil)
}

// pluginhostSetOption keeps one provider switch and tells a running host.
func pluginhostSetOption(provider, key string, on bool) error {
	return pluginhost.SetChosenOption(provider, key, on)
}
