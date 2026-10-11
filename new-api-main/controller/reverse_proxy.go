package controller

import (
	"fmt"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/service/reverse_proxy"
	"github.com/gin-gonic/gin"
)

// ListReverseProxyServices returns every managed service with its runtime
// state, key status and bound relay channel.
func ListReverseProxyServices(c *gin.Context) {
	manager := reverse_proxy.GetManager()
	manager.Load(false)
	common.ApiSuccess(c, gin.H{
		"hub_root":     manager.HubRoot(),
		"services_dir": manager.ServicesDir(),
		"load_errors":  manager.LoadErrors(),
		"services":     manager.ListViews(),
	})
}

// ReloadReverseProxyServices re-reads all manifests from disk. This is the
// hot-plug entry point for adding or editing services.
func ReloadReverseProxyServices(c *gin.Context) {
	manager := reverse_proxy.GetManager()
	manager.Reload()
	common.ApiSuccess(c, gin.H{
		"load_errors": manager.LoadErrors(),
		"services":    manager.ListViews(),
	})
}

func reverseProxyServiceParam(c *gin.Context) (string, bool) {
	id := c.Param("id")
	if id == "" {
		common.ApiErrorMsg(c, "service id is required")
		return "", false
	}
	return id, true
}

func respondWithServiceView(c *gin.Context, id string) {
	manager := reverse_proxy.GetManager()
	service, ok := manager.Get(id)
	if !ok {
		common.ApiSuccess(c, gin.H{})
		return
	}
	common.ApiSuccess(c, manager.ViewOf(service))
}

func StartReverseProxyService(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	if _, err := reverse_proxy.GetManager().Start(id); err != nil {
		common.ApiError(c, err)
		return
	}
	respondWithServiceView(c, id)
}

func StopReverseProxyService(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	if err := reverse_proxy.GetManager().Stop(id); err != nil {
		common.ApiError(c, err)
		return
	}
	respondWithServiceView(c, id)
}

func RestartReverseProxyService(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	if _, err := reverse_proxy.GetManager().Restart(id); err != nil {
		common.ApiError(c, err)
		return
	}
	respondWithServiceView(c, id)
}

func BuildReverseProxyService(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	manager := reverse_proxy.GetManager()
	output, err := manager.Build(id)
	if err != nil {
		common.ApiError(c, fmt.Errorf("%w\n%s", err, output))
		return
	}
	service, ok := manager.Get(id)
	if !ok {
		common.ApiErrorMsg(c, fmt.Sprintf("service %q not found", id))
		return
	}
	view := manager.ViewOf(service)
	common.ApiSuccess(c, gin.H{"service": view, "output": output})
}

// RegisterReverseProxyChannel creates or updates the relay channel that points
// at this service and syncs its model list.
func RegisterReverseProxyChannel(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	manager := reverse_proxy.GetManager()
	service, ok := manager.Get(id)
	if !ok {
		common.ApiErrorMsg(c, fmt.Sprintf("service %q not found", id))
		return
	}
	channel, models, err := manager.RegisterChannel(service)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{
		"channel": channel,
		"models":  models,
		"service": manager.ViewOf(service),
	})
}

// ReverseProxyServiceLogs tails the captured process log of a service.
func ReverseProxyServiceLogs(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	lines := 200
	if raw := c.Query("lines"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			lines = parsed
		}
	}
	log, err := reverse_proxy.GetManager().TailLog(id, lines)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"log": log})
}

// RevealReverseProxyServiceKey returns the service's client API key so an
// operator can paste it into the service's own panel.
func RevealReverseProxyServiceKey(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	service, ok := reverse_proxy.GetManager().Get(id)
	if !ok {
		common.ApiErrorMsg(c, fmt.Sprintf("service %q not found", id))
		return
	}
	key, err := service.ReadKey()
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"key": key})
}

// CreateReverseProxyPanelTicket issues the short-lived cookie that
// authenticates the same-origin panel iframe and returns its entry URL.
func CreateReverseProxyPanelTicket(c *gin.Context) {
	id, ok := reverseProxyServiceParam(c)
	if !ok {
		return
	}
	services := reverse_proxy.GetManager()
	service, ok := services.Get(id)
	if !ok {
		common.ApiErrorMsg(c, fmt.Sprintf("service %q not found", id))
		return
	}
	if service.PanelEmbedPath() == "" {
		common.ApiErrorMsg(c, fmt.Sprintf("service %q has no panel", id))
		return
	}
	token := reverse_proxy.IssuePanelTicket(c.GetInt("id"), id)
	reverse_proxy.SetPanelTicketCookie(c, id, token)
	common.ApiSuccess(c, gin.H{"embed_url": service.PanelEmbedPath()})
}

// ServeReverseProxyPanel proxies a service panel through the relay origin.
func ServeReverseProxyPanel(c *gin.Context) {
	reverse_proxy.GetManager().ServePanel(c)
}
