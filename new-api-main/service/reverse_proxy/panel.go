package reverse_proxy

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/bytedance/gopkg/util/gopool"
	"github.com/gin-gonic/gin"
)

const (
	panelCookieName    = "rp_panel_ticket"
	panelTicketTTL     = 30 * time.Minute
	maxPanelRewriteLen = 8 << 20
	panelJanitorPeriod = 10 * time.Minute
)

type panelTicket struct {
	userID    int
	serviceID string
	expiresAt time.Time
}

var (
	ticketMu    sync.Mutex
	ticketStore = map[string]*panelTicket{}
	ticketOnce  sync.Once
)

func startTicketJanitor() {
	ticketOnce.Do(func() {
		gopool.Go(func() {
			ticker := time.NewTicker(panelJanitorPeriod)
			defer ticker.Stop()
			for range ticker.C {
				now := time.Now()
				ticketMu.Lock()
				for token, ticket := range ticketStore {
					if now.After(ticket.expiresAt) {
						delete(ticketStore, token)
					}
				}
				ticketMu.Unlock()
			}
		})
	})
}

// IssuePanelTicket creates a short-lived, service-scoped ticket that lets the
// browser authenticate the panel iframe, whose navigation requests cannot
// carry the dashboard Authorization header.
func IssuePanelTicket(userID int, serviceID string) string {
	startTicketJanitor()
	token := common.GetRandomString(48)
	ticketMu.Lock()
	ticketStore[token] = &panelTicket{
		userID:    userID,
		serviceID: serviceID,
		expiresAt: time.Now().Add(panelTicketTTL),
	}
	ticketMu.Unlock()
	return token
}

func validatePanelTicket(token, serviceID string) (int, bool) {
	ticketMu.Lock()
	defer ticketMu.Unlock()
	ticket, ok := ticketStore[token]
	if !ok || ticket.serviceID != serviceID || time.Now().After(ticket.expiresAt) {
		return 0, false
	}
	ticket.expiresAt = time.Now().Add(panelTicketTTL)
	return ticket.userID, true
}

// PanelCookiePath is the cookie path scope for one service's panel.
func PanelCookiePath(serviceID string) string {
	return PanelMount(serviceID) + "/"
}

// SetPanelTicketCookie writes the panel ticket cookie for a service.
//
// The cookie has to survive inside an embedded frame: a SameSite=Strict cookie
// is withheld from requests the browser classifies as cross-site, which covers
// the panel iframe once it is embedded, and the panel would load without its
// ticket. Lax keeps same-site requests working while still blocking the cookie
// on cross-site subrequests.
func SetPanelTicketCookie(c *gin.Context, serviceID, token string) {
	secure := c.Request.TLS != nil
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(panelCookieName, token, int(panelTicketTTL/time.Second), PanelCookiePath(serviceID), "", secure, true)
}

func panelFailure(c *gin.Context, status int, message string) {
	c.Header("Content-Type", "text/plain; charset=utf-8")
	c.String(status, "%s", message)
}

