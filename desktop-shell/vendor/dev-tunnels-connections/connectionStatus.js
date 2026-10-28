"use strict";
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionStatus = void 0;
/**
 * Tunnel client or host connection status.
 */
var ConnectionStatus;
(function (ConnectionStatus) {
    /**
     * The connection has not started yet. This is the initial status.
     */
    ConnectionStatus["None"] = "none";
    /**
     * Connecting (if changed from None) or reconnecting (if changed from Connected) to the tunnel.
     */
    ConnectionStatus["Connecting"] = "connecting";
    /**
     * Connecting and refreshing the tunnel access token to connect with.
     */
    ConnectionStatus["RefreshingTunnelAccessToken"] = "refreshingTunnelAccessToken";
    /**
     * Connected to the tunnel.
     */
    ConnectionStatus["Connected"] = "connected";
    /**
     * Disconnected from the tunnel and could not reconnect either due to disposal, service down, tunnel deleted, or token expiration. This is the final status.
     */
    ConnectionStatus["Disconnected"] = "disconnected";
    /**
     * @deprecated Use {@link TunnelConnection.refreshingTunnel} instead.
     */
    ConnectionStatus["RefreshingTunnelHostPublicKey"] = "refreshingTunnelHostPublicKey";
})(ConnectionStatus = exports.ConnectionStatus || (exports.ConnectionStatus = {}));
//# sourceMappingURL=connectionStatus.js.map