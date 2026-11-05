package service

import (
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/i18n"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/QuantumNous/new-api/setting/operation_setting"
)

func formatNotifyType(channelId int, status int) string {
	return fmt.Sprintf("%s_%d_%d", dto.NotifyTypeChannelUpdate, channelId, status)
}

func shouldCloseActiveWebSocketsAfterDisable(channelId int) bool {
	channel, err := model.GetChannelById(channelId, true)
	if err != nil {
		common.SysLog(common.LogText("failed to check channel status before closing active websockets: channel_id=%d, error=%v", channelId, err))
		return true
	}
	return channel.Status != common.ChannelStatusEnabled
}

// RootUserLanguage returns the saved language of the root user, who receives
// channel notices; it is empty when the root user saved none.
func RootUserLanguage() string {
	root := model.GetRootUser()
	if root == nil {
		return ""
	}
	return root.GetSetting().Language
}

// RestChannelKey rests one key of a pooled channel instead of switching it
// off, for a failure that passes: a 429, a 5xx. It reports whether the key was
// rested, so the caller can tell "handled" from "this needs a disable".
//
// Only a pooled channel has keys to rest; a one-key channel is a channel, and
// DisableChannel is what a repeated failure there means.
func RestChannelKey(channelId int, key string, status int, reason string) bool {
	if channelId == 0 || key == "" {
		return false
	}
	d := model.CooldownForStatus(status)
	if d <= 0 {
		return false
	}
	ch, err := model.GetChannelById(channelId, true)
	if err != nil || ch == nil || !ch.ChannelInfo.IsMultiKey {
		return false
	}
	if !ch.RestMultiKey(key, d, reason) {
		return false
	}
	if err := ch.SaveChannelInfo(); err != nil {
		common.SysLog(common.LogText("failed to save the rest of a key of channel #%d: %v", channelId, err))
		return false
	}
	common.SysLog(common.LogText("channel #%d key rested for %s: %s", channelId, d, common.LocalLogPreview(reason)))
	return true
}

// ClearChannelKeyRest brings a key back as soon as it serves a request.
func ClearChannelKeyRest(channelId int, key string) {
	if channelId == 0 || key == "" {
		return
	}
	ch, err := model.GetChannelById(channelId, true)
	if err != nil || ch == nil {
		return
	}
	if ch.ClearMultiKeyRest(key) {
		if err := ch.SaveChannelInfo(); err != nil {
			common.SysLog(common.LogText("failed to clear the rest of a key of channel #%d: %v", channelId, err))
		}
	}
}

// disable & notify
func DisableChannel(channelError types.ChannelError, reason string) {
	common.SysLog(common.LogText("channel %q (#%d) failed, disabling it, reason: %s", channelError.ChannelName, channelError.ChannelId, common.LocalLogPreview(reason)))

	// 检查是否启用自动禁用功能
	if !channelError.AutoBan {
		common.SysLog(common.LogText("channel %q (#%d) has automatic disabling turned off, skipping", channelError.ChannelName, channelError.ChannelId))
		return
	}

	success := model.UpdateChannelStatus(channelError.ChannelId, channelError.UsingKey, common.ChannelStatusAutoDisabled, reason)
	if success {
		if shouldCloseActiveWebSocketsAfterDisable(channelError.ChannelId) {
			CloseActiveWebSocketsForChannel(channelError.ChannelId, ChannelDisabledCloseReason)
		}
		lang := RootUserLanguage()
		params := map[string]any{"Name": channelError.ChannelName, "Id": channelError.ChannelId, "Reason": reason}
		subject := i18n.Translate(lang, i18n.MsgChannelNotifyDisabledSubject, params)
		content := i18n.Translate(lang, i18n.MsgChannelNotifyDisabledContent, params)
		NotifyRootUser(formatNotifyType(channelError.ChannelId, common.ChannelStatusAutoDisabled), subject, content)
	}
}

func EnableChannel(channelId int, usingKey string, channelName string) {
	success := model.UpdateChannelStatus(channelId, usingKey, common.ChannelStatusEnabled, "")
	if success {
		lang := RootUserLanguage()
		params := map[string]any{"Name": channelName, "Id": channelId}
		subject := i18n.Translate(lang, i18n.MsgChannelNotifyEnabledSubject, params)
		content := i18n.Translate(lang, i18n.MsgChannelNotifyEnabledContent, params)
		NotifyRootUser(formatNotifyType(channelId, common.ChannelStatusEnabled), subject, content)
	}
}

func ShouldDisableChannel(err *types.NewAPIError) bool {
	if !common.AutomaticDisableChannelEnabled {
		return false
	}
	if err == nil {
		return false
	}
	if types.IsChannelError(err) {
		return true
	}
	if types.IsSkipRetryError(err) {
		return false
	}
	if operation_setting.ShouldDisableByStatusCode(err.StatusCode) {
		return true
	}

	lowerMessage := strings.ToLower(err.Error())
	search, _ := AcSearch(lowerMessage, operation_setting.AutomaticDisableKeywords, true)
	return search
}

func ShouldEnableChannel(newAPIError *types.NewAPIError, status int) bool {
	if !common.AutomaticEnableChannelEnabled {
		return false
	}
	if newAPIError != nil {
		return false
	}
	if status != common.ChannelStatusAutoDisabled {
		return false
	}
	return true
}
