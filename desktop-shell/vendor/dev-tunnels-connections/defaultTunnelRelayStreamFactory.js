"use strict";
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultTunnelRelayStreamFactory = void 0;
const sshHelpers_1 = require("./sshHelpers");
/**
 * Default factory for creating streams to a tunnel relay.
 */
class DefaultTunnelRelayStreamFactory {
    async createRelayStream(relayUri, protocols, accessToken, clientConfig, additionalHeaders) {
        if ((0, sshHelpers_1.isNode)()) {
            const stream = await sshHelpers_1.SshHelpers.openConnection(relayUri, protocols, Object.assign(Object.assign({}, additionalHeaders), (accessToken && { Authorization: `tunnel ${accessToken}` })), clientConfig);
            return { stream, protocol: stream.protocol };
        }
        else {
            // Browser WebSocket APIs cannot set auth or custom handshake headers.
            if (accessToken) {
                protocols = [...protocols, accessToken];
            }
            const stream = await sshHelpers_1.SshHelpers.openConnection(relayUri, protocols);
            return { stream, protocol: stream.protocol };
        }
    }
}
exports.DefaultTunnelRelayStreamFactory = DefaultTunnelRelayStreamFactory;
//# sourceMappingURL=defaultTunnelRelayStreamFactory.js.map