// ServePanel proxies a service's own web console under a same-origin path so
// it can be embedded in an iframe: framing headers are stripped, absolute
// panel paths are rebased onto the proxy mount, and panel API calls get the
// service key injected when the browser did not send one.
func (m *Manager) ServePanel(c *gin.Context) {
	id := c.Param("id")
	svc, ok := m.Get(id)
	if !ok {
		panelFailure(c, http.StatusNotFound, fmt.Sprintf("unknown reverse proxy service: %s", id))
		return
	}
	if svc.Manifest.Panel == nil || svc.Manifest.Panel.Path == "" {
		panelFailure(c, http.StatusNotFound, fmt.Sprintf("service %s has no panel", id))
		return
	}
	token, err := c.Cookie(panelCookieName)
	if err != nil || token == "" {
		panelFailure(c, http.StatusForbidden, "panel ticket missing; open the panel from the Reverse Proxy page")
		return
	}
	userID, ok := validatePanelTicket(token, id)
	if !ok {
		panelFailure(c, http.StatusForbidden, "panel ticket expired; reopen the panel from the Reverse Proxy page")
		return
	}
	user, err := model.GetUserCache(userID)
	if err != nil || user == nil || user.Role < common.RoleAdminUser || user.Status != common.UserStatusEnabled {
		panelFailure(c, http.StatusForbidden, "panel access requires an active admin account")
		return
	}

	panel := svc.Manifest.Panel
	target := &url.URL{Scheme: "http", Host: svc.Host() + ":" + strconv.Itoa(svc.Manifest.Port)}
	mount := PanelMount(id)
	upstreamPath := c.Param("path")
	if upstreamPath == "" {
		upstreamPath = "/"
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Director = func(request *http.Request) {
		request.URL.Scheme = target.Scheme
		request.URL.Host = target.Host
		request.URL.Path = upstreamPath
		request.URL.RawPath = ""
		request.Host = target.Host
		request.Header.Del("Cookie")
		request.Header.Del("Authorization")
		if panel.InjectKey && panel.APIPrefix != "" && strings.HasPrefix(upstreamPath, panel.APIPrefix) {
			if key, err := svc.ReadKey(); err == nil && key != "" {
				request.Header.Set("Authorization", "Bearer "+key)
			}
		}
	}
	proxy.ModifyResponse = func(response *http.Response) error {
		if panel.StripFrameHeaders {
			response.Header.Del("X-Frame-Options")
			response.Header.Del("Content-Security-Policy")
		}
		// The panel is proxied under a path that never changes, so without an
		// explicit directive the browser caches it heuristically and keeps
		// serving a stale panel after the service is rebuilt or restarted.
		response.Header.Set("Cache-Control", "no-store, must-revalidate")
		response.Header.Del("ETag")
		response.Header.Del("Last-Modified")
		if panel.InjectKeyScript {
			if key, err := svc.ReadKey(); err == nil && key != "" {
				injectPanelKeyScript(response, key, panel.KeyScriptGlobal)
			}
		}
		return rebasePanelBody(response, mount, svc.RewritePrefixes())
	}
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, err error) {
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		writer.WriteHeader(http.StatusBadGateway)
		_, _ = fmt.Fprintf(writer, "reverse proxy service %s is unreachable: %v", id, err)
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}

// rebasePanelBody rewrites absolute panel paths in HTML/JS/CSS responses so
// they resolve through the same-origin proxy mount.
func rebasePanelBody(response *http.Response, mount string, prefixes []string) error {
	if len(prefixes) == 0 {
		return nil
	}
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if !isRewritableContentType(contentType) {
		return nil
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxPanelRewriteLen+1))
	if err != nil {
		return err
	}
	_ = response.Body.Close()
	for _, prefix := range prefixes {
		if prefix == "" || prefix == "/" {
			continue
		}
		body = bytes.ReplaceAll(body, []byte(`"`+prefix), []byte(`"`+mount+prefix))
		body = bytes.ReplaceAll(body, []byte(`'`+prefix), []byte(`'`+mount+prefix))
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return nil
}

// injectPanelKeyScript adds a script tag exposing the service key to the panel
// page. Panels that read a server-injected global (rather than prompting the
// operator for the key) work without any manual entry.
func injectPanelKeyScript(response *http.Response, key, globalName string) {
	contentType := strings.ToLower(response.Header.Get("Content-Type"))
	if !strings.Contains(contentType, "text/html") {
		return
	}
	if encoding := response.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
		return
	}
	if strings.TrimSpace(globalName) == "" {
		globalName = "__REVERSE_PROXY_PANEL__"
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxPanelRewriteLen+1))
	if err != nil {
		return
	}
	_ = response.Body.Close()
	encoded, err := common.Marshal(map[string]string{"key": key})
	if err != nil {
		response.Body = io.NopCloser(bytes.NewReader(body))
		return
	}
	// JSON escapes the key; undoing "<" keeps the literal safe inside a script
	// element without breaking the injected object.
	script := "<script>window." + globalName + "=" +
		strings.ReplaceAll(string(encoded), "<", `\u003c`) +
		";</script>\n"
	closed := false
	if index := bytes.Index(body, []byte("</head>")); index >= 0 {
		body = append(append(append([]byte{}, body[:index]...), []byte(script)...), body[index:]...)
		closed = true
	}
	if !closed {
		if index := bytes.Index(body, []byte("</body>")); index >= 0 {
			body = append(append(append([]byte{}, body[:index]...), []byte(script)...), body[index:]...)
		} else {
			body = append(body, []byte(script)...)
		}
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
}

func isRewritableContentType(contentType string) bool {
	for _, marker := range []string{"text/html", "text/css", "javascript", "ecmascript"} {
		if strings.Contains(contentType, marker) {
			return true
		}
	}
	return false
}
