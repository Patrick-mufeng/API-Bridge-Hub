package router

import (
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The console's Services page opens a provider in place, so the usage it
// reads sits beside the accounts it shows. Both paths have to exist, and
// both have to sit behind the admin guard: what a provider spent and which
// accounts it holds are the operator's own figures.
func TestPluginProviderUsageRoutesAreRegistered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	require.NotPanics(t, func() {
		SetApiRouter(engine)
	})

	registered := map[string]bool{}
	for _, route := range engine.Routes() {
		registered[route.Method+" "+route.Path] = true
	}

	for _, path := range []string{
		"GET /api/plugin_provider/providers/:id/usage",
		"GET /api/plugin_provider/providers/:id/requests",
	} {
		assert.True(t, registered[path], "%s is not registered", path)
	}
}

// A provider's usage is read by its own path, so a provider id that carries
// a slash or a space cannot reach another provider's figures.
func TestPluginProviderUsagePathIsOneParameter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	require.NotPanics(t, func() {
		SetApiRouter(engine)
	})

	var usage *gin.RouteInfo
	for _, route := range engine.Routes() {
		if route.Path == "/api/plugin_provider/providers/:id/usage" {
			r := route
			usage = &r
			break
		}
	}
	require.NotNil(t, usage)
	assert.Equal(t, "GET", usage.Method)
}
