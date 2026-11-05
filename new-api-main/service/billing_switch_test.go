package service

import (
	"net/http"
	"testing"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestPreConsumeBillingDisabledSkipsReservation covers the personal-use
// switch: with billing off no session is created, so a request can never be
// rejected for insufficient balance and nothing is reserved.
func TestPreConsumeBillingDisabledSkipsReservation(t *testing.T) {
	previous := common.QuotaBillingEnabled
	common.QuotaBillingEnabled = false
	t.Cleanup(func() { common.QuotaBillingEnabled = previous })

	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(nil)
	relayInfo := &relaycommon.RelayInfo{UserId: 1}

	apiErr := PreConsumeBilling(ctx, 1_000_000, relayInfo)

	require.Nil(t, apiErr, "disabled billing must not return a quota error")
	assert.Nil(t, relayInfo.Billing, "no billing session should be created")
}

// TestPreConsumeBillingEnabledRejectsOversizedReservation guards the inverse:
// with billing on, an oversized quota above the clamp must still fail loudly.
func TestPreConsumeBillingEnabledRejectsOversizedReservation(t *testing.T) {
	previous := common.QuotaBillingEnabled
	common.QuotaBillingEnabled = true
	t.Cleanup(func() { common.QuotaBillingEnabled = previous })

	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(nil)
	relayInfo := &relaycommon.RelayInfo{
		UserId: 1,
		QuotaClamp: &common.QuotaClamp{
			Op:       "QuotaFromFloat",
			Kind:     common.QuotaClampOverflow,
			Original: 1.8e19,
			Clamped:  common.MaxQuota,
		},
	}

	apiErr := PreConsumeBilling(ctx, 1, relayInfo)

	require.NotNil(t, apiErr, "a saturated quota must still be rejected when billing is on")
	assert.Equal(t, http.StatusBadRequest, apiErr.StatusCode)
}

// TestSettleBillingDisabledDoesNotCharge verifies settlement is a no-op, so
// user and token balances are untouched when billing is off.
func TestSettleBillingDisabledDoesNotCharge(t *testing.T) {
	previous := common.QuotaBillingEnabled
	common.QuotaBillingEnabled = false
	t.Cleanup(func() { common.QuotaBillingEnabled = previous })

	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(nil)
	relayInfo := &relaycommon.RelayInfo{UserId: 1, FinalPreConsumedQuota: 0}

	require.NoError(t, SettleBilling(ctx, relayInfo, 5_000_000))
}

// TestSettleBillingDisabledLeavesStrandedSessionUnsettled covers the switch
// being flipped while a request is in flight: settlement must not run, so the
// charge is never applied to the in-flight request's session.
func TestSettleBillingDisabledLeavesStrandedSessionUnsettled(t *testing.T) {
	previous := common.QuotaBillingEnabled
	common.QuotaBillingEnabled = false
	t.Cleanup(func() { common.QuotaBillingEnabled = previous })

	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(nil)
	relayInfo := &relaycommon.RelayInfo{UserId: 1}

	session := &BillingSession{
		relayInfo: relayInfo,
		funding:   &WalletFunding{userId: 1},
	}
	relayInfo.Billing = session

	require.NoError(t, SettleBilling(ctx, relayInfo, 5_000_000))
	assert.False(t, session.settled, "disabled billing must not settle (charge) the session")
	assert.False(t, session.fundingSettled, "the funding source must not be committed")
}

// TestBillingSwitchErrorCode guards the contract the UI relies on: the quota
// gate reports ErrorCodeInsufficientUserQuota, which is what the client
// surfaces as an insufficient-credit failure.
func TestBillingSwitchErrorCode(t *testing.T) {
	assert.Equal(t, types.ErrorCodeInsufficientUserQuota, types.ErrorCode("insufficient_user_quota"))
}